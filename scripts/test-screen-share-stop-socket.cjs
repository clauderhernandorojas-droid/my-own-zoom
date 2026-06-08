/**
 * Prueba control de compartir pantalla/tablero (socket):
 * - Docente comparte → invitado no puede detener con meet:screenShare active:false
 * - Invitado autorizado comparte y detiene su propia captura
 * - Invitado no puede iniciar board:presentation; no puede detener la del docente
 *
 * Uso: con `npm start` en otro terminal:
 *   node scripts/test-screen-share-stop-socket.cjs
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
    console.error('[share-stop] No hay estudiante en reunión con roomId');
    process.exit(1);
  }
  const docPart = await Participa.findOne({
    where: { reunionId: estPart.reunionId, rolEnReunion: 'docente' },
  });
  if (!docPart) {
    console.error('[share-stop] No hay docente en esa reunión');
    process.exit(1);
  }
  const reunion = estPart.Reunion || (await Reunion.findByPk(estPart.reunionId));
  const roomId = reunion.roomId;
  const canonical = normRoomId(roomId);
  const tokDoc = signToken(docPart.usuarioId, 'docente');
  const tokEst = signToken(estPart.usuarioId, 'estudiante');

  console.log('[share-stop] reunionId=', reunion.reunionId, 'roomId=', roomId);

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
  console.log('[share-stop] Sockets conectados');

  const ackDoc = await joinRoom(sockDoc, roomId);
  if (!ackDoc?.ok) {
    console.error('[share-stop] Docente no pudo unirse:', ackDoc);
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
    console.error('[share-stop] Grant entrada falló:', grantEntry);
    process.exit(1);
  }
  const ackEst = await joinRoom(sockEst, roomId);
  if (!ackEst?.ok) {
    console.error('[share-stop] Estudiante no pudo unirse:', ackEst);
    process.exit(1);
  }
  console.log('[share-stop] Ambos en sala');

  let docSawScreenStop = false;
  let estSawScreenStop = false;
  let estSawScreenStart = false;
  let docSawEstScreenStart = false;
  let estScreenStartUid = null;
  let docSawBoardStart = false;
  let estSawBoardStart = false;
  let estSawBoardStop = false;

  sockDoc.on('meet:screenShare', (p) => {
    if (normRoomId(p?.roomId) !== canonical) return;
    if (p?.active) {
      estScreenStartUid = p.userId;
      if (String(p.userId).toLowerCase() === String(estPart.usuarioId).toLowerCase()) {
        docSawEstScreenStart = true;
      }
    }
    if (!p?.active) docSawScreenStop = true;
  });
  sockEst.on('meet:screenShare', (p) => {
    if (normRoomId(p?.roomId) !== canonical) return;
    if (p?.active) estSawScreenStart = true;
    if (!p?.active) estSawScreenStop = true;
  });
  sockDoc.on('board:presentation', (p) => {
    if (normRoomId(p?.roomId) !== canonical) return;
    if (p?.active) docSawBoardStart = true;
  });
  sockEst.on('board:presentation', (p) => {
    if (normRoomId(p?.roomId) !== canonical) return;
    if (p?.active) estSawBoardStart = true;
    if (!p?.active) estSawBoardStop = true;
  });

  sockDoc.emit('meet:screenShare', { roomId, active: true });
  await sleep(300);
  if (!estSawScreenStart) {
    console.error('[share-stop] Estudiante no recibió inicio de pantalla del docente');
    process.exit(1);
  }
  console.log('[share-stop] Docente compartió pantalla (OK)');

  docSawScreenStop = false;
  estSawScreenStop = false;
  sockEst.emit('meet:screenShare', { roomId, active: false });
  await sleep(300);
  if (docSawScreenStop || estSawScreenStop) {
    console.error(
      '[share-stop] Invitado detuvo pantalla del docente (no esperado)',
      { docSawScreenStop, estSawScreenStop }
    );
    process.exit(1);
  }
  console.log('[share-stop] Invitado no puede detener pantalla del docente (OK)');

  const grantShare = await Promise.race([
    new Promise((resolve) => {
      sockDoc.emit(
        'meet:screenShare:response',
        { roomId, targetUserId: String(estPart.usuarioId), approved: true },
        resolve
      );
    }),
    sleep(10000).then(() => ({ ok: false, error: 'TIMEOUT' })),
  ]);
  if (!grantShare?.ok) {
    console.error('[share-stop] Grant compartir falló:', grantShare);
    process.exit(1);
  }
  await sleep(150);

  docSawScreenStop = false;
  estSawScreenStop = false;
  docSawEstScreenStart = false;
  estScreenStartUid = null;
  const estShareAck = await Promise.race([
    new Promise((resolve) => {
      sockEst.emit('meet:screenShare', { roomId, active: true }, resolve);
    }),
    sleep(10000).then(() => ({ ok: false, error: 'TIMEOUT' })),
  ]);
  await sleep(300);
  if (!estShareAck?.ok) {
    console.error('[share-stop] Ack invitado share start falló:', estShareAck);
    process.exit(1);
  }
  if (!docSawEstScreenStart) {
    console.error('[share-stop] Docente no recibió inicio de pantalla del invitado autorizado', estScreenStartUid);
    process.exit(1);
  }
  console.log('[share-stop] Invitado autorizado: presentador recibe meet:screenShare (OK)');

  docSawScreenStop = false;
  estSawScreenStop = false;
  sockEst.emit('meet:screenShare', { roomId, active: false });
  await sleep(300);
  if (!docSawScreenStop) {
    console.error('[share-stop] Docente no recibió stop del invitado autorizado');
    process.exit(1);
  }
  console.log('[share-stop] Invitado autorizado puede detener su pantalla (OK)');

  sockEst.emit('board:presentation', { roomId, active: true });
  await sleep(250);
  if (estSawBoardStart) {
    console.error('[share-stop] Invitado inició tablero (no esperado)');
    process.exit(1);
  }
  console.log('[share-stop] Invitado no puede iniciar tablero (OK)');

  estSawBoardStart = false;
  estSawBoardStop = false;
  sockDoc.emit('board:presentation', { roomId, active: true });
  await sleep(300);
  if (!estSawBoardStart) {
    console.error('[share-stop] Estudiante no recibió presentación de tablero del docente');
    process.exit(1);
  }

  estSawBoardStop = false;
  sockEst.emit('board:presentation', { roomId, active: false });
  await sleep(250);
  if (estSawBoardStop) {
    console.error('[share-stop] Invitado detuvo tablero del docente (no esperado)');
    process.exit(1);
  }

  sockDoc.emit('board:presentation', { roomId, active: false });
  await sleep(300);
  if (!estSawBoardStop) {
    console.error('[share-stop] Estudiante no recibió fin de tablero del docente');
    process.exit(1);
  }
  console.log('[share-stop] Tablero: ACL inicio/stop correctos (OK)');

  sockDoc.close();
  sockEst.close();
  console.log('[share-stop] Todas las pruebas pasaron.');
  process.exit(0);
}

main().catch((e) => {
  console.error('[share-stop] Error:', e);
  process.exit(1);
});
