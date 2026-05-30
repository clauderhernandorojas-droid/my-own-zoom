/**
 * Prueba expulsión de invitados (socket):
 * - Docente expulsa estudiante conectado → estudiante recibe room:expelled
 * - Estudiante no puede emitir room:expel
 *
 * Uso: con `npm start` en otro terminal:
 *   node scripts/test-room-expel-socket.cjs
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
    console.error('[expel] No hay estudiante en reunión con roomId');
    process.exit(1);
  }
  const docPart = await Participa.findOne({
    where: { reunionId: estPart.reunionId, rolEnReunion: 'docente' },
  });
  if (!docPart) {
    console.error('[expel] No hay docente en esa reunión');
    process.exit(1);
  }
  const reunion = estPart.Reunion || (await Reunion.findByPk(estPart.reunionId));
  const roomId = reunion.roomId;
  const tokDoc = signToken(docPart.usuarioId, 'docente');
  const tokEst = signToken(estPart.usuarioId, 'estudiante');

  console.log('[expel] reunionId=', reunion.reunionId, 'roomId=', roomId);

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
  console.log('[expel] Sockets conectados');

  const ackDoc = await new Promise((resolve) => {
    sockDoc.emit('room:join', { roomId }, resolve);
  });
  if (!ackDoc?.ok) {
    console.error('[expel] Docente no pudo unirse:', ackDoc);
    process.exit(1);
  }
  console.log('[expel] Docente en sala OK');

  const grantResp = await new Promise((resolve) => {
    sockDoc.emit(
      'room:entry:response',
      { roomId, targetUserId: String(estPart.usuarioId), approved: true },
      resolve
    );
  });
  if (!grantResp?.ok) {
    console.error('[expel] Grant falló:', grantResp);
    process.exit(1);
  }

  const ackEst = await new Promise((resolve) => {
    sockEst.emit('room:join', { roomId }, resolve);
  });
  if (!ackEst?.ok) {
    console.error('[expel] Estudiante no pudo unirse:', ackEst);
    process.exit(1);
  }
  console.log('[expel] Estudiante en sala OK');

  const expelledPromise = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout room:expelled')), 5000);
    sockEst.once('room:expelled', (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });

  const expelResp = await new Promise((resolve) => {
    sockDoc.emit(
      'room:expel',
      { roomId, targetUserId: String(estPart.usuarioId) },
      resolve
    );
  });
  if (!expelResp?.ok) {
    console.error('[expel] room:expel falló:', expelResp);
    process.exit(1);
  }
  console.log('[expel] room:expel OK');

  const expelledPayload = await expelledPromise;
  if (!expelledPayload?.roomId) {
    console.error('[expel] Payload room:expelled inválido:', expelledPayload);
    process.exit(1);
  }
  console.log('[expel] Estudiante recibió room:expelled OK');

  await sleep(200);

  const estBlockedExpel = await new Promise((resolve) => {
    sockEst.emit(
      'room:expel',
      { roomId, targetUserId: String(docPart.usuarioId) },
      resolve
    );
  });
  if (estBlockedExpel?.ok !== false) {
    console.error('[expel] Se esperaba rechazo de room:expel por estudiante; got:', estBlockedExpel);
    process.exit(1);
  }
  console.log('[expel] Estudiante no puede expulsar:', estBlockedExpel?.error);

  sockDoc.emit('room:leave', { roomId });
  sockEst.emit('room:leave', { roomId });
  await sleep(200);
  sockDoc.close();
  sockEst.close();

  console.log('[expel] PASS');
}

main().catch((e) => {
  console.error('[expel] FAIL', e);
  process.exit(1);
});
