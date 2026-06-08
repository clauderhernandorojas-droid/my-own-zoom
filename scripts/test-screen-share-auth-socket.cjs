/**
 * Pruebas de autorización y exclusividad de pantalla compartida (socket).
 * Requiere servidor en marcha: npm start
 *   node scripts/test-screen-share-auth-socket.cjs
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
  return String(roomId || '').trim().toLowerCase();
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
    console.error('[share-auth] No hay estudiante en reunión con roomId');
    process.exit(1);
  }
  const docPart = await Participa.findOne({
    where: { reunionId: estPart.reunionId, rolEnReunion: 'docente' },
  });
  if (!docPart) {
    console.error('[share-auth] No hay docente en esa reunión');
    process.exit(1);
  }
  const reunion = estPart.Reunion || (await Reunion.findByPk(estPart.reunionId));
  const roomId = reunion.roomId;
  const canonical = normRoomId(roomId);
  const tokDoc = signToken(docPart.usuarioId, 'docente');
  const tokEst = signToken(estPart.usuarioId, 'estudiante');

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

  const ackDoc = await joinRoom(sockDoc, roomId);
  if (!ackDoc?.ok) {
    console.error('[share-auth] Docente no pudo unirse:', ackDoc);
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
    console.error('[share-auth] Grant entrada falló:', grantEntry);
    process.exit(1);
  }
  const ackEst = await joinRoom(sockEst, roomId);
  if (!ackEst?.ok) {
    console.error('[share-auth] Estudiante no pudo unirse:', ackEst);
    process.exit(1);
  }
  console.log('[share-auth] Ambos en sala');

  // 1) Invitado sin grant → start → FORBIDDEN
  const forbiddenAck = await new Promise((resolve) => {
    sockEst.emit('meet:screenShare', { roomId, active: true }, resolve);
  });
  if (forbiddenAck?.ok !== false || forbiddenAck?.error !== 'FORBIDDEN') {
    console.error('[share-auth] Se esperaba FORBIDDEN sin grant:', forbiddenAck);
    process.exit(1);
  }
  console.log('[share-auth] Sin grant → FORBIDDEN (OK)');

  // 2) Request → response approved → grant → start OK
  let estGrant = null;
  let docRequest = null;
  sockEst.once('meet:screenShare:grant', (p) => {
    if (normRoomId(p?.roomId) === canonical) estGrant = p;
  });
  sockDoc.once('meet:screenShare:request', (p) => {
    if (normRoomId(p?.roomId) === canonical) docRequest = p;
  });

  const reqAck = await new Promise((resolve) => {
    sockEst.emit('meet:screenShare:request', { roomId }, resolve);
  });
  if (!reqAck?.ok) {
    console.error('[share-auth] Request falló:', reqAck);
    process.exit(1);
  }
  await sleep(200);
  if (!docRequest?.requesterUserId) {
    console.error('[share-auth] Presentador no recibió request');
    process.exit(1);
  }

  const respAck = await new Promise((resolve) => {
    sockDoc.emit(
      'meet:screenShare:response',
      { roomId, targetUserId: String(estPart.usuarioId), approved: true },
      resolve
    );
  });
  if (!respAck?.ok) {
    console.error('[share-auth] Response approved falló:', respAck);
    process.exit(1);
  }
  await sleep(200);
  if (!estGrant?.approved) {
    console.error('[share-auth] Invitado no recibió grant approved');
    process.exit(1);
  }

  let docSawEstStart = false;
  sockDoc.once('meet:screenShare', (p) => {
    if (
      normRoomId(p?.roomId) === canonical &&
      p?.active &&
      String(p.userId).toLowerCase() === String(estPart.usuarioId).toLowerCase()
    ) {
      docSawEstStart = true;
    }
  });
  const startAck = await new Promise((resolve) => {
    sockEst.emit('meet:screenShare', { roomId, active: true }, resolve);
  });
  await sleep(250);
  if (!startAck?.ok) {
    console.error('[share-auth] Start tras grant falló:', startAck);
    process.exit(1);
  }
  if (!docSawEstStart) {
    console.error('[share-auth] Docente no recibió broadcast de start del invitado');
    process.exit(1);
  }
  console.log('[share-auth] Request → grant → start (OK)');

  // 7) Presenter takeover screen (sin stop previo del invitado)
  const estTakeoverEvents = [];
  const onEstShareEvt = (p) => {
    if (normRoomId(p?.roomId) !== canonical) return;
    estTakeoverEvents.push({
      active: !!p.active,
      userId: String(p.userId || '').toLowerCase(),
    });
  };
  sockEst.on('meet:screenShare', onEstShareEvt);
  const docTakeoverAck = await new Promise((resolve) => {
    sockDoc.emit('meet:screenShare', { roomId, active: true }, resolve);
  });
  await sleep(300);
  if (!docTakeoverAck?.ok || !docTakeoverAck?.replacedUserId) {
    console.error('[share-auth] Presenter takeover screen falló:', docTakeoverAck);
    process.exit(1);
  }
  const estStopEvt = estTakeoverEvents.find(
    (e) =>
      !e.active &&
      e.userId === String(estPart.usuarioId).toLowerCase()
  );
  if (!estStopEvt) {
    console.error('[share-auth] Invitado no recibió stop en takeover', estTakeoverEvents);
    process.exit(1);
  }
  const grantTakeoverRetry = await new Promise((resolve) => {
    sockDoc.emit(
      'meet:screenShare:response',
      { roomId, targetUserId: String(estPart.usuarioId), approved: true },
      resolve
    );
  });
  if (!grantTakeoverRetry?.ok) {
    console.error('[share-auth] Grant tras takeover falló:', grantTakeoverRetry);
    process.exit(1);
  }
  await sleep(150);
  const estBlockedAfterTakeover = await new Promise((resolve) => {
    sockEst.emit('meet:screenShare', { roomId, active: true }, resolve);
  });
  if (
    estBlockedAfterTakeover?.ok !== false ||
    estBlockedAfterTakeover?.error !== 'SHARE_ALREADY_ACTIVE'
  ) {
    console.error(
      '[share-auth] Tras takeover docente, invitado debería recibir SHARE_ALREADY_ACTIVE:',
      estBlockedAfterTakeover
    );
    process.exit(1);
  }
  sockEst.off('meet:screenShare', onEstShareEvt);
  console.log('[share-auth] Presenter takeover screen (OK)');

  // 8) Presenter takeover via board
  await new Promise((resolve) => {
    sockDoc.emit('meet:screenShare', { roomId, active: false }, resolve);
  });
  await sleep(150);
  await new Promise((resolve) => {
    sockDoc.emit(
      'meet:screenShare:response',
      { roomId, targetUserId: String(estPart.usuarioId), approved: true },
      resolve
    );
  });
  await sleep(150);
  const estShareForBoard = await new Promise((resolve) => {
    sockEst.emit('meet:screenShare', { roomId, active: true }, resolve);
  });
  if (!estShareForBoard?.ok) {
    console.error('[share-auth] Start invitado para board takeover falló:', estShareForBoard);
    process.exit(1);
  }
  await sleep(200);
  let estSawBoardStop = false;
  let estSawBoard = false;
  sockEst.once('meet:screenShare', (p) => {
    if (normRoomId(p?.roomId) === canonical && !p?.active) estSawBoardStop = true;
  });
  sockEst.once('board:presentation', (p) => {
    if (normRoomId(p?.roomId) === canonical && p?.active) estSawBoard = true;
  });
  const boardTakeoverAck = await new Promise((resolve) => {
    sockDoc.emit('board:presentation', { roomId, active: true }, resolve);
  });
  await sleep(300);
  if (!boardTakeoverAck?.ok || !boardTakeoverAck?.screenShareStopped) {
    console.error('[share-auth] Board takeover falló:', boardTakeoverAck);
    process.exit(1);
  }
  if (!estSawBoardStop) {
    console.error('[share-auth] Invitado no recibió stop de pantalla al iniciar tablero');
    process.exit(1);
  }
  if (!estSawBoard) {
    console.error('[share-auth] Invitado no recibió board:presentation del docente');
    process.exit(1);
  }
  await new Promise((resolve) => {
    sockDoc.emit('board:presentation', { roomId, active: false }, resolve);
  });
  await sleep(150);
  console.log('[share-auth] Presenter takeover via board (OK)');

  // 4) Docente compartiendo → segundo start invitado granteado → SHARE_ALREADY_ACTIVE
  const docScreenAck = await new Promise((resolve) => {
    sockDoc.emit('meet:screenShare', { roomId, active: true }, resolve);
  });
  if (!docScreenAck?.ok) {
    console.error('[share-auth] Start docente para test 4 falló:', docScreenAck);
    process.exit(1);
  }
  await sleep(200);

  const grant2 = await new Promise((resolve) => {
    sockDoc.emit(
      'meet:screenShare:response',
      { roomId, targetUserId: String(estPart.usuarioId), approved: true },
      resolve
    );
  });
  if (!grant2?.ok) {
    console.error('[share-auth] Segundo grant falló:', grant2);
    process.exit(1);
  }
  await sleep(150);

  const conflictAck = await new Promise((resolve) => {
    sockEst.emit('meet:screenShare', { roomId, active: true }, resolve);
  });
  if (conflictAck?.ok !== false || conflictAck?.error !== 'SHARE_ALREADY_ACTIVE') {
    console.error('[share-auth] Se esperaba SHARE_ALREADY_ACTIVE:', conflictAck);
    process.exit(1);
  }
  console.log('[share-auth] Docente activo → invitado SHARE_ALREADY_ACTIVE (OK)');

  // 5) replaceActive → stop broadcast + grant al nuevo
  let docSawStop = false;
  let estSawStop = false;
  let estGrantReplace = null;
  sockDoc.on('meet:screenShare', (p) => {
    if (normRoomId(p?.roomId) === canonical && !p?.active) docSawStop = true;
  });
  sockEst.on('meet:screenShare', (p) => {
    if (normRoomId(p?.roomId) === canonical && !p?.active) estSawStop = true;
  });
  sockEst.once('meet:screenShare:grant', (p) => {
    if (normRoomId(p?.roomId) === canonical && p?.approved) estGrantReplace = p;
  });

  const req2 = await new Promise((resolve) => {
    sockEst.emit('meet:screenShare:request', { roomId }, resolve);
  });
  if (!req2?.ok) {
    console.error('[share-auth] Request con sharer activo falló:', req2);
    process.exit(1);
  }
  await sleep(150);

  docSawStop = false;
  estSawStop = false;
  const replaceAck = await new Promise((resolve) => {
    sockDoc.emit(
      'meet:screenShare:response',
      {
        roomId,
        targetUserId: String(estPart.usuarioId),
        approved: true,
        replaceActive: true,
      },
      resolve
    );
  });
  if (!replaceAck?.ok) {
    console.error('[share-auth] replaceActive response falló:', replaceAck);
    process.exit(1);
  }
  await sleep(300);
  if (!docSawStop || !estSawStop) {
    console.error('[share-auth] replaceActive no emitió stop a sala', { docSawStop, estSawStop });
    process.exit(1);
  }
  if (!estGrantReplace?.approved) {
    console.error('[share-auth] replaceActive no concedió grant');
    process.exit(1);
  }
  const estStartAfterReplace = await new Promise((resolve) => {
    sockEst.emit('meet:screenShare', { roomId, active: true }, resolve);
  });
  if (!estStartAfterReplace?.ok) {
    console.error('[share-auth] Start tras replace falló:', estStartAfterReplace);
    process.exit(1);
  }
  console.log('[share-auth] replaceActive → stop + grant + start invitado (OK)');

  // 3) Request → reject → grant approved: false (nuevo socket estudiante simulado con reset)
  sockEst.emit('meet:screenShare', { roomId, active: false });
  await sleep(200);

  let estRejectGrant = null;
  sockEst.once('meet:screenShare:grant', (p) => {
    if (normRoomId(p?.roomId) === canonical) estRejectGrant = p;
  });
  const req3 = await new Promise((resolve) => {
    sockEst.emit('meet:screenShare:request', { roomId }, resolve);
  });
  if (!req3?.ok) {
    console.error('[share-auth] Request para reject falló:', req3);
    process.exit(1);
  }
  await sleep(150);
  const rejectAck = await new Promise((resolve) => {
    sockDoc.emit(
      'meet:screenShare:response',
      { roomId, targetUserId: String(estPart.usuarioId), approved: false },
      resolve
    );
  });
  if (!rejectAck?.ok) {
    console.error('[share-auth] Reject response falló:', rejectAck);
    process.exit(1);
  }
  await sleep(200);
  if (estRejectGrant?.approved !== false) {
    console.error('[share-auth] Grant reject no recibido:', estRejectGrant);
    process.exit(1);
  }
  console.log('[share-auth] Request → reject → grant false (OK)');

  // 6) Disconnect sharer → active: false a sala
  const grantBeforeDisc = await new Promise((resolve) => {
    sockDoc.emit(
      'meet:screenShare:response',
      { roomId, targetUserId: String(estPart.usuarioId), approved: true },
      resolve
    );
  });
  if (!grantBeforeDisc?.ok) {
    console.error('[share-auth] Grant antes de disconnect falló:', grantBeforeDisc);
    process.exit(1);
  }
  const estShareBeforeDisc = await new Promise((resolve) => {
    sockEst.emit('meet:screenShare', { roomId, active: true }, resolve);
  });
  if (!estShareBeforeDisc?.ok) {
    console.error('[share-auth] Start antes de disconnect falló:', estShareBeforeDisc);
    process.exit(1);
  }
  await sleep(200);
  let roomSawStopOnDisconnect = false;
  sockDoc.once('meet:screenShare', (p) => {
    if (normRoomId(p?.roomId) === canonical && !p?.active) roomSawStopOnDisconnect = true;
  });
  sockEst.disconnect();
  await sleep(500);
  if (!roomSawStopOnDisconnect) {
    console.error('[share-auth] Docente no recibió stop al desconectar sharer');
    process.exit(1);
  }
  console.log('[share-auth] Disconnect sharer → active:false (OK)');

  sockDoc.close();
  console.log('[share-auth] Todas las pruebas pasaron.');
  process.exit(0);
}

main().catch((e) => {
  console.error('[share-auth] Error:', e);
  process.exit(1);
});
