const fs = require('fs');
const jwt = require('jsonwebtoken');
const { Sequelize } = require('sequelize');
const { Participa, Reunion, Mensaje, MensajeReaccion, Tablero, Usuario } = require('../models');
const copresencia = require('../services/copresencia');
const { registrarEntradaStub, registrarSalidaStub } = require('../services/asistencia');
const { adjuntoAbsoluteOrNull, MAX_BYTES } = require('../services/chatAdjuntos');
const { findReunionByRoomKey } = require('../services/reunionByRoom');
const {
  consumeRoomEntryGrant,
  revokeRoomEntryGrant,
  registerAsistenciaSocketHandlers,
} = require('./asistenciaSocket');
const {
  afterAttendancePresenceChange,
  startCopresenceTimer,
  stopCopresenceTimer,
  registerAttendanceLiveHandlers,
} = require('./attendanceLive');

const boardSaveTimers = new Map();
/** roomId (string) → true cuando el docente activó «la audiencia sigue mi vista» */
const boardFollowActive = new Map();
/** roomId → última vista del docente { boardPanX, boardPanY, boardZoom } */
const boardFollowLastView = new Map();
/** roomId → usuarioId que está en «Compartir tablero» (sincroniza vista en otros clientes) */
const boardPresentationSharer = new Map();
/** roomId → usuarioId que está compartiendo pantalla (WebRTC solo envía pista vídeo sin metadatos fiables) */
const meetScreenShareSharer = new Map();
/** roomId → usuarioId invitado autorizado temporalmente para compartir pantalla */
const meetScreenShareGrant = new Map();
/** roomId → trazos de anotación sobre la pantalla compartida ({ elementos }) — sólo RAM, sin persistencia */
const meetScreenShareInkByRoom = new Map();
/** roomId → Set<usuarioId> autorizado temporalmente para entrar desde sala de espera */
const roomEntryGrant = new Map();
const CHAT_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '🎉', '👏'];

/** Clave única para salas Socket.IO y Maps (UUID suele variar en mayúsculas). */
function normRoomId(id) {
  if (id == null || id === '') return '';
  return String(id).trim().toLowerCase();
}

/** Strokes + text; todo lo demás se descarta. Sin persistencia en BD. */
function sanitizeScreenShareInkElementos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const el of raw.slice(0, 500)) {
    if (!el || typeof el !== 'object') continue;
    if (el.type === 'stroke' && Array.isArray(el.points)) {
      const points = el.points
        .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .slice(0, 9999);
      if (points.length < 2) continue;
      let lw =
        typeof el.lw === 'number' && el.lw > 0 && el.lw <= 1
          ? el.lw
          : typeof el.linewidthNorm === 'number'
            ? el.linewidthNorm
            : 0.008;
      if (lw > 1) lw = 1;
      if (lw <= 0) lw = 0.008;
      out.push({
        type: 'stroke',
        points,
        color: typeof el.color === 'string' && el.color.slice(0, 32) ? el.color : '#111111',
        lw,
      });
    } else if (el.type === 'text' && typeof el.text === 'string') {
      const text = el.text.replace(/\u0000/g, '').slice(0, 4000);
      if (!String(text).trim()) continue;
      const x = Number(el.x);
      const y = Number(el.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      let w = Number(el.w);
      let h = Number(el.h);
      if (!Number.isFinite(w) || w <= 0) w = 0.25;
      if (!Number.isFinite(h) || h <= 0) h = 0.1;
      w = Math.min(1, Math.max(0.02, w));
      h = Math.min(1, Math.max(0.02, h));
      let fontSize = Number(el.fontSize);
      if (!Number.isFinite(fontSize) || fontSize < 8) fontSize = 22;
      if (fontSize > 160) fontSize = 160;
      out.push({
        type: 'text',
        text,
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
        w,
        h,
        color: typeof el.color === 'string' && el.color.slice(0, 32) ? el.color : '#111111',
        fontSize: Math.round(fontSize),
      });
    }
  }
  return out;
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
  return findReunionByRoomKey(key);
}

/** Compara UUID (JWT vs Sequelize pueden diferir en mayúsculas). */
function sameUsuarioId(a, b) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function socketCanShareMeetingContent(socket, reunion) {
  const rol = String(socket.data?.rol || '').toLowerCase();
  if (rol === 'admin') return true;
  return sameUsuarioId(reunion.docenteUsuarioId, socket.data.userId);
}

function socketCanStartScreenShare(socket, reunion, canonicalRoomId) {
  if (socketCanShareMeetingContent(socket, reunion)) return true;
  const granted = meetScreenShareGrant.get(canonicalRoomId);
  return granted && sameUsuarioId(granted, socket.data.userId);
}

