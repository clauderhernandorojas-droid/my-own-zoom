/** roomId (canónico) → Set<usuarioId> con permiso temporal para entrar (sala de espera). */
const roomEntryGrant = new Map();

function grantRoomEntry(normRoomIdFn, canonicalRoomId, targetUserId) {
  const key = normRoomIdFn(canonicalRoomId);
  if (!key || !targetUserId) return;
  let set = roomEntryGrant.get(key);
  if (!set) {
    set = new Set();
    roomEntryGrant.set(key, set);
  }
  set.add(String(targetUserId));
}

function consumeRoomEntryGrant(normRoomIdFn, sameUsuarioIdFn, canonicalRoomId, targetUserId) {
  const key = normRoomIdFn(canonicalRoomId);
  const uid = targetUserId != null ? String(targetUserId) : '';
  if (!key || !uid) return false;
  const set = roomEntryGrant.get(key);
  if (!set || !set.size) return false;
  let matched = null;
  for (const id of set) {
    if (sameUsuarioIdFn(id, uid)) {
      matched = id;
      break;
    }
  }
  if (!matched) return false;
  set.delete(matched);
  if (!set.size) roomEntryGrant.delete(key);
  return true;
}

function revokeRoomEntryGrant(normRoomIdFn, sameUsuarioIdFn, canonicalRoomId, targetUserId) {
  const key = normRoomIdFn(canonicalRoomId);
  const uid = targetUserId != null ? String(targetUserId) : '';
  if (!key || !uid) return;
  const set = roomEntryGrant.get(key);
  if (!set || !set.size) return;
  for (const id of [...set]) {
    if (sameUsuarioIdFn(id, uid)) set.delete(id);
  }
  if (!set.size) roomEntryGrant.delete(key);
}

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {object} deps
 * @param {(id: unknown) => string} deps.normRoomId
 * @param {(roomId: string) => Promise<import('sequelize').Model|null>} deps.obtenerReunionPorRoom
 * @param {(usuarioId: string, reunionId: string) => Promise<boolean>} deps.usuarioEnReunion
 * @param {(a: unknown, b: unknown) => boolean} deps.sameUsuarioId
 * @param {(socket: import('socket.io').Socket, reunion: object) => boolean} deps.socketCanShareMeetingContent
 * @param {typeof import('../models').Usuario} deps.Usuario
 */
function registerAsistenciaSocketHandlers(socket, io, deps) {
  const {
    normRoomId,
    obtenerReunionPorRoom,
    usuarioEnReunion,
    sameUsuarioId,
    socketCanShareMeetingContent,
    Usuario,
  } = deps;
  const userId = socket.data.userId;

  socket.on('room:entry:request', async ({ roomId }, cb) => {
    try {
      const roomKey = normRoomId(roomId || socket.data.roomId);
      if (!roomKey) {
        cb?.({ ok: false, error: 'roomId requerido' });
        return;
      }
      const reunion = await obtenerReunionPorRoom(roomKey);
      if (!reunion || !(await usuarioEnReunion(userId, reunion.reunionId))) {
        cb?.({ ok: false, error: 'No participas en esta reunión' });
        return;
      }
      const canonicalRoomId = normRoomId(reunion.roomId) || roomKey;
      if (socketCanShareMeetingContent(socket, reunion)) {
        cb?.({ ok: true, alreadyAllowed: true });
        return;
      }
      const alreadyGranted = (() => {
        const set = roomEntryGrant.get(canonicalRoomId);
        if (!set || !set.size) return false;
        for (const id of set) if (sameUsuarioId(id, userId)) return true;
        return false;
      })();
      if (alreadyGranted) {
        cb?.({ ok: true, alreadyAllowed: true });
        return;
      }
      const requester = await Usuario.findByPk(userId, { attributes: ['usuarioId', 'nombre', 'email'] });
      const requesterName = requester?.nombre || requester?.email || String(userId).slice(0, 8);
      const roomSockets = await io.in(canonicalRoomId).fetchSockets();
      const presenterSockets = roomSockets.filter((s) => socketCanShareMeetingContent(s, reunion));
      if (!presenterSockets.length) {
        cb?.({ ok: false, error: 'No hay presentador conectado para aprobar tu entrada.' });
        return;
      }
      presenterSockets.forEach((s) =>
        s.emit('room:entry:request', {
          roomId: canonicalRoomId,
          requesterUserId: userId,
          requesterName,
        })
      );
      cb?.({ ok: true });
    } catch (e) {
      console.error('room:entry:request error', e);
      cb?.({ ok: false, error: 'Error enviando solicitud de entrada' });
    }
  });

  socket.on('room:entry:response', async ({ roomId, targetUserId, approved }, cb) => {
    try {
      const roomKey = normRoomId(roomId || socket.data.roomId);
      const targetId = targetUserId != null ? String(targetUserId) : '';
      if (!roomKey || !targetId) {
        cb?.({ ok: false, error: 'roomId y targetUserId requeridos' });
        return;
      }
      const reunion = await obtenerReunionPorRoom(roomKey);
      if (!reunion || !(await usuarioEnReunion(userId, reunion.reunionId))) {
        cb?.({ ok: false, error: 'No participas en esta reunión' });
        return;
      }
      if (!socketCanShareMeetingContent(socket, reunion)) {
        cb?.({ ok: false, error: 'Solo el presentador puede responder solicitudes' });
        return;
      }
      const canonicalRoomId = normRoomId(reunion.roomId) || roomKey;
      if (approved) grantRoomEntry(normRoomId, canonicalRoomId, targetId);
      else revokeRoomEntryGrant(normRoomId, sameUsuarioId, canonicalRoomId, targetId);
      const roomSockets = await io.fetchSockets();
      roomSockets
        .filter((s) => sameUsuarioId(s.data.userId, targetId))
        .forEach((s) =>
          s.emit('room:entry:decision', {
            roomId: canonicalRoomId,
            approved: !!approved,
            byUserId: userId,
          })
        );
      cb?.({ ok: true });
    } catch (e) {
      console.error('room:entry:response error', e);
      cb?.({ ok: false, error: 'Error respondiendo solicitud de entrada' });
    }
  });
}

module.exports = {
  consumeRoomEntryGrant,
  revokeRoomEntryGrant,
  registerAsistenciaSocketHandlers,
};
