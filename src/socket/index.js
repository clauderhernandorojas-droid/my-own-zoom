const jwt = require('jsonwebtoken');
const { Sequelize } = require('sequelize');
const { Participa, Reunion, Mensaje, Tablero } = require('../models');

const boardSaveTimers = new Map();
/** roomId (string) → true cuando el docente activó «la audiencia sigue mi vista» */
const boardFollowActive = new Map();
/** roomId → última vista del docente { boardPanX, boardPanY, boardZoom } */
const boardFollowLastView = new Map();

/** Clave única para salas Socket.IO y Maps (UUID suele variar en mayúsculas). */
function normRoomId(id) {
  if (id == null || id === '') return '';
  return String(id).trim().toLowerCase();
}

function verifySocketToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
  } catch {
    return null;
  }
}

async function usuarioEnReunion(usuarioId, reunionId) {
  const row = await Participa.findOne({ where: { usuarioId, reunionId } });
  return !!row;
}

async function obtenerReunionPorRoom(roomId) {
  const key = normRoomId(roomId);
  if (!key) return null;
  return Reunion.findOne({
    where: Sequelize.where(Sequelize.fn('lower', Sequelize.col('room_id')), key),
  });
}

/** Compara UUID (JWT vs Sequelize pueden diferir en mayúsculas). */
function sameUsuarioId(a, b) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function scheduleBoardPersist(reunionId, contenido) {
  const key = reunionId;
  if (boardSaveTimers.has(key)) clearTimeout(boardSaveTimers.get(key));
  const t = setTimeout(async () => {
    boardSaveTimers.delete(key);
    try {
      await Tablero.update(
        { contenido, ultimaEdicion: new Date() },
        { where: { reunionId } }
      );
    } catch (e) {
      console.error('Tablero persist error', e);
    }
  }, 1200);
  boardSaveTimers.set(key, t);
}

