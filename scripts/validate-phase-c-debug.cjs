/**
 * Validación Fase C — persistencia métricas sesión + reporte source db tras reinicio.
 * Uso: npm run validate:phase-c
 * (levanta servidor efímero en PORT_C con flags on si el puerto está libre)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const { Op } = require('sequelize');

const SESSION_ID = process.env.DEBUG_SESSION_ID || '966849';
const LOG_PATH = path.join(__dirname, '..', `debug-${SESSION_ID}.log`);
const PORT_C = Number(process.env.PORT_C) || 3003;
const TEST_EMAIL = process.env.TEST_DOCENTE_EMAIL || 'clauderrojas@hotmail.com';
const TEST_PASSWORD = process.env.TEST_DOCENTE_PASSWORD || '123456';

const results = [];

function logEntry(entry) {
  const line = JSON.stringify({
    sessionId: SESSION_ID,
    timestamp: Date.now(),
    reproduceCommand: 'npm run validate:phase-c',
    ...entry,
  });
  fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function signToken(usuarioId, rol) {
  return jwt.sign(
    { sub: String(usuarioId), rol },
    process.env.JWT_SECRET || 'dev_secret',
    { expiresIn: '2h' }
  );
}

function httpRequest(port, method, urlPath, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, `http://127.0.0.1:${port}`);
    const data = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(
      {
        hostname: u.hostname,
        port,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          let json = {};
          try {
            json = JSON.parse(buf || '{}');
          } catch (_) {
            json = { _raw: buf.slice(0, 800) };
          }
          resolve({ status: res.statusCode, json, port, method, path: urlPath });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function record(testId, scenario, pass, data) {
  results.push({ testId, scenario, pass, ...data });
  logEntry({ type: 'test-result', testId, scenario, pass, ...data });
  console.log(`[phase-c] ${pass ? 'OK' : 'FAIL'} ${testId} — ${scenario}`);
}

async function killPort(port) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`,
      { encoding: 'utf8' }
    ).trim();
    if (out && /^\d+$/.test(out)) {
      execSync(
        `powershell -NoProfile -Command "Stop-Process -Id ${out} -Force -ErrorAction SilentlyContinue"`
      );
      await sleep(1500);
    }
  } catch (_) {}
}

function startServerC() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PORT_C),
        ASISTENCIA_METRICAS_ENABLED: 'true',
        ASISTENCIA_PERSISTENCE_ENABLED: 'true',
        NODE_ENV: 'development',
        ASISTENCIA_COPRESENCIA_MS_MIN: process.env.ASISTENCIA_COPRESENCIA_MS_MIN || '2000',
      },
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    logEntry({ type: 'spawn-server-C', pid: child.pid, port: PORT_C });
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        const res = await httpRequest(PORT_C, 'GET', '/health');
        if (
          res.status === 200 &&
          res.json?.asistenciaMetricasEnabled === true &&
          res.json?.asistenciaPersistenceEnabled === true
        ) {
          resolve();
          return;
        }
      } catch (_) {}
      if (tries > 50) reject(new Error('Servidor C no respondió'));
      else setTimeout(tick, 500);
    };
    setTimeout(tick, 800);
  });
}

async function login(port) {
  const res = await httpRequest(port, 'POST', '/api/auth/login', {
    body: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  if (res.status !== 200 || !res.json?.token) throw new Error(`Login falló: ${res.status}`);
  return res.json.token;
}

async function findReunionParticipants() {
  const { Participa, Reunion } = require('../src/models');
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
  if (!estPart) throw new Error('No hay reunión con estudiante');
  const docPart = await Participa.findOne({
    where: { reunionId: estPart.reunionId, rolEnReunion: 'docente' },
  });
  if (!docPart) throw new Error('No hay docente');
  const reunion = estPart.Reunion || (await Reunion.findByPk(estPart.reunionId));
  const cop = require('../src/services/copresencia');
  const inicioIso = cop.normalizeInicioSesion(new Date(reunion.fechaHora)).toISOString();
  return { reunion, docPart, estPart, inicioIso };
}

async function connectSocket(port, token) {
  const sock = io(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'] });
  await new Promise((resolve, reject) => {
    sock.once('connect_error', reject);
    sock.once('connect', resolve);
  });
  return sock;
}

async function runFlushScenario() {
  const ctx = await findReunionParticipants();
  const { reunion, docPart, estPart, inicioIso } = ctx;
  const meta = { inicioSesion: inicioIso };
  const tokDoc = signToken(docPart.usuarioId, 'docente');
  const tokEst = signToken(estPart.usuarioId, 'estudiante');
  const roomId = reunion.roomId;

  await httpRequest(PORT_C, 'POST', `/api/reuniones/${reunion.reunionId}/asistencia/entrada`, {
    body: meta,
    token: tokDoc,
  });
  const sDoc = await connectSocket(PORT_C, tokDoc);
  await new Promise((r) => sDoc.emit('room:join', { roomId }, r));

  await httpRequest(PORT_C, 'POST', `/api/reuniones/${reunion.reunionId}/asistencia/entrada`, {
    body: meta,
    token: tokEst,
  });
  const sEst = await connectSocket(PORT_C, tokEst);
  await new Promise((r) => sEst.emit('room:join', { roomId }, r));

  await sleep(2500);

  sEst.emit('room:leave', { roomId });
  await httpRequest(PORT_C, 'POST', `/api/reuniones/${reunion.reunionId}/asistencia/salida`, {
    body: meta,
    token: tokEst,
  });
  sEst.close();

  sDoc.emit('room:leave', { roomId });
  await httpRequest(PORT_C, 'POST', `/api/reuniones/${reunion.reunionId}/asistencia/salida`, {
    body: meta,
    token: tokDoc,
  });
  sDoc.close();

  await sleep(800);

  const { ReunionAsistenciaMs } = require('../src/models');
  const cop = require('../src/services/copresencia');
  const inicioN = cop.normalizeInicioSesion(new Date(inicioIso));
  const rows = await ReunionAsistenciaMs.findAllForSession(reunion.reunionId, inicioN);

  record(
    'C1',
    'flush escribe filas en reunion_asistencia_ms',
    rows.length >= 1,
    { observed: { rowCount: rows.length } }
  );

  return { ctx, tokDoc, tokEst };
}

async function main() {
  if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  logEntry({ type: 'run-start', port: PORT_C });

  await killPort(PORT_C);
  await startServerC();

  let ctx;
  let tokDoc;
  try {
    const run = await runFlushScenario();
    ctx = run.ctx;
    tokDoc = run.tokDoc;

    const repRam = await httpRequest(
      PORT_C,
      'GET',
      `/api/reuniones/${ctx.reunion.reunionId}/asistencia/reporte?metrics=session&live=0`,
      { token: tokDoc }
    );
    const sessRam = repRam.json?.metrics?.session;
    record(
      'C2',
      'reporte con persistencia on puede ser ram o db antes de reinicio',
      !!sessRam && (sessRam.source === 'db' || sessRam.source === 'ram'),
      { observed: { source: sessRam?.source, copresenceMs: sessRam?.copresenceMs } }
    );

    await killPort(PORT_C);
    await startServerC();

    const repDb = await httpRequest(
      PORT_C,
      'GET',
      `/api/reuniones/${ctx.reunion.reunionId}/asistencia/reporte?metrics=session&live=0`,
      { token: tokDoc }
    );
    const sess = repDb.json?.metrics?.session;
    const persistedOk =
      sess?.source === 'db' &&
      typeof sess?.persistedAt === 'string' &&
      !Number.isNaN(Date.parse(sess.persistedAt));

    record('C3', 'tras reinicio source db + persistedAt', persistedOk, {
      observed: {
        source: sess?.source,
        persistedAt: sess?.persistedAt,
        selectedBy: sess?.selectedBy,
        copresenceMs: sess?.copresenceMs,
      },
    });

    record(
      'C4',
      'docente selectedBy cuando hay fila docente',
      sess?.selectedBy === 'docente' || sess?.selectedBy === 'requester',
      { observed: { selectedBy: sess?.selectedBy } }
    );

    const repZero = await httpRequest(
      PORT_C,
      'GET',
      `/api/reuniones/${ctx.reunion.reunionId}/asistencia/reporte?metrics=0`,
      { token: tokDoc }
    );
    record('C5', 'metrics=0 → null', repZero.json?.metrics == null, {
      observed: { metrics: repZero.json?.metrics },
    });
  } catch (e) {
    record('C0', 'error general', false, { error: e?.message || String(e), stack: e?.stack });
  }

  const ok = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  console.log(`\n[phase-c] ${ok} OK, ${fail} FAIL — log: ${LOG_PATH}`);
  logEntry({ type: 'run-end', ok, fail });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
