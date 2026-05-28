/**
 * Persistencia Fase C: flush de métricas de sesión (RAM → reunion_asistencia_ms).
 */

const copresencia = require('./copresencia');

function isAsistenciaPersistenceEnabled() {
  const raw = process.env.ASISTENCIA_PERSISTENCE_ENABLED;
  if (raw == null || String(raw).trim() === '') return false;
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function rowToPlain(row) {
  if (!row) return null;
  const p = typeof row.get === 'function' ? row.get({ plain: true }) : row;
  return {
    reunionId: p.reunionId,
    inicioSesion: p.inicioSesion,
    userId: p.userId,
    teacherPresenceMs: p.teacherPresenceMs,
    copresenceMs: p.copresenceMs,
    umbralMs: p.umbralMs,
    fulfilled: p.fulfilled,
    creadoEn: p.creadoEn,
    actualizadoEn: p.actualizadoEn,
  };
}

function buildSessionPayloadFromRow(row, meta = {}) {
  const p = rowToPlain(row);
  if (!p) return null;
  const inicioIso =
    p.inicioSesion instanceof Date ? p.inicioSesion.toISOString() : String(p.inicioSesion || '');
  const persistedAt =
    p.actualizadoEn instanceof Date ? p.actualizadoEn.toISOString() : String(p.actualizadoEn || '');
  return {
    inicioSesion: inicioIso || null,
    teacherPresenceMs: Number(p.teacherPresenceMs) || 0,
    copresenceMs: Number(p.copresenceMs) || 0,
    umbralMs: Number(p.umbralMs) || 0,
    fulfilled: !!p.fulfilled,
    teacherPresent: false,
    copresenceActive: false,
    source: 'db',
    persistedAt,
    selectedBy: meta.selectedBy || 'db',
    requestedByRole: meta.requestedByRole || null,
    adminView: !!meta.adminView,
    adminOverride: !!meta.adminOverride,
  };
}

function logAudit(entry) {
  console.info('[asistencia-ms-audit]', JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
}

/**
 * Selección admin-aware de una fila persistida para metrics.session.
 */
function selectPersistedSessionMetrics({
  rows,
  docenteUsuarioId,
  requesterId,
  requesterRole,
  asRequester,
}) {
  const list = (rows || []).map(rowToPlain).filter(Boolean);
  if (!list.length) {
    return { session: null, audit: { selectedBy: 'ram', reason: 'no_rows' } };
  }

  const docenteId = docenteUsuarioId != null ? String(docenteUsuarioId) : '';
  const reqId = requesterId != null ? String(requesterId) : '';
  const role = String(requesterRole || '').toLowerCase();
  const isAdmin = role === 'admin';

  const byDocente = docenteId
    ? list.find((r) => String(r.userId) === docenteId)
    : null;
  if (byDocente) {
    const audit = {
      selectedBy: 'docente',
      reason: 'docente_row',
      adminView: isAdmin,
      adminOverride: false,
      actorId: reqId,
      actorRole: role,
    };
    logAudit(audit);
    return { session: buildSessionPayloadFromRow(byDocente, audit), audit };
  }

  if (isAdmin && asRequester && reqId) {
    const byReq = list.find((r) => String(r.userId) === reqId);
    if (byReq) {
      const audit = {
        selectedBy: 'requester',
        reason: 'admin_asRequester',
        adminView: true,
        adminOverride: true,
        actorId: reqId,
        actorRole: role,
      };
      logAudit(audit);
      return { session: buildSessionPayloadFromRow(byReq, audit), audit };
    }
  }

  if (isAdmin && !asRequester) {
    const maxRow = list.reduce((a, b) =>
      (Number(b.copresenceMs) || 0) > (Number(a.copresenceMs) || 0) ? b : a
    );
    const audit = {
      selectedBy: 'max_copresence',
      reason: 'admin_max_copresence_no_docente',
      adminView: true,
      adminOverride: false,
      actorId: reqId,
      actorRole: role,
    };
    logAudit(audit);
    return { session: buildSessionPayloadFromRow(maxRow, audit), audit };
  }

  if (reqId) {
    const byReq = list.find((r) => String(r.userId) === reqId);
    if (byReq) {
      const audit = {
        selectedBy: 'requester',
        reason: 'requester_row',
        adminView: false,
        adminOverride: false,
        actorId: reqId,
        actorRole: role,
      };
      logAudit(audit);
      return { session: buildSessionPayloadFromRow(byReq, audit), audit };
    }
  }

  const maxRow = list.reduce((a, b) =>
    (Number(b.copresenceMs) || 0) > (Number(a.copresenceMs) || 0) ? b : a
  );
  const audit = {
    selectedBy: 'max_copresence',
    reason: 'fallback_max_copresence',
    adminView: false,
    adminOverride: false,
    actorId: reqId,
    actorRole: role,
  };
  logAudit(audit);
  return { session: buildSessionPayloadFromRow(maxRow, audit), audit };
}

/**
 * @param {string} reunionId
 * @param {Date|string} inicioSesion
 * @param {{ actorId?: string, actorRole?: string, trigger?: string }} meta
 */
async function flushSessionMetrics(reunionId, inicioSesion, meta = {}) {
  if (!isAsistenciaPersistenceEnabled()) {
    return { flushed: false, count: 0, reason: 'persistence_disabled' };
  }

  const { ReunionAsistencia, ReunionAsistenciaMs } = require('../models');
  const inicioN = copresencia.normalizeInicioSesion(inicioSesion);
  if (!inicioN) {
    return { flushed: false, count: 0, reason: 'invalid_inicio_sesion' };
  }

  const snap = copresencia.getSessionSnapshot(reunionId, inicioN);
  const teacherPresenceMs = snap?.teacherPresenceMs ?? 0;
  const copresenceMs = snap?.copresenceMs ?? snap?.acumuladoMs ?? 0;
  const umbralMs = snap?.umbralMs ?? copresencia.getUmbralMs();
  const fulfilled = !!snap?.fulfilled;

  const asistenciaRows = await ReunionAsistencia.findAll({
    where: { reunionId: String(reunionId), inicioSesion: inicioN },
  });

  const targets = asistenciaRows.filter((r) => r.entradaAt != null);
  let count = 0;
  const errors = [];

  for (const row of targets) {
    try {
      await ReunionAsistenciaMs.upsertSessionMetrics({
        reunionId: String(reunionId),
        inicioSesion: inicioN,
        userId: String(row.usuarioId),
        teacherPresenceMs,
        copresenceMs,
        umbralMs,
        fulfilled,
      });
      count += 1;
    } catch (e) {
      errors.push({ userId: row.usuarioId, message: e?.message || String(e) });
    }
  }

  const logEntry = {
    event: 'flushSessionMetrics',
    reunionId: String(reunionId),
    inicioSesion: inicioN.toISOString(),
    actorId: meta.actorId || 'system',
    actorRole: meta.actorRole || 'system',
    trigger: meta.trigger || 'flushSessionMetrics',
    rowsWritten: count,
    teacherPresenceMs,
    copresenceMs,
    umbralMs,
    fulfilled,
    errorCount: errors.length,
  };
  console.info('[flushSessionMetrics]', JSON.stringify(logEntry));

  return {
    flushed: count > 0,
    count,
    errors: errors.length ? errors : undefined,
    ...logEntry,
  };
}

async function loadPersistedRowsForSession(reunionId, inicioSesion) {
  if (!isAsistenciaPersistenceEnabled()) return [];
  const { ReunionAsistenciaMs } = require('../models');
  const inicioN = copresencia.normalizeInicioSesion(inicioSesion);
  if (!inicioN) return [];
  return ReunionAsistenciaMs.findAllForSession(String(reunionId), inicioN);
}

module.exports = {
  isAsistenciaPersistenceEnabled,
  flushSessionMetrics,
  selectPersistedSessionMetrics,
  loadPersistedRowsForSession,
  buildSessionPayloadFromRow,
  rowToPlain,
};