function attachSocketIO(io) {
  io.use(async (socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      null;
    const payload = verifySocketToken(token);
    if (!payload?.sub) {
      return next(new Error('UNAUTHORIZED'));
    }
    socket.data.userId = payload.sub != null ? String(payload.sub) : null;
    socket.data.rol = payload.rol;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;

    socket.on('room:join', async ({ roomId }, cb) => {
      try {
        const roomKey = normRoomId(roomId);
        if (!roomKey) {
          cb?.({ ok: false, error: 'roomId requerido' });
          return;
        }
        const reunion = await obtenerReunionPorRoom(roomKey);
        if (!reunion) {
          cb?.({ ok: false, error: 'Sala no encontrada' });
          return;
        }
        const ok = await usuarioEnReunion(userId, reunion.reunionId);
        if (!ok) {
          cb?.({ ok: false, error: 'No eres participante de esta reunión' });
          return;
        }
        const canonicalRoomId = normRoomId(reunion.roomId) || roomKey;
        socket.join(canonicalRoomId);
        socket.data.roomId = canonicalRoomId;
        socket.data.reunionId = reunion.reunionId;

        if (boardFollowActive.get(canonicalRoomId)) {
          socket.emit('board:follow:state', { roomId: canonicalRoomId, active: true });
          const v = boardFollowLastView.get(canonicalRoomId);
          if (v) socket.emit('board:view', { roomId: canonicalRoomId, ...v });
        }

        const roomSockets = await io.in(canonicalRoomId).fetchSockets();
        const peers = roomSockets
          .filter((s) => s.id !== socket.id)
          .map((s) => ({ socketId: s.id, userId: s.data.userId }));

        const tablero = await Tablero.findOne({ where: { reunionId: reunion.reunionId } });
        socket.emit('board:state', { contenido: tablero?.contenido ?? { elementos: [] } });

        socket.to(canonicalRoomId).emit('presence:join', { userId, socketId: socket.id });
        cb?.({
          ok: true,
          reunionId: reunion.reunionId,
          peers,
          docenteUsuarioId: reunion.docenteUsuarioId,
          roomId: canonicalRoomId,
        });
      } catch (e) {
        console.error(e);
        cb?.({ ok: false, error: 'Error al unirse a la sala' });
      }
    });

    socket.on('room:leave', async ({ roomId } = {}) => {
      const rid = normRoomId(roomId || socket.data.roomId);
      if (rid) {
        try {
          const reunion = await obtenerReunionPorRoom(rid);
          if (
            reunion &&
            sameUsuarioId(reunion.docenteUsuarioId, userId) &&
            boardFollowActive.get(rid)
          ) {
            boardFollowActive.delete(rid);
            boardFollowLastView.delete(rid);
            io.to(rid).emit('board:follow:state', { roomId: rid, active: false });
          }
        } catch (_) {}
        socket.leave(rid);
        socket.to(rid).emit('presence:leave', { userId });
      }
      socket.data.roomId = undefined;
      socket.data.reunionId = undefined;
    });

    socket.on('chat:message', async (payload, cb) => {
      try {
        const { roomId, contenido, tipo, destinatarioUsuarioId } = payload || {};
        if (!roomId || !contenido) {
          cb?.({ ok: false, error: 'roomId y contenido requeridos' });
          return;
        }
        const reunion = await obtenerReunionPorRoom(roomId);
        if (!reunion) {
          cb?.({ ok: false, error: 'Sala no encontrada' });
          return;
        }
        if (!(await usuarioEnReunion(userId, reunion.reunionId))) {
          cb?.({ ok: false, error: 'No participas en esta reunión' });
          return;
        }

        const tipoMsg = tipo === 'privado' ? 'privado' : 'general';
        let destinatario = null;
        if (tipoMsg === 'privado') {
          destinatario = destinatarioUsuarioId || reunion.docenteUsuarioId;
          const esDocente = sameUsuarioId(userId, reunion.docenteUsuarioId);
          if (!esDocente && !sameUsuarioId(destinatario, reunion.docenteUsuarioId)) {
            cb?.({ ok: false, error: 'Privado solo hacia el docente' });
            return;
          }
        }

        const mensaje = await Mensaje.create({
          reunionId: reunion.reunionId,
          usuarioId: userId,
          tipo: tipoMsg,
          contenido: String(contenido).trim(),
          destinatarioUsuarioId: tipoMsg === 'privado' ? destinatario : null,
        });
        const full = await Mensaje.findByPk(mensaje.mensajeId, {
          include: [
            { association: 'autor', attributes: ['usuarioId', 'nombre', 'email', 'rol'] },
            { association: 'destinatario', attributes: ['usuarioId', 'nombre', 'email', 'rol'], required: false },
          ],
        });

        if (tipoMsg === 'general') {
          io.to(normRoomId(roomId)).emit('chat:message', { mensaje: full });
        } else {
          const sockets = await io.fetchSockets();
          const targets = sockets.filter(
            (s) => s.data.userId === destinatario || s.data.userId === userId
          );
          targets.forEach((s) => s.emit('chat:message', { mensaje: full }));
        }
        cb?.({ ok: true, mensajeId: mensaje.mensajeId });
      } catch (e) {
        console.error(e);
        cb?.({ ok: false, error: 'Error al enviar mensaje' });
      }
    });

    socket.on('webrtc:offer', ({ roomId, sdp, targetSocketId }) => {
      if (!roomId || !sdp) return;
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc:offer', { sdp, from: socket.id });
      } else {
        socket.to(normRoomId(roomId)).emit('webrtc:offer', { sdp, from: socket.id });
      }
    });

    socket.on('webrtc:answer', ({ roomId, sdp, targetSocketId }) => {
      if (!roomId || !sdp) return;
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc:answer', { sdp, from: socket.id });
      } else {
        socket.to(normRoomId(roomId)).emit('webrtc:answer', { sdp, from: socket.id });
      }
    });

    socket.on('webrtc:ice-candidate', ({ roomId, candidate, targetSocketId }) => {
      if (!roomId || !candidate) return;
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc:ice-candidate', { candidate, from: socket.id });
      } else {
        socket.to(normRoomId(roomId)).emit('webrtc:ice-candidate', { candidate, from: socket.id });
      }
    });

    socket.on('board:update', async ({ roomId, contenido }) => {
      if (!roomId || contenido === undefined) return;
      const reunion = await obtenerReunionPorRoom(roomId);
      if (!reunion || !(await usuarioEnReunion(userId, reunion.reunionId))) return;
      const outRoom = normRoomId(reunion.roomId) || normRoomId(roomId);
      socket.to(outRoom).emit('board:update', { contenido, from: socket.id });
      scheduleBoardPersist(reunion.reunionId, contenido);
    });

    socket.on('board:follow:set', async ({ roomId, enabled }, cb) => {
      try {
        const roomKey = normRoomId(roomId);
        if (!roomKey) {
          cb?.({ ok: false, error: 'roomId requerido' });
          return;
        }
        const reunion = await obtenerReunionPorRoom(roomKey);
        if (!reunion || !sameUsuarioId(reunion.docenteUsuarioId, userId)) {
          cb?.({ ok: false, error: 'Solo el docente de la reunión puede activar esta opción' });
          return;
        }
        if (!(await usuarioEnReunion(userId, reunion.reunionId))) {
          cb?.({ ok: false, error: 'No participas en esta reunión' });
          return;
        }
        const canonicalRoomId = normRoomId(reunion.roomId) || roomKey;
        if (enabled) {
          boardFollowActive.set(canonicalRoomId, true);
        } else {
          boardFollowActive.delete(canonicalRoomId);
          boardFollowLastView.delete(canonicalRoomId);
        }
        io.in(canonicalRoomId).emit('board:follow:state', {
          roomId: canonicalRoomId,
          active: !!enabled,
        });
        cb?.({ ok: true });
      } catch (e) {
        console.error(e);
        cb?.({ ok: false, error: 'Error' });
      }
    });

    socket.on('recording:state', async ({ roomId, active }, cb) => {
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
        socket.to(roomKey).emit('recording:notify', {
          roomId: roomKey,
          userId,
          active: !!active,
        });
        cb?.({ ok: true });
      } catch (e) {
        console.error(e);
        cb?.({ ok: false, error: 'Error' });
      }
    });

    socket.on('board:view', async ({ roomId, view }) => {
      const roomKey = normRoomId(roomId);
      if (!roomKey || !view) return;
      if (!boardFollowActive.get(roomKey)) return;
      const reunion = await obtenerReunionPorRoom(roomKey);
      if (!reunion || !sameUsuarioId(reunion.docenteUsuarioId, userId)) return;
      if (!(await usuarioEnReunion(userId, reunion.reunionId))) return;
      const boardPanX = Number(view.boardPanX);
      const boardPanY = Number(view.boardPanY);
      const boardZoom = Number(view.boardZoom);
      if (![boardPanX, boardPanY, boardZoom].every(Number.isFinite)) return;
      const canonicalRoomId = normRoomId(reunion.roomId) || roomKey;
      const v = { roomId: canonicalRoomId, boardPanX, boardPanY, boardZoom };
      boardFollowLastView.set(canonicalRoomId, { boardPanX, boardPanY, boardZoom });
      socket.to(canonicalRoomId).emit('board:view', v);
    });

    socket.on('disconnecting', () => {
      const rooms = [...socket.rooms].filter((r) => r !== socket.id);
      rooms.forEach((roomId) => {
        socket.to(roomId).emit('presence:leave', { userId, socketId: socket.id });
      });
    });
  });
}

module.exports = { attachSocketIO };
