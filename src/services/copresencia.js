/**
 * Copresencia: acumulación en memoria del tiempo con ≥1 docente y ≥1 estudiante en la misma
 * `(reunionId, inicioSesion)`; persistencia de `asistio` vía `calcularCopresencia`.
 *
 * - `ASISTENCIA_COPRESENCIA_MS_MIN`: umbral en ms (p. ej. 3600000 = 60 min; 30000 = 30 s en pruebas).
 * - `ASISTENCIA_LIVE_ENABLED`: emisiones `attendance:*` y flush anticipado al umbral (ver socket).
 * - `room:join` / `room:leave` (socket) y `asistencia.js` (API) notifican aquí; no duplicar reglas fuera de este módulo.
 */

const { ReunionAsistencia, Participa } = require('../models');

function isAsistenciaLiveEnabled() {
  const raw = process.env.ASISTENCIA_LIVE_ENABLED;
  if (raw == null || String(raw).trim() === '') return false;
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function normalizeInicioSesion(d) {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(Math.floor(t.getTime() / 1000) * 1000);
}

/** Instantáneo de sesión para copresencia a partir de la fila reunión (ancla de agenda). */
function inicioSesionDesdeReunion(reunion) {
  if (!reunion?.fechaHora) return null;
  return normalizeInicioSesion(new Date(reunion.fechaHora));
}

/**
 * Rol en la reunión para bucket docente/estudiante en copresencia.
 * @param {string} reunionId
 * @param {string} usuarioId
 * @returns {Promise<'docente'|'estudiante'>}
 */
async function resolveRolCopresencia(reunionId, usuarioId) {
  const p = await Participa.findOne({ where: { reunionId, usuarioId } });
  if (p?.rolEnReunion === 'docente') return 'docente';
  return 'estudiante';
}

function sessionKey(reunionId, inicioSesion) {
  const n = normalizeInicioSesion(inicioSesion);
  if (!n) return null;
  return `${String(reunionId)}::${n.toISOString()}`;
}

function hasCopresence(presentes) {
  let doc = 0;
  let est = 0;
  for (const tipo of presentes.values()) {
    if (tipo === 'docente') doc += 1;
    else est += 1;
  }
  return doc >= 1 && est >= 1;
}

function hasTeacherPresent(presentes) {
  for (const tipo of presentes.values()) {
    if (tipo === 'docente') return true;
  }
  return false;
}

/** @type {Map<string, { reunionId: string, inicioSesion: Date, presentes: Map<string, 'docente'|'estudiante'>, accumulatedMs: number, currentStart: number|null, teacherAccumulatedMs: number, teacherCurrentStart: number|null, fulfilledNotified: boolean }>} */
const sessions = new Map();

function getOrCreate(reunionId, inicioSesion) {
  const key = sessionKey(reunionId, inicioSesion);
  if (!key) return null;
  if (!sessions.has(key)) {
    sessions.set(key, {
      reunionId: String(reunionId),
      inicioSesion: normalizeInicioSesion(inicioSesion),
      presentes: new Map(),
      accumulatedMs: 0,
      currentStart: null,
      teacherAccumulatedMs: 0,
      teacherCurrentStart: null,
      fulfilledNotified: false,
    });
  }
  return sessions.get(key);
}

function tickState(s, nowMs) {
  const pair = hasCopresence(s.presentes);
  if (pair && s.currentStart == null) {
    s.currentStart = nowMs;
  } else if (!pair && s.currentStart != null) {
    s.accumulatedMs += nowMs - s.currentStart;
    s.currentStart = null;
  }
}

function ensureTeacherFields(s) {
  if (s.teacherAccumulatedMs == null) s.teacherAccumulatedMs = 0;
  if (s.teacherCurrentStart === undefined) s.teacherCurrentStart = null;
}

function tickTeacherState(s, nowMs) {
  ensureTeacherFields(s);
  const teacher = hasTeacherPresent(s.presentes);
  if (teacher && s.teacherCurrentStart == null) {
    s.teacherCurrentStart = nowMs;
  } else if (!teacher && s.teacherCurrentStart != null) {
    s.teacherAccumulatedMs += nowMs - s.teacherCurrentStart;
    s.teacherCurrentStart = null;
  }
}

function tickSessionStates(s, nowMs) {
  tickState(s, nowMs);
  tickTeacherState(s, nowMs);
}

function getUmbralMs(umbralExplicito) {
  if (umbralExplicito != null && Number.isFinite(umbralExplicito) && umbralExplicito > 0) {
    return umbralExplicito;
  }
  const raw = process.env.ASISTENCIA_COPRESENCIA_MS_MIN;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3600000;
}

/**
 * Snapshot de solo lectura para asistencia en vivo (RAM).
 * @returns {object|null}
 */
function getSessionSnapshot(reunionId, inicioSesion) {
  const key = sessionKey(reunionId, inicioSesion);
  if (!key) return null;
  const s = sessions.get(key);
  const nowMs = Date.now();
  const umbralMs = getUmbralMs();
  if (!s) {
    const inicioN = normalizeInicioSesion(inicioSesion);
    return {
      reunionId: String(reunionId),
      inicioSesion: inicioN ? inicioN.toISOString() : null,
      docenteCount: 0,
      estudianteCount: 0,
      teacherPresent: false,
      studentPresent: false,
      copresenceActive: false,
      sessionActive: false,
      acumuladoMs: 0,
      copresenceMs: 0,
      teacherPresenceMs: 0,
      umbralMs,
      fulfilled: false,
      participants: [],
    };
  }
  let docenteCount = 0;
  let estudianteCount = 0;
  const participants = [];
  for (const [uid, tipo] of s.presentes) {
    if (tipo === 'docente') docenteCount += 1;
    else estudianteCount += 1;
    participants.push({ userId: uid, role: tipo });
  }
  const acumuladoMs = snapshotAcumuladoMs(s, nowMs);
  const teacherPresenceMs = snapshotTeacherPresenceMs(s, nowMs);
  return {
    reunionId: String(reunionId),
    inicioSesion: s.inicioSesion.toISOString(),
    docenteCount,
    estudianteCount,
    teacherPresent: docenteCount >= 1,
    studentPresent: estudianteCount >= 1,
    copresenceActive: hasCopresence(s.presentes),
    sessionActive: s.presentes.size > 0,
    acumuladoMs,
    copresenceMs: acumuladoMs,
    teacherPresenceMs,
    umbralMs,
    fulfilled: !!s.fulfilledNotified || acumuladoMs >= umbralMs,
    participants,
  };
}

/**
 * @param {string} usuarioId
 * @param {string} reunionId
 * @param {Date|string} inicioSesion
 * @param {'docente'|'estudiante'} rol — bucket copresencia (docente vs estudiante)
 */
function registrarEntrada(usuarioId, reunionId, inicioSesion, rol) {
  const s = getOrCreate(reunionId, inicioSesion);
  if (!s) return;
  const tipo = rol === 'docente' ? 'docente' : 'estudiante';
  s.presentes.set(String(usuarioId), tipo);
  tickSessionStates(s, Date.now());
}

/**
 * @param {string} usuarioId
 * @param {string} reunionId
 * @param {Date|string} inicioSesion
 */
function registrarSalida(usuarioId, reunionId, inicioSesion) {
  const key = sessionKey(reunionId, inicioSesion);
  if (!key) return;
  const s = sessions.get(key);
  if (!s) return;
  const nowMs = Date.now();
  tickSessionStates(s, nowMs);
  s.presentes.delete(String(usuarioId));
  tickSessionStates(s, nowMs);
}

function snapshotAcumuladoMs(s, nowMs) {
  if (!s) return 0;
  return s.accumulatedMs + (s.currentStart != null ? nowMs - s.currentStart : 0);
}

function snapshotTeacherPresenceMs(s, nowMs) {
  if (!s) return 0;
  ensureTeacherFields(s);
  return s.teacherAccumulatedMs + (s.teacherCurrentStart != null ? nowMs - s.teacherCurrentStart : 0);
}

function getTeacherPresenceMs(reunionId, inicioSesion) {
  const key = sessionKey(reunionId, inicioSesion);
  if (!key) return 0;
  const s = sessions.get(key);
  return snapshotTeacherPresenceMs(s, Date.now());
}

function getCopresenceMs(reunionId, inicioSesion) {
  const key = sessionKey(reunionId, inicioSesion);
  if (!key) return 0;
  const s = sessions.get(key);
  return snapshotAcumuladoMs(s, Date.now());
}

function esEstudianteParticipacion(rolEnReunion) {
  const r = String(rolEnReunion || '').toLowerCase();
  return r === 'estudiante' || r === 'asistente';
}

/**
 * Calcula tiempo de copresencia acumulado, actualiza asistio en BD según umbral y participación.
 * @returns {Promise<{ acumuladoMs: number, umbralMs: number, asistida: boolean, aplicado?: boolean }>}
 */
async function calcularCopresencia(reunionId, inicioSesion, umbralMs) {
  const key = sessionKey(reunionId, inicioSesion);
  const nowMs = Date.now();
  const umbral = getUmbralMs(umbralMs);
  const inicioN = normalizeInicioSesion(inicioSesion);
  if (!inicioN || !key) {
    return { acumuladoMs: 0, umbralMs: umbral, asistida: false, aplicado: false };
  }
  const s = sessions.get(key);
  if (!s) {
    return { acumuladoMs: 0, umbralMs: umbral, asistida: false, aplicado: false };
  }
  tickSessionStates(s, nowMs);
  const totalMs = snapshotAcumuladoMs(s, nowMs);
  const asistida = totalMs >= umbral;

  const rows = await ReunionAsistencia.findAll({
    where: { reunionId, inicioSesion: inicioN },
  });

  for (const row of rows) {
    const part = await Participa.findOne({
      where: { reunionId, usuarioId: row.usuarioId },
    });
    const bucketEstudiante = esEstudianteParticipacion(part?.rolEnReunion);
    if (bucketEstudiante) {
      row.asistio = !!(row.entradaAt && asistida);
    } else {
      row.asistio = !!row.entradaAt;
    }
    await row.save();
  }

  if (asistida) s.fulfilledNotified = true;

  const result = { acumuladoMs: totalMs, umbralMs: umbral, asistida, aplicado: true };

  try {
    const persist = require('./asistenciaMsPersistencia');
    if (persist.isAsistenciaPersistenceEnabled()) {
      await persist.flushSessionMetrics(reunionId, inicioN, {
        actorId: 'system',
        actorRole: 'calcularCopresencia',
        trigger: 'calcularCopresencia',
      });
    }
  } catch (e) {
    console.warn('[calcularCopresencia] flushSessionMetrics:', e?.message || e);
  }

  return result;
}

/**
 * Flush anticipado al cruzar el umbral (asistencia en vivo). Idempotente por sesión en RAM.
 * @returns {Promise<{ emitted: boolean, reunionId?: string, inicioSesion?: string, asistio?: boolean, acumuladoMs?: number }>}
 */
async function maybeFlushIfThresholdMet(reunionId, inicioSesion) {
  if (!isAsistenciaLiveEnabled()) return { emitted: false };
  const key = sessionKey(reunionId, inicioSesion);
  const inicioN = normalizeInicioSesion(inicioSesion);
  if (!key || !inicioN) return { emitted: false };
  const s = sessions.get(key);
  if (!s || s.fulfilledNotified) return { emitted: false };
  const totalMs = snapshotAcumuladoMs(s, Date.now());
  const umbral = getUmbralMs();
  if (totalMs < umbral) return { emitted: false };
  const result = await calcularCopresencia(reunionId, inicioSesion, umbral);
  if (!result.asistida) return { emitted: false };
  return {
    emitted: true,
    reunionId: String(reunionId),
    inicioSesion: inicioN.toISOString(),
    asistio: true,
    acumuladoMs: result.acumuladoMs,
  };
}

function attendanceWatchRoom(reunionId) {
  return `attendance-watch:${String(reunionId)}`;
}

module.exports = {
  normalizeInicioSesion,
  inicioSesionDesdeReunion,
  resolveRolCopresencia,
  registrarEntrada,
  registrarSalida,
  calcularCopresencia,
  getUmbralMs,
  isAsistenciaLiveEnabled,
  getSessionSnapshot,
  getTeacherPresenceMs,
  getCopresenceMs,
  maybeFlushIfThresholdMet,
  attendanceWatchRoom,
};
