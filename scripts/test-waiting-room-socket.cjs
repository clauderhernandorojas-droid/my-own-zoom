/**
 * Prueba sala de espera (socket):
 * - Invitado sin grant → room:join rechazado
 * - Presentador aprueba → room:entry:response → invitado room:join OK
 *
 * Uso: con `npm start` en otro terminal:
 *   node scripts/test-waiting-room-socket.cjs
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
    console.error('[wait] No hay estudiante en reunión con roomId');
    process.exit(1);
  }
  const docPart = await Participa.findOne({
    where: { reunionId: estPart.reunionId, rolEnReunion: 'docente' },
  });
  if (!docPart) {
    console.error('[wait] No hay docente en esa reunión');
    process.exit(1);
  }
  const reunion = estPart.Reunion || (await Reunion.findByPk(estPart.reunionId));
  const roomId = reunion.roomId;
  const tokDoc = signToken(docPart.usuarioId, 'docente');
  const tokEst = signToken(estPart.usuarioId, 'estudiante');

  console.log('[wait] reunionId=', reunion.reunionId, 'roomId=', roomId);

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
  console.log('[wait] Sockets conectados');

  const ackDoc = await new Promise((resolve) => {
    sockDoc.emit('room:join', { roomId }, resolve);
  });
  if (!ackDoc?.ok) {
    console.error('[wait] Docente no pudo unirse:', ackDoc);
    process.exit(1);
  }
  console.log('[wait] Docente en sala OK');

  const ackEstBlocked = await new Promise((resolve) => {
    sockEst.emit('room:join', { roomId }, resolve);
  });
  if (ackEstBlocked?.ok !== false) {
    console.error('[wait] Se esperaba rechazo sin grant; got:', ackEstBlocked);
    process.exit(1);
  }
  const errMsg = String(ackEstBlocked?.error || '');
  if (!errMsg.toLowerCase().includes('aprob')) {
    console.error('[wait] Mensaje de error inesperado:', errMsg);
    process.exit(1);
  }
  console.log('[wait] Invitado rechazado sin grant:', errMsg);

  const grantResp = await new Promise((resolve) => {
    sockDoc.emit(
      'room:entry:response',
      {
        roomId,
        targetUserId: String(estPart.usuarioId),
        approved: true,
      },
      resolve
    );
  });
  if (!grantResp?.ok) {
    console.error('[wait] Grant falló:', grantResp);
    process.exit(1);
  }
  console.log('[wait] Grant emitido por docente');

  await sleep(200);

  const ackEstOk = await new Promise((resolve) => {
    sockEst.emit('room:join', { roomId }, resolve);
  });
  if (!ackEstOk?.ok) {
    console.error('[wait] Invitado no pudo unirse tras grant:', ackEstOk);
    process.exit(1);
  }
  console.log('[wait] Invitado en sala tras aprobación OK');

  sockDoc.emit('room:leave', { roomId });
  sockEst.emit('room:leave', { roomId });
  await sleep(300);
  sockDoc.close();
  sockEst.close();

  console.log('[wait] PASS');
}

main().catch((e) => {
  console.error('[wait] FAIL', e);
  process.exit(1);
});