/** Desconecta un socket de la sala (copresencia, shares, presence) sin tocar Participa. */
async function performRoomLeaveForSocket(io, socket, data = {}) {
  const userId = socket.data.userId;
  const roomId = data?.roomId;
  const rid = normRoomId(roomId || socket.data.roomId);
  if (rid) {
    try {
      const reunionCop = await obtenerReunionPorRoom(rid);
      if (
        reunionCop &&
        socket.data.reunionId &&
        String(reunionCop.reunionId) === String(socket.data.reunionId)
      ) {
        const inicioCp = copresencia.inicioSesionDesdeReunion(reunionCop);
        if (inicioCp) {
          const regSalida = await registrarSalidaStub(reunionCop.reunionId, userId, {
            inicioSesion: inicioCp,
          });
          console.log('asistencia room:leave', regSalida ? { asistio: regSalida.asistio } : 'sin fila');
          await afterAttendancePresenceChange(io, rid, reunionCop.reunionId, inicioCp);
        }
        stopCopresenceTimer(rid);
      }
    } catch (err) {
      console.error('copresencia room:leave', err);
    }
    try {
      const pres = boardPresentationSharer.get(rid);
      if (pres && sameUsuarioId(pres, userId)) {
        boardPresentationSharer.delete(rid);
        socket.to(rid).emit('board:presentation', { roomId: rid, active: false, userId });
      }
      const screenShar = meetScreenShareSharer.get(rid);
      if (screenShar && sameUsuarioId(screenShar, userId)) {
        meetScreenShareSharer.delete(rid);
        meetScreenShareInkByRoom.delete(rid);
        socket.to(rid).emit('meet:screenShare', { roomId: rid, active: false, userId });
        io.to(rid).emit('screenshare-annotate:state', {
          roomId: rid,
          contenido: { elementos: [] },
        });
      }
      const granted = meetScreenShareGrant.get(rid);
      if (granted && sameUsuarioId(granted, userId)) {
        meetScreenShareGrant.delete(rid);
      }
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
    socket.to(rid).emit('presence:leave', { userId, socketId: socket.id });
  }
  socket.data.roomId = undefined;
  socket.data.reunionId = undefined;
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
    console.log('Nuevo socket conectado', socket.id);
    const userId = socket.data.userId;

    registerAsistenciaSocketHandlers(socket, io, {
      normRoomId,
      obtenerReunionPorRoom,
      usuarioEnReunion,
      sameUsuarioId,
      socketCanShareMeetingContent,
      Usuario,
    });

    registerAttendanceLiveHandlers(io, socket, {
      usuarioEnReunion,
      Reunion,
    });

    socket.on('room:join', async (data, cb) => {
      console.log('Evento room:join recibido', data);
      try {
        const roomId = data?.roomId;
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
        if (!socketCanShareMeetingContent(socket, reunion)) {
          const granted = consumeRoomEntryGrant(
            normRoomId,
            sameUsuarioId,
            canonicalRoomId,
            userId
          );
          if (!granted) {
            cb?.({ ok: false, error: 'Debes esperar la aprobación del presentador para entrar.' });
            return;
          }
        }
        socket.join(canonicalRoomId);
        socket.data.roomId = canonicalRoomId;
        socket.data.reunionId = reunion.reunionId;

        try {
          const inicioCp = copresencia.inicioSesionDesdeReunion(reunion);
          if (inicioCp) {
            await registrarEntradaStub(reunion.reunionId, userId, { inicioSesion: inicioCp });
            await afterAttendancePresenceChange(
              io,
              canonicalRoomId,
              reunion.reunionId,
              inicioCp
            );
            startCopresenceTimer(io, canonicalRoomId, reunion.reunionId, inicioCp);
          }
        } catch (err) {
          console.error('asistencia room:join', err);
        }

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

        const boardPresUser = boardPresentationSharer.get(canonicalRoomId);
        if (boardPresUser) {
          socket.emit('board:presentation', {
            roomId: canonicalRoomId,
            active: true,
            userId: boardPresUser,
          });
        }

        const screenSharer = meetScreenShareSharer.get(canonicalRoomId);
        if (screenSharer) {
          socket.emit('meet:screenShare', {
            roomId: canonicalRoomId,
            active: true,
            userId: screenSharer,
          });
          const ink = meetScreenShareInkByRoom.get(canonicalRoomId);
          socket.emit('screenshare-annotate:state', {
            roomId: canonicalRoomId,
            contenido: ink || { elementos: [] },
          });
        }
        const granted = meetScreenShareGrant.get(canonicalRoomId);
        if (granted && sameUsuarioId(granted, userId)) {
          socket.emit('meet:screenShare:grant', {
            roomId: canonicalRoomId,
            approved: true,
            byUserId: reunion.docenteUsuarioId,
          });
        }

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

    socket.on('room:leave', async (data = {}) => {
      console.log('Evento room:leave recibido', data);
      await performRoomLeaveForSocket(io, socket, data);
    });

    socket.on('room:expel', async ({ roomId, targetUserId }, cb) => {
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
          cb?.({ ok: false, error: 'Solo el presentador puede expulsar participantes' });
          return;
        }
        if (sameUsuarioId(targetId, userId)) {
          cb?.({ ok: false, error: 'No puedes expulsarte a ti mismo' });
          return;
        }
        if (sameUsuarioId(targetId, reunion.docenteUsuarioId)) {
          cb?.({ ok: false, error: 'No puedes expulsar al docente de la reunión' });
          return;
        }
        const canonicalRoomId = normRoomId(reunion.roomId) || roomKey;
        revokeRoomEntryGrant(normRoomId, sameUsuarioId, canonicalRoomId, targetId);

        const roomSockets = await io.in(canonicalRoomId).fetchSockets();
        const targets = roomSockets.filter((s) => sameUsuarioId(s.data.userId, targetId));
        if (!targets.length) {
          cb?.({ ok: false, error: 'El participante no está conectado en la sala' });
          return;
        }

        for (const targetSocket of targets) {
          targetSocket.emit('room:expelled', {
            roomId: canonicalRoomId,
            byUserId: userId,
          });
          await performRoomLeaveForSocket(io, targetSocket, { roomId: canonicalRoomId });
        }

        cb?.({ ok: true });
      } catch (e) {
        console.error('room:expel error', e);
        cb?.({ ok: false, error: 'Error al expulsar participante' });
      }
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

    socket.on('screenshare-annotate:update', async ({ roomId, contenido }) => {
      if (!roomId || contenido === undefined) return;
      const reunion = await obtenerReunionPorRoom(roomId);
      if (!reunion || !(await usuarioEnReunion(userId, reunion.reunionId))) return;
      if (!meetScreenShareSharer.get(normRoomId(reunion.roomId) || normRoomId(roomId))) return;
      const outRoom = normRoomId(reunion.roomId) || normRoomId(roomId);
      if (!Array.isArray(contenido.elementos)) return;
      const safe = sanitizeScreenShareInkElementos(contenido.elementos);
      const nextState = { elementos: safe.slice(0, 500) };
      meetScreenShareInkByRoom.set(outRoom, nextState);
      io.in(outRoom).emit('screenshare-annotate:update', {
        roomId: outRoom,
        contenido: nextState,
        from: socket.id,
      });
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
          order: [['mensajeReaccionId', 'ASC']],
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

    socket.on('board:presentation', async ({ roomId, active }) => {
      try {
        const roomKey = normRoomId(roomId);
        if (!roomKey) return;
        const reunion = await obtenerReunionPorRoom(roomKey);
        if (!reunion || !(await usuarioEnReunion(userId, reunion.reunionId))) return;
        const canonicalRoomId = normRoomId(reunion.roomId) || roomKey;
        if (active) {
          if (!socketCanShareMeetingContent(socket, reunion)) return;
          boardPresentationSharer.set(canonicalRoomId, userId);
          socket.to(canonicalRoomId).emit('board:presentation', {
            roomId: canonicalRoomId,
            active: true,
            userId,
          });
        } else {
          const cur = boardPresentationSharer.get(canonicalRoomId);
          if (!cur || !sameUsuarioId(cur, userId)) return;
          boardPresentationSharer.delete(canonicalRoomId);
          socket.to(canonicalRoomId).emit('board:presentation', {
            roomId: canonicalRoomId,
            active: false,
            userId,
          });
        }
      } catch (e) {
        console.error('board:presentation error', e);
      }
    });

    socket.on('meet:screenShare:trackRefresh', async ({ roomId }) => {
      try {
        const roomKey = normRoomId(roomId || socket.data.roomId);
        if (!roomKey) return;
        const reunion = await obtenerReunionPorRoom(roomKey);
        if (!reunion || !(await usuarioEnReunion(userId, reunion.reunionId))) return;
        const canonicalRoomId = normRoomId(reunion.roomId) || roomKey;
        const sharer = meetScreenShareSharer.get(canonicalRoomId);
        if (!sharer || !sameUsuarioId(sharer, userId)) return;
        socket.to(canonicalRoomId).emit('meet:screenShare:trackRefresh', {
          roomId: canonicalRoomId,
        });
      } catch (e) {
        console.error('meet:screenShare:trackRefresh error', e);
      }
    });

    socket.on('meet:screenShare', async ({ roomId, active }) => {
      try {
        const roomKey = normRoomId(roomId || socket.data.roomId);
        if (!roomKey) return;
        const reunion = await obtenerReunionPorRoom(roomKey);
        if (!reunion || !(await usuarioEnReunion(userId, reunion.reunionId))) return;
        const canonicalRoomId = normRoomId(reunion.roomId) || roomKey;
        if (active) {
          if (!socketCanStartScreenShare(socket, reunion, canonicalRoomId)) return;
          meetScreenShareSharer.set(canonicalRoomId, userId);
          meetScreenShareInkByRoom.set(canonicalRoomId, { elementos: [] });
          if (!socketCanShareMeetingContent(socket, reunion)) {
            meetScreenShareGrant.delete(canonicalRoomId);
          }
          socket.to(canonicalRoomId).emit('meet:screenShare', {
            roomId: canonicalRoomId,
            active: true,
            userId,
          });
          socket.to(canonicalRoomId).emit('screenshare-annotate:state', {
            roomId: canonicalRoomId,
            contenido: { elementos: [] },
          });
        } else {
          const cur = meetScreenShareSharer.get(canonicalRoomId);
          if (!cur || !sameUsuarioId(cur, userId)) return;
          meetScreenShareSharer.delete(canonicalRoomId);
          meetScreenShareInkByRoom.delete(canonicalRoomId);
          socket.to(canonicalRoomId).emit('meet:screenShare', {
            roomId: canonicalRoomId,
            active: false,
            userId,
          });
          io.in(canonicalRoomId).emit('screenshare-annotate:state', {
            roomId: canonicalRoomId,
            contenido: { elementos: [] },
          });
        }
      } catch (e) {
        console.error('meet:screenShare error', e);
      }
    });

    socket.on('meet:screenShare:request', async ({ roomId }, cb) => {
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
          cb?.({ ok: false, error: 'Ya tienes permiso para compartir' });
          return;
        }
        const roomSockets = await io.in(canonicalRoomId).fetchSockets();
        const presenterSockets = roomSockets.filter((s) =>
          socketCanShareMeetingContent(s, reunion)
        );
        if (!presenterSockets.length) {
          cb?.({ ok: false, error: 'No hay presentador conectado para aprobar la solicitud' });
          return;
        }
        presenterSockets.forEach((s) =>
          s.emit('meet:screenShare:request', {
            roomId: canonicalRoomId,
            requesterUserId: userId,
          })
        );
        cb?.({ ok: true });
      } catch (e) {
        console.error('meet:screenShare:request error', e);
        cb?.({ ok: false, error: 'Error enviando solicitud' });
      }
    });

    socket.on('meet:screenShare:response', async ({ roomId, targetUserId, approved }, cb) => {
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
        if (approved) {
          meetScreenShareGrant.set(canonicalRoomId, targetId);
        } else {
          const g = meetScreenShareGrant.get(canonicalRoomId);
          if (g && sameUsuarioId(g, targetId)) meetScreenShareGrant.delete(canonicalRoomId);
        }
        const roomSockets = await io.in(canonicalRoomId).fetchSockets();
        roomSockets
          .filter((s) => sameUsuarioId(s.data.userId, targetId))
          .forEach((s) =>
            s.emit('meet:screenShare:grant', {
              roomId: canonicalRoomId,
              approved: !!approved,
              byUserId: userId,
            })
          );
        cb?.({ ok: true });
      } catch (e) {
        console.error('meet:screenShare:response error', e);
        cb?.({ ok: false, error: 'Error respondiendo solicitud' });
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
        const pres = boardPresentationSharer.get(roomId);
        if (pres && sameUsuarioId(pres, userId)) {
          boardPresentationSharer.delete(roomId);
          socket.to(roomId).emit('board:presentation', {
            roomId,
            active: false,
            userId,
          });
        }
        const screenShar = meetScreenShareSharer.get(roomId);
        if (screenShar && sameUsuarioId(screenShar, userId)) {
          meetScreenShareSharer.delete(roomId);
          meetScreenShareInkByRoom.delete(roomId);
          socket.to(roomId).emit('meet:screenShare', {
            roomId,
            active: false,
            userId,
          });
          io.to(roomId).emit('screenshare-annotate:state', {
            roomId,
            contenido: { elementos: [] },
          });
        }
        const granted = meetScreenShareGrant.get(roomId);
        if (granted && sameUsuarioId(granted, userId)) {
          meetScreenShareGrant.delete(roomId);
        }
        socket.to(roomId).emit('presence:leave', { userId, socketId: socket.id });
      });
    });
  });
}

module.exports = { attachSocketIO };
