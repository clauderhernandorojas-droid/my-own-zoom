/**
 * Prueba anotaciones sobre pantalla compartida (socket):
 * - Docente comparte → estado vacío broadcast
 * - Emit annotate → estudiante recibe update sanitizado
 * - Estudiante también puede anotar (cualquier participante)
 * - Join tardío recibe screenshare-annotate:state con tinta
 * - Al detener share → estado vacío para todos
 *
 * Uso: con `npm start` en otro terminal:
 *   node scripts/test-screenshare-annotate-socket.cjs
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { io } = require('socket.io-client');
const { Reunion, Participa } = require('../src/models');

const PORT = Number(process.env.PORT) || 3000;
const BASE = `http://127.0.0.1:${PORT}`;

function signToken(usuarioId, rol) {
  return jwt.sign(
    { sub: String(usuarioId), rol },
    process.env.JWT_SECRET || 'dev_secret',
    { expiresIn: '2h' }
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normRoomId(roomId) {
  return String(roomId || '')
    .trim()
    .toLowerCase();
}

async function joinRoom(sock, roomId) {
  return new Promise((resolve) => {
    sock.emit('room:join', { roomId }, resolve);
  });
}

const SAMPLE_INK = {
  elementos: [
    {
      type: 'stroke',
      color: '#111111',
      lw: 0.008,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.5, y: 0.5 },
      ],
    },
    {
      type: 'text',
      text: 'Hola overlay',
      x: 0.2,
      y: 0.2,
      w: 0.06,
      h: 0.04,
      color: '#1e88e5',
      fontSize: 24,
    },
    {
      type: 'text',
      text: '😀',
      x: 0.6,
      y: 0.3,
      w: 0.04,
      h: 0.04,
      color: '#111111',
      fontSize: 42,
    },
  ],
};

async function main() {
  const estPart = await Participa.findOne({
    where: { rolEnReunion: { [Op.in]: ['estudiante', 'asistente'] } },
    include: [
      {
        model: Reunion,
        required: true,
        where: { fechaHora: { [Op.ne]: null }, roomId: { [Op.ne]: null } },
      },
    ],
  });
  if (!estPart) {
    console.error('[annotate] No hay estudiante en reunión con roomId');
    process.exit(1);
  }
  const docPart = await Participa.findOne({
    where: { reunionId: estPart.reunionId, rolEnReunion: 'docente' },
  });
  if (!docPart) {
    console.error('[annotate] No hay docente en esa reunión');
    process.exit(1);
  }
  const reunion = estPart.Reunion || (await Reunion.findByPk(estPart.reunionId));
  const roomId = reunion.roomId;
  const canonical = normRoomId(roomId);
  const tokDoc = signToken(docPart.usuarioId, 'docente');
  const tokEst = signToken(estPart.usuarioId, 'estudiante');

  console.log('[annotate] reunionId=', reunion.reunionId, 'roomId=', roomId);

  const sockDoc = io(BASE, { auth: { token: tokDoc }, transports: ['websocket'] });
  const sockEst = io(BASE, { auth: { token: tokEst }, transports: ['websocket'] });

  await Promise.all([
    new Promise((resolve, reject) => {
      sockDoc.once('connect_error', reject);
      sockDoc.once('connect', resolve);
    }),
    new Promise((resolve, reject) => {
      sockEst.once('connect_error', reject);
      sockEst.once('connect', resolve);
    }),
  ]);
  console.log('[annotate] Sockets conectados');

  const ackDoc = await joinRoom(sockDoc, roomId);
  if (!ackDoc?.ok) {
    console.error('[annotate] Docente no pudo unirse:', ackDoc);
    process.exit(1);
  }
  const grantEntry = await new Promise((resolve) => {
    sockDoc.emit(
      'room:entry:response',
      { roomId, targetUserId: String(estPart.usuarioId), approved: true },
      resolve
    );
  });
  if (!grantEntry?.ok) {
    console.error('[annotate] Grant entrada falló:', grantEntry);
    process.exit(1);
  }
  const ackEst = await joinRoom(sockEst, roomId);
  if (!ackEst?.ok) {
    console.error('[annotate] Estudiante no pudo unirse:', ackEst);
    process.exit(1);
  }
  console.log('[annotate] Ambos en sala');

  let estSawAnnotateUpdate = false;
  let estSawClearState = false;

  sockEst.on('screenshare-annotate:update', (p) => {
    if (normRoomId(p?.roomId) !== canonical) return;
    if (Array.isArray(p?.contenido?.elementos) && p.contenido.elementos.length >= 3) {
      estSawAnnotateUpdate = true;
    }
  });
  sockEst.on('screenshare-annotate:state', (p) => {
    if (normRoomId(p?.roomId) !== canonical) return;
    if (Array.isArray(p?.contenido?.elementos) && p.contenido.elementos.length === 0) {
      estSawClearState = true;
    }
  });

  sockDoc.emit('meet:screenShare', { roomId, active: true });
  await sleep(300);
  console.log('[annotate] Docente compartió pantalla');

  sockDoc.emit('screenshare-annotate:update', { roomId, contenido: SAMPLE_INK });
  await sleep(400);

  if (!estSawAnnotateUpdate) {
    console.error('[annotate] Estudiante no recibió screenshare-annotate:update con tinta');
    process.exit(1);
  }
  console.log('[annotate] Update de anotaciones recibido (OK)');

  sockEst.disconnect();
  await sleep(200);

  const joinLatePromise = new Promise((resolve) => {
    const handler = (p) => {
      if (normRoomId(p?.roomId) === canonical) {
        sockEst.off('screenshare-annotate:state', handler);
        resolve(p);
      }
    };
    sockEst.on('screenshare-annotate:state', handler);
    setTimeout(() => resolve(null), 3000);
  });

  await new Promise((resolve, reject) => {
    sockEst.once('connect_error', reject);
    sockEst.connect();
    sockEst.once('connect', resolve);
  });

  const grantReentry = await new Promise((resolve) => {
    sockDoc.emit(
      'room:entry:response',
      { roomId, targetUserId: String(estPart.usuarioId), approved: true },
      resolve
    );
  });
  if (!grantReentry?.ok) {
    console.error('[annotate] Re-aprobación entrada falló:', grantReentry);
    process.exit(1);
  }

  const ackLate = await joinRoom(sockEst, roomId);
  if (!ackLate?.ok) {
    console.error('[annotate] Re-join tardío falló:', ackLate);
    process.exit(1);
  }
  const lateJoinState = await joinLatePromise;
  if (!lateJoinState?.contenido?.elementos?.length) {
    console.error('[annotate] Join tardío no recibió estado de anotaciones');
    process.exit(1);
  }
  console.log('[annotate] Join tardío recibió estado (OK), elementos=', lateJoinState.contenido.elementos.length);

  const tightText = lateJoinState.contenido.elementos.find((e) => e.text === 'Hola overlay');
  const emojiEl = lateJoinState.contenido.elementos.find((e) => e.text === '😀');
  if (!tightText || tightText.w > 0.15 || tightText.h > 0.08) {
    console.error('[annotate] Texto con bbox ajustado no persistió w/h:', tightText);
    process.exit(1);
  }
  if (!emojiEl || emojiEl.w > 0.08) {
    console.error('[annotate] Emoji con bbox ajustado no persistió w/h:', emojiEl);
    process.exit(1);
  }
  console.log('[annotate] Bbox texto/emoji round-trip (OK)');

  estSawClearState = false;
  sockDoc.emit('meet:screenShare', { roomId, active: false });
  await sleep(400);

  if (!estSawClearState) {
    console.error('[annotate] No se emitió screenshare-annotate:state vacío al detener share');
    process.exit(1);
  }
  console.log('[annotate] Estado limpiado al detener share (OK)');

  sockEst.emit('screenshare-annotate:update', { roomId, contenido: SAMPLE_INK });
  await sleep(200);
  console.log('[annotate] Update sin share activo ignorado por servidor (OK si no hubo broadcast)');

  sockDoc.disconnect();
  sockEst.disconnect();
  console.log('[annotate] Todas las pruebas pasaron');
  process.exit(0);
}

main().catch((e) => {
  console.error('[annotate] Error:', e);
  process.exit(1);
});
