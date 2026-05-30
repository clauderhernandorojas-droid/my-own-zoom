/**
 * Prueba copresencia con servidor en marcha:
 * - Comprueba umbral ASISTENCIA_COPRESENCIA_MS_MIN (vía copresencia.getUmbralMs).
 * - POST entrada docente + estudiante (filas BD para que calcularCopresencia actualice asistio).
 * - Dos sockets room:join, espera > umbral, room:leave.
 * - Imprime asistio en BD para cada fila.
 *
 * Uso: desde la raíz del proyecto, con `npm start` en otro terminal:
 *   node scripts/test-copresencia-socket.cjs
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { io } = require('socket.io-client');
const http = require('http');
const { Reunion, Participa, ReunionAsistencia } = require('../src/models');
const copresencia = require('../src/services/copresencia');

const PORT = Number(process.env.PORT) || 3000;
const BASE = `http://127.0.0.1:${PORT}`;

function signToken(usuarioId, rol) {
  return jwt.sign(
    { sub: String(usuarioId), rol },
    process.env.JWT_SECRET || 'dev_secret',
    { expiresIn: '2h' }
  );
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port) || PORT,
        path: u.pathname + u.search,
        method: 'GET',
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') });
          } catch (e) {
            reject(new Error(`JSON inválido: ${buf.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function httpPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(path, BASE);
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port) || PORT,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') });
          } catch (e) {
            reject(new Error(`JSON inválido: ${buf.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const um = copresencia.getUmbralMs();
  console.log('[test] Umbral copresencia (ms):', um, um === 30000 ? '← 30 s' : '');

  const health = await httpGet('/health');
  const srvUm = health.json?.copresenciaUmbralMs;
  console.log('[test] GET /health copresenciaUmbralMs (servidor):', srvUm);
  if (srvUm === undefined) {
    console.error(
      '[test] /health no incluye copresenciaUmbralMs. Reinicia el servidor con el server.js actual para validar el umbral antes de la espera de 30 s.'
    );
    process.exit(1);
  }
  if (Number(srvUm) !== um) {
    console.error(
      '[test] El servidor usa umbral',
      srvUm,
      'ms pero el script (dotenv) ve',
      um,
      'ms. Reinicia el servidor tras cambiar .env (ASISTENCIA_COPRESENCIA_MS_MIN).'
    );
    process.exit(1);
  }

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
    console.error('[test] No hay estudiante en reunión con fechaHora y roomId');
    process.exit(1);
  }
  const docPart = await Participa.findOne({
    where: { reunionId: estPart.reunionId, rolEnReunion: 'docente' },
  });
  if (!docPart) {
    console.error('[test] No hay docente en esa reunión');
    process.exit(1);
  }
  const reunion = estPart.Reunion || (await Reunion.findByPk(estPart.reunionId));
  const roomId = reunion.roomId;
  const inicioIso = new Date(reunion.fechaHora).toISOString();
  const tokDoc = signToken(docPart.usuarioId, 'docente');
  const tokEst = signToken(estPart.usuarioId, 'estudiante');

  console.log('[test] reunionId=', reunion.reunionId, 'roomId=', roomId);

  const meta = { inicioSesion: inicioIso };
  const r1 = await httpPost(`/api/reuniones/${reunion.reunionId}/asistencia/entrada`, meta, tokDoc);
  const r2 = await httpPost(`/api/reuniones/${reunion.reunionId}/asistencia/entrada`, meta, tokEst);
  console.log('[test] POST entrada docente status=', r1.status, r1.json?.error || '');
  console.log('[test] POST entrada estudiante status=', r2.status, r2.json?.error || '');
  if (r1.status >= 400 || r2.status >= 400) {
    console.error('[test] Falló entrada API; ¿servidor arrancado y datos válidos?');
    process.exit(1);
  }

  const sockDoc = io(BASE, { auth: { token: tokDoc }, transports: ['websocket'] });
  const sockEst = io(BASE, { auth: { token: tokEst }, transports: ['websocket'] });

  await new Promise((resolve, reject) => {
    let n = 0;
    const done = () => {
      n += 1;
      if (n === 2) resolve();
    };
    sockDoc.once('connect_error', reject);
    sockEst.once('connect_error', reject);
    sockDoc.once('connect', done);
    sockEst.once('connect', done);
  });
  console.log('[test] Sockets conectados');

  const ackDoc = await new Promise((resolve) => {
    sockDoc.emit('room:join', { roomId }, resolve);
  });
  if (!ackDoc?.ok) {
    console.error('[test] Docente room:join falló:', ackDoc);
    process.exit(1);
  }

  const ackEstBlocked = await new Promise((resolve) => {
    sockEst.emit('room:join', { roomId }, resolve);
  });
  if (ackEstBlocked?.ok !== false) {
    console.error('[test] Se esperaba rechazo de estudiante sin grant de sala de espera');
    process.exit(1);
  }
  console.log('[test] Estudiante rechazado sin grant (esperado):', ackEstBlocked?.error);

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
    console.error('[test] room:entry:response falló:', grantResp);
    process.exit(1);
  }

  const ackEst = await new Promise((resolve) => {
    sockEst.emit('room:join', { roomId }, resolve);
  });
  console.log('[test] ACK room:join docente', ackDoc);
  console.log('[test] ACK room:join estudiante', ackEst);
  if (!ackEst?.ok) {
    console.error('[test] Estudiante no pudo unirse tras grant');
    process.exit(1);
  }

  const waitMs = Math.max(um, 30000) + 2000;
  console.log('[test] Esperando', waitMs, 'ms (copresencia acumulada)…');
  await sleep(waitMs);

  sockDoc.emit('room:leave', { roomId });
  sockEst.emit('room:leave', { roomId });
  await sleep(800);

  sockDoc.close();
  sockEst.close();

  const inicioN = copresencia.normalizeInicioSesion(new Date(reunion.fechaHora));
  const rows = await ReunionAsistencia.findAll({
    where: { reunionId: reunion.reunionId, inicioSesion: inicioN },
  });
  console.log('[test] Filas ReunionAsistencia tras leave:');
  for (const row of rows) {
    console.log('  usuarioId=', row.usuarioId, 'asistio=', row.asistio, 'entradaAt=', !!row.entradaAt);
  }
  const estRow = rows.find((r) => String(r.usuarioId) === String(estPart.usuarioId));
  const okEst = estRow && estRow.asistio;
  console.log('[test] Estudiante asistio===true:', !!okEst, '(calendario verde usa asistencia en cliente)');
  if (!okEst) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
