/**
 * Copresencia: acumulación en memoria del tiempo con ≥1 docente y ≥1 estudiante en la misma
 * `(reunionId, inicioSesion)`; persistencia de `asistio` vía `calcularCopresencia`.
 *
 * - `ASISTENCIA_COPRESENCIA_MS_MIN`: umbral en ms (p. ej. 3600000 = 60 min; 30000 = 30 s en pruebas).
 * - `room:join` / `room:leave` (socket) y `asistencia.js` (API) notifican aquí; no duplicar reglas fuera de este módulo.
 */

const { ReunionAsistencia, Participa } = require('../models');

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

/** @type {Map<string, { reunionId: string, inicioSesion: Date, presentes: Map<string, 'docente'|'estudiante'>, accumulatedMs: number, currentStart: number|null }>} */
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
  tickState(s, Date.now());
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
  tickState(s, nowMs);
  s.presentes.delete(String(usuarioId));
  tickState(s, Date.now());
}

function snapshotAcumuladoMs(s, nowMs) {
  if (!s) return 0;
  return s.accumulatedMs + (s.currentStart != null ? nowMs - s.currentStart : 0);
}

function esEstudianteParticipacion(rolEnReunion) {
  const r = String(rolEnReunion || '').toLowerCase();
  return r === 'estudiante' || r === 'asistente';
}

/**
 * Calcula tiempo de copresencia acumulado, actualiza asistio en BD según umbral y participación.
 * @returns {Promise<{ acumuladoMs: number, umbralMs: number, asistida: boolean }>}
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

  return { acumuladoMs: totalMs, umbralMs: umbral, asistida, aplicado: true };
}

module.exports = {
  normalizeInicioSesion,
  inicioSesionDesdeReunion,
  resolveRolCopresencia,
  registrarEntrada,
  registrarSalida,
  calcularCopresencia,
  getUmbralMs,
};
