const jwt = require('jsonwebtoken');
const { Participa, Reunion, Mensaje, Tablero } = require('../models');

const boardSaveTimers = new Map();

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
  return Reunion.findOne({ where: { roomId } });
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
    socket.data.userId = payload.sub;
    socket.data.rol = payload.rol;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;

    socket.on('room:join', async ({ roomId }, cb) => {
      try {
        if (!roomId) {
          cb?.({ ok: false, error: 'roomId requerido' });
          return;
        }
        const reunion = await obtenerReunionPorRoom(roomId);
        if (!reunion) {
          cb?.({ ok: false, error: 'Sala no encontrada' });
          return;
        }
        const ok = await usuarioEnReunion(userId, reunion.reunionId);
        if (!ok) {
          cb?.({ ok: false, error: 'No eres participante de esta reunión' });
          return;
        }
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.reunionId = reunion.reunionId;

        const roomSockets = await io.in(roomId).fetchSockets();
        const peers = roomSockets
          .filter((s) => s.id !== socket.id)
          .map((s) => ({ socketId: s.id, userId: s.data.userId }));

        const tablero = await Tablero.findOne({ where: { reunionId: reunion.reunionId } });
        socket.emit('board:state', { contenido: tablero?.contenido ?? { elementos: [] } });

        socket.to(roomId).emit('presence:join', { userId, socketId: socket.id });
        cb?.({ ok: true, reunionId: reunion.reunionId, peers });
      } catch (e) {
        console.error(e);
        cb?.({ ok: false, error: 'Error al unirse a la sala' });
      }
    });

    socket.on('room:leave', ({ roomId } = {}) => {
      const rid = roomId || socket.data.roomId;
      if (rid) {
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
          const esDocente = userId === reunion.docenteUsuarioId;
          if (!esDocente && destinatario !== reunion.docenteUsuarioId) {
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
          io.to(roomId).emit('chat:message', { mensaje: full });
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
        socket.to(roomId).emit('webrtc:offer', { sdp, from: socket.id });
      }
    });

    socket.on('webrtc:answer', ({ roomId, sdp, targetSocketId }) => {
      if (!roomId || !sdp) return;
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc:answer', { sdp, from: socket.id });
      } else {
        socket.to(roomId).emit('webrtc:answer', { sdp, from: socket.id });
      }
    });

    socket.on('webrtc:ice-candidate', ({ roomId, candidate, targetSocketId }) => {
      if (!roomId || !candidate) return;
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc:ice-candidate', { candidate, from: socket.id });
      } else {
        socket.to(roomId).emit('webrtc:ice-candidate', { candidate, from: socket.id });
      }
    });

    socket.on('board:update', async ({ roomId, contenido }) => {
      if (!roomId || contenido === undefined) return;
      const reunion = await obtenerReunionPorRoom(roomId);
      if (!reunion || !(await usuarioEnReunion(userId, reunion.reunionId))) return;
      socket.to(roomId).emit('board:update', { contenido, from: socket.id });
      scheduleBoardPersist(reunion.reunionId, contenido);
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
