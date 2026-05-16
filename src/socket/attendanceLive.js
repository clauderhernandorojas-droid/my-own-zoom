/**
 * Emisión Socket.IO de asistencia en vivo (`attendance:*`).
 * Depende de copresencia.js; no duplica reglas de acumulación.
 */

const copresencia = require('../services/copresencia');

/** roomId canónico → intervalId */
const copresenceTimers = new Map();

const COPRESENCE_EMIT_MS = 8000;

function buildPresencePayload(roomId, reunionId, inicioSesion) {
  const snap = copresencia.getSessionSnapshot(reunionId, inicioSesion);
  if (!snap) return null;
  return {
    roomId,
    reunionId: String(reunionId),
    inicioSesion: snap.inicioSesion,
    teacherPresent: snap.teacherPresent,
    studentPresent: snap.studentPresent,
    copresenceActive: snap.copresenceActive,
    sessionActive: snap.sessionActive,
    docenteCount: snap.docenteCount,
    estudianteCount: snap.estudianteCount,
    participants: snap.participants,
  };
}

function buildCopresencePayload(roomId, reunionId, inicioSesion) {
  const snap = copresencia.getSessionSnapshot(reunionId, inicioSesion);
  if (!snap) return null;
  return {
    roomId,
    reunionId: String(reunionId),
    inicioSesion: snap.inicioSesion,
    acumuladoMs: snap.acumuladoMs,
    umbralMs: snap.umbralMs,
    copresenceActive: snap.copresenceActive,
    fulfilled: snap.fulfilled,
  };
}

function broadcastAttendance(io, reunionId, event, payload) {
  if (!payload) return;
  const watch = copresencia.attendanceWatchRoom(reunionId);
  io.to(watch).emit(event, payload);
  if (payload.roomId) io.to(payload.roomId).emit(event, payload);
}

function emitAttendancePresence(io, roomId, reunionId, inicioSesion) {
  if (!copresencia.isAsistenciaLiveEnabled()) return;
  const payload = buildPresencePayload(roomId, reunionId, inicioSesion);
  broadcastAttendance(io, reunionId, 'attendance:presence', payload);
}

function emitAttendanceCopresence(io, roomId, reunionId, inicioSesion) {
  if (!copresencia.isAsistenciaLiveEnabled()) return;
  const payload = buildCopresencePayload(roomId, reunionId, inicioSesion);
  broadcastAttendance(io, reunionId, 'attendance:copresence', payload);
}

function emitAttendanceFulfilled(io, roomId, reunionId, inicioSesion, extra = {}) {
  if (!copresencia.isAsistenciaLiveEnabled()) return;
  const payload = {
    roomId,
    reunionId: String(reunionId),
    inicioSesion,
    asistio: true,
    ...extra,
  };
  broadcastAttendance(io, reunionId, 'attendance:fulfilled', payload);
}

async function afterAttendancePresenceChange(io, roomId, reunionId, inicioSesion) {
  if (!copresencia.isAsistenciaLiveEnabled() || !inicioSesion) return;
  emitAttendancePresence(io, roomId, reunionId, inicioSesion);
  emitAttendanceCopresence(io, roomId, reunionId, inicioSesion);
  const flush = await copresencia.maybeFlushIfThresholdMet(reunionId, inicioSesion);
  if (flush.emitted) {
    emitAttendanceFulfilled(io, roomId, reunionId, flush.inicioSesion, {
      acumuladoMs: flush.acumuladoMs,
    });
  }
}

function startCopresenceTimer(io, roomId, reunionId, inicioSesion) {
  if (!copresencia.isAsistenciaLiveEnabled()) return;
  const key = String(roomId);
  if (copresenceTimers.has(key)) return;
  const id = setInterval(() => {
    emitAttendanceCopresence(io, roomId, reunionId, inicioSesion);
  }, COPRESENCE_EMIT_MS);
  copresenceTimers.set(key, id);
}

function stopCopresenceTimer(roomId) {
  const key = String(roomId);
  const id = copresenceTimers.get(key);
  if (id) clearInterval(id);
  copresenceTimers.delete(key);
}

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {object} deps
 */
function registerAttendanceLiveHandlers(io, socket, deps) {
  const { usuarioEnReunion, Reunion } = deps;
  const userId = socket.data.userId;

  socket.on('attendance:subscribe', async ({ reunionId } = {}, cb) => {
    try {
      const rid = reunionId != null ? String(reunionId).trim() : '';
      if (!rid) {
        cb?.({ ok: false, error: 'reunionId requerido' });
        return;
      }
      const reunion = await Reunion.findByPk(rid);
      if (!reunion) {
        cb?.({ ok: false, error: 'Reunión no encontrada' });
        return;
      }
      const ok = await usuarioEnReunion(userId, rid);
      if (!ok) {
        cb?.({ ok: false, error: 'No participas en esta reunión' });
        return;
      }
      const watch = copresencia.attendanceWatchRoom(rid);
      socket.join(watch);
      const inicioSesion = copresencia.inicioSesionDesdeReunion(reunion);
      const snapshot = inicioSesion
        ? copresencia.getSessionSnapshot(rid, inicioSesion)
        : null;
      cb?.({ ok: true, snapshot, liveEnabled: copresencia.isAsistenciaLiveEnabled() });
    } catch (e) {
      console.error('attendance:subscribe', e);
      cb?.({ ok: false, error: 'Error al suscribir asistencia en vivo' });
    }
  });

  socket.on('attendance:unsubscribe', ({ reunionId } = {}, cb) => {
    const rid = reunionId != null ? String(reunionId).trim() : '';
    if (rid) socket.leave(copresencia.attendanceWatchRoom(rid));
    cb?.({ ok: true });
  });
}

module.exports = {
  emitAttendancePresence,
  emitAttendanceCopresence,
  emitAttendanceFulfilled,
  afterAttendancePresenceChange,
  startCopresenceTimer,
  stopCopresenceTimer,
  registerAttendanceLiveHandlers,
};
