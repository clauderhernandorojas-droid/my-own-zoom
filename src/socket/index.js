const fs = require('fs');
const jwt = require('jsonwebtoken');
const { Sequelize } = require('sequelize');
const { Participa, Reunion, Mensaje, MensajeReaccion, Tablero } = require('../models');
const { adjuntoAbsoluteOrNull, MAX_BYTES } = require('../services/chatAdjuntos');

const boardSaveTimers = new Map();
/** roomId (string) → true cuando el docente activó «la audiencia sigue mi vista» */
const boardFollowActive = new Map();
/** roomId → última vista del docente { boardPanX, boardPanY, boardZoom } */
const boardFollowLastView = new Map();
const CHAT_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '🎉', '👏'];

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

function buildReactionSummary(rows = []) {
  const grouped = new Map();
  rows.forEach((r) => {
    const emoji = String(r?.emoji || '');
    if (!emoji) return;
    if (!grouped.has(emoji)) grouped.set(emoji, []);
    grouped.get(emoji).push({
      usuarioId: r?.reactor?.usuarioId || r?.usuarioId || null,
      nombre: r?.reactor?.nombre || '',
    });
  });
  return [...grouped.entries()].map(([emoji, users]) => ({
    emoji,
    count: users.length,
    users,
  }));
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
        const {
          roomId,
          contenido,
          tipo,
          destinatarioUsuarioId,
          adjuntoRelPath,
          adjuntoNombreOriginal,
          adjuntoMime,
          adjuntoBytes,
        } = payload || {};
        const contenidoTrim = contenido != null ? String(contenido).trim() : '';
        const hasAdjunto =
          adjuntoRelPath &&
          adjuntoNombreOriginal &&
          Number.isFinite(Number(adjuntoBytes)) &&
          Number(adjuntoBytes) > 0;
        if (!roomId || (!contenidoTrim && !hasAdjunto)) {
          cb?.({ ok: false, error: 'roomId y contenido (o adjunto) requeridos' });
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

        let adjuntoFields = {};
        if (hasAdjunto) {
          const abs = adjuntoAbsoluteOrNull(reunion.reunionId, adjuntoRelPath);
          if (!abs || !fs.existsSync(abs)) {
            cb?.({ ok: false, error: 'Adjunto no encontrado en el servidor' });
            return;
          }
          const bytes = Math.min(Math.max(0, Math.floor(Number(adjuntoBytes))), MAX_BYTES);
          adjuntoFields = {
            adjuntoRelPath: String(adjuntoRelPath).trim(),
            adjuntoNombreOriginal: String(adjuntoNombreOriginal).trim().slice(0, 512),
            adjuntoMime: adjuntoMime ? String(adjuntoMime).trim().slice(0, 255) : null,
            adjuntoBytes: bytes,
          };
        }

        const textoFinal =
          contenidoTrim ||
          (hasAdjunto ? `[Archivo] ${adjuntoFields.adjuntoNombreOriginal}` : '');

        const mensaje = await Mensaje.create({
          reunionId: reunion.reunionId,
          usuarioId: userId,
          tipo: tipoMsg,
          contenido: textoFinal,
          destinatarioUsuarioId: tipoMsg === 'privado' ? destinatario : null,
          ...adjuntoFields,
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
        if (!sameUsuarioId(reunion.docenteUsuarioId, userId)) {
          cb?.({ ok: false, error: 'Solo el docente de la reunión puede grabar' });
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

    socket.on('room:reaction', async ({ roomId, emoji }, cb) => {
      try {
        const roomKey = normRoomId(roomId || socket.data.roomId);
        const emojiNorm = String(emoji || '').trim();
        if (!roomKey || !emojiNorm) {
          cb?.({ ok: false, error: 'roomId y emoji requeridos' });
          return;
        }
        if (!CHAT_REACTION_EMOJIS.includes(emojiNorm)) {
          cb?.({ ok: false, error: 'Emoji no permitido' });
          return;
        }
        const reunion = await obtenerReunionPorRoom(roomKey);
        if (!reunion || !(await usuarioEnReunion(userId, reunion.reunionId))) {
          cb?.({ ok: false, error: 'No participas en esta reunión' });
          return;
        }
        io.to(roomKey).emit('room:reaction', {
          roomId: roomKey,
          userId,
          emoji: emojiNorm,
          at: new Date().toISOString(),
        });
        cb?.({ ok: true });
      } catch (e) {
        console.error('room:reaction error', e);
        cb?.({ ok: false, error: 'Error enviando reacción' });
      }
    });

    socket.on('chat:reaction:toggle', async (payload, cb) => {
      try {
        const { roomId, mensajeId, emoji } = payload || {};
        const roomKey = normRoomId(roomId || socket.data.roomId);
        const emojiNorm = String(emoji || '').trim();
        if (!roomKey || !mensajeId || !emojiNorm) {
          cb?.({ ok: false, error: 'roomId, mensajeId y emoji requeridos' });
          return;
        }
        if (!CHAT_REACTION_EMOJIS.includes(emojiNorm)) {
          cb?.({ ok: false, error: 'Emoji no permitido' });
          return;
        }
        const reunion = await obtenerReunionPorRoom(roomKey);
        if (!reunion || !(await usuarioEnReunion(userId, reunion.reunionId))) {
          cb?.({ ok: false, error: 'No participas en esta reunión' });
          return;
        }

        const mensaje = await Mensaje.findByPk(mensajeId);
        if (!mensaje || !sameUsuarioId(mensaje.reunionId, reunion.reunionId)) {
          cb?.({ ok: false, error: 'Mensaje no encontrado en esta sala' });
          return;
        }
        if (
          mensaje.tipo === 'privado' &&
          !sameUsuarioId(mensaje.usuarioId, userId) &&
          !sameUsuarioId(mensaje.destinatarioUsuarioId, userId)
        ) {
          cb?.({ ok: false, error: 'No puedes reaccionar a este mensaje privado' });
          return;
        }

        const existing = await MensajeReaccion.findOne({
          where: { mensajeId: mensaje.mensajeId, usuarioId: userId, emoji: emojiNorm },
        });
        if (existing) {
          await existing.destroy();
        } else {
          await MensajeReaccion.create({
            mensajeId: mensaje.mensajeId,
            usuarioId: userId,
            emoji: emojiNorm,
          });
        }

        const rows = await MensajeReaccion.findAll({
          where: { mensajeId: mensaje.mensajeId },
          order: [['createdAt', 'ASC']],
          include: [{ association: 'reactor', attributes: ['usuarioId', 'nombre'], required: false }],
        });
        const summary = buildReactionSummary(rows);
        const out = { mensajeId: mensaje.mensajeId, reactions: summary };
        if (mensaje.tipo === 'general') {
          io.to(roomKey).emit('chat:messageReaction', out);
        } else {
          const sockets = await io.fetchSockets();
          const targets = sockets.filter(
            (s) =>
              sameUsuarioId(s.data.userId, mensaje.usuarioId) ||
              sameUsuarioId(s.data.userId, mensaje.destinatarioUsuarioId)
          );
          targets.forEach((s) => s.emit('chat:messageReaction', out));
        }
        cb?.({ ok: true, reactions: summary });
      } catch (e) {
        console.error('chat:reaction:toggle error', e);
        cb?.({ ok: false, error: 'Error al reaccionar al mensaje' });
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
