/**
 * Validación Fase B (teacherPresenceMs / copresenceMs RAM) — log NDJSON + resumen consola.
 * Uso:
 *   # Terminales: 3001 flag off, 3002 flag on (npm start)
 *   node scripts/validate-phase-b-debug.cjs
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
const PORT_A = Number(process.env.PORT_A) || 3001;
const PORT_B = Number(process.env.PORT_B) || 3002;
const TEST_EMAIL = process.env.TEST_DOCENTE_EMAIL || 'clauderrojas@hotmail.com';
const TEST_PASSWORD = process.env.TEST_DOCENTE_PASSWORD || '123456';
const CMD_HINT =
  'node scripts/validate-phase-b-debug.cjs (servers: PORT=3001 ASISTENCIA_METRICAS_ENABLED=false npm start; PORT=3002 ASISTENCIA_METRICAS_ENABLED=true npm start)';

const results = [];

function logEntry(entry) {
  const line = JSON.stringify({
    sessionId: SESSION_ID,
    timestamp: Date.now(),
    reproduceCommand: CMD_HINT,
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
    const base = `http://127.0.0.1:${port}`;
    const u = new URL(urlPath, base);
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
  const row = { testId, scenario, pass, ...data };
  results.push(row);
  logEntry({
    type: 'test-result',
    testId,
    scenario,
    pass,
    assertions: data.assertions,
    request: data.request,
    response: data.response,
    snapshot: data.snapshot,
    error: data.error,
    stack: data.stack,
  });
  const mark = pass ? 'OK' : 'FAIL';
  console.log(`[phase-b] ${mark} ${testId} — ${scenario}`);
  if (data.observed) console.log('         ', JSON.stringify(data.observed));
  if (!pass && data.error) console.log('          ', data.error);
}

async function healthCheck(port) {
  const res = await httpRequest(port, 'GET', '/health');
  logEntry({ type: 'health', port, response: res.json, status: res.status });
  return res;
}

async function killPort(port) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`,
      { encoding: 'utf8' }
    ).trim();
    if (out && /^\d+$/.test(out)) {
      execSync(`powershell -NoProfile -Command "Stop-Process -Id ${out} -Force -ErrorAction SilentlyContinue"`);
      logEntry({ type: 'kill-port', port, pid: out });
      await sleep(1500);
    }
  } catch (_) {}
}

function startServerB() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PORT_B),
        ASISTENCIA_METRICAS_ENABLED: 'true',
        NODE_ENV: 'development',
        ASISTENCIA_COPRESENCIA_MS_MIN: process.env.ASISTENCIA_COPRESENCIA_MS_MIN || '3000',
      },
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    logEntry({ type: 'spawn-server-B', pid: child.pid, port: PORT_B });
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        const h = await healthCheck(PORT_B);
        if (h.status === 200 && h.json?.asistenciaMetricasEnabled === true) {
          resolve();
          return;
        }
      } catch (_) {}
      if (tries > 40) reject(new Error('Servidor B no respondió tras reinicio'));
      else setTimeout(tick, 500);
    };
    setTimeout(tick, 800);
  });
}

async function freshServerBForSocketTests() {
  await killPort(PORT_B);
  await startServerB();
}

async function login(port) {
  const res = await httpRequest(port, 'POST', '/api/auth/login', {
    body: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  logEntry({ type: 'login', port, status: res.status, hasToken: !!res.json?.token });
  if (res.status !== 200 || !res.json?.token) {
    throw new Error(`Login falló en puerto ${port}: ${res.status}`);
  }
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
  if (!estPart) throw new Error('No hay reunión con estudiante para pruebas');
  const docPart = await Participa.findOne({
    where: { reunionId: estPart.reunionId, rolEnReunion: 'docente' },
  });
  if (!docPart) throw new Error('No hay docente en la reunión');
  const reunion = estPart.Reunion || (await Reunion.findByPk(estPart.reunionId));
  return {
    reunion,
    docPart,
    estPart,
    inicioIso: copresenciaNormalize(reunion.fechaHora),
  };
}

function copresenciaNormalize(d) {
  const cop = require('../src/services/copresencia');
  return cop.normalizeInicioSesion(new Date(d)).toISOString();
}

async function fetchReporte(port, reunionId, token, query) {
  const qs = new URLSearchParams(query).toString();
  const path = `/api/reuniones/${reunionId}/asistencia/reporte?${qs}`;
  return httpRequest(port, 'GET', path, { token });
}

async function connectSocket(port, token) {
  const sock = io(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ['websocket'],
  });
  await new Promise((resolve, reject) => {
    sock.once('connect_error', reject);
    sock.once('connect', resolve);
  });
  return sock;
}

async function roomJoin(sock, roomId) {
  return new Promise((resolve) => {
    sock.emit('room:join', { roomId }, resolve);
  });
}

async function roomLeave(sock, roomId) {
  sock.emit('room:leave', { roomId });
  await sleep(400);
}

async function postEntrada(port, reunionId, token, meta) {
  return httpRequest(port, 'POST', `/api/reuniones/${reunionId}/asistencia/entrada`, {
    body: meta,
    token,
  });
}

async function postSalida(port, reunionId, token, meta) {
  return httpRequest(port, 'POST', `/api/reuniones/${reunionId}/asistencia/salida`, {
    body: meta,
    token,
  });
}

async function snapshotFromReporte(port, reunionId, token) {
  const res = await fetchReporte(port, reunionId, token, {
    metrics: 'session',
    live: '0',
  });
  const sess = res.json?.metrics?.session;
  const snap = sess
    ? {
        inicioSesion: sess.inicioSesion,
        teacherPresenceMs: sess.teacherPresenceMs,
        copresenceMs: sess.copresenceMs,
        acumuladoMs: sess.copresenceMs,
        umbralMs: sess.umbralMs,
        fulfilled: sess.fulfilled,
        teacherPresent: sess.teacherPresent,
        copresenceActive: sess.copresenceActive,
        source: sess.source,
      }
    : null;
  logEntry({
    type: 'snapshot-via-reporte',
    port,
    status: res.status,
    metricsEnabled: res.json?.metrics?.enabled,
    metricsIncluded: res.json?.metrics?.included,
    snapshot: snap,
  });
  return { res, snap };
}

async function runSocketScenario(port, ctx, scenarioId, steps) {
  const { reunion, docPart, estPart } = ctx;
  const roomId = reunion.roomId;
  const inicioIso = ctx.inicioIso;
  const meta = { inicioSesion: inicioIso };
  const tokDoc = signToken(docPart.usuarioId, 'docente');
  const tokEst = signToken(estPart.usuarioId, 'estudiante');
  const token = tokDoc;

  logEntry({ type: 'scenario-start', scenarioId, port, reunionId: reunion.reunionId, inicioIso });

  const snapshots = [];
  const snapBefore = await snapshotFromReporte(port, reunion.reunionId, token);
  snapshots.push({ label: 'before', ...snapBefore.snap });

  const socks = { docente: null, estudiante: null };

  for (const step of steps) {
    logEntry({ type: 'step', scenarioId, step: step.action });
    if (step.action === 'join-docente') {
      await postEntrada(port, reunion.reunionId, tokDoc, meta);
      socks.docente = await connectSocket(port, tokDoc);
      await roomJoin(socks.docente, roomId);
    } else if (step.action === 'join-estudiante') {
      await postEntrada(port, reunion.reunionId, tokEst, meta);
      socks.estudiante = await connectSocket(port, tokEst);
      await roomJoin(socks.estudiante, roomId);
    } else if (step.action === 'leave-estudiante' && socks.estudiante) {
      await roomLeave(socks.estudiante, roomId);
      await postSalida(port, reunion.reunionId, tokEst, meta);
      socks.estudiante.close();
      socks.estudiante = null;
    } else if (step.action === 'leave-docente' && socks.docente) {
      await roomLeave(socks.docente, roomId);
      await postSalida(port, reunion.reunionId, tokDoc, meta);
      socks.docente.close();
      socks.docente = null;
    } else if (step.action === 'wait') {
      await sleep(step.ms || 1000);
    }
    if (step.captureSnapshot) {
      const s = await snapshotFromReporte(port, reunion.reunionId, token);
      snapshots.push({ label: step.label || step.action, ...s.snap });
    }
  }

  if (socks.docente) {
    socks.docente.close();
  }
  if (socks.estudiante) {
    socks.estudiante.close();
  }

  const snapAfter = await snapshotFromReporte(port, reunion.reunionId, token);
  snapshots.push({ label: 'after', ...snapAfter.snap });

  return { snapshots, snapAfter, token };
}

async function main() {
  if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  logEntry({ type: 'run-start', message: 'Fase B validation', ports: { A: PORT_A, B: PORT_B } });

  console.log('[phase-b] Log:', LOG_PATH);
  console.log('[phase-b]', CMD_HINT);

  let ctx;
  try {
    const hA = await healthCheck(PORT_A);
    const hB = await healthCheck(PORT_B);
    record('health-A', 'preparación', hA.status === 200, {
      observed: hA.json,
      assertions: ['health 200'],
    });
    record('health-B', 'preparación', hB.status === 200, {
      observed: hB.json,
      assertions: ['health 200'],
    });
    if (hA.json?.asistenciaMetricasEnabled !== false) {
      record('health-A-flag', 'preparación', false, {
        error: 'Puerto 3001 debe tener asistenciaMetricasEnabled=false (reinicia servidor A)',
        observed: hA.json,
      });
    }
    if (hB.json?.asistenciaMetricasEnabled !== true) {
      record('health-B-flag', 'preparación', false, {
        error: 'Puerto 3002 debe tener asistenciaMetricasEnabled=true (reinicia servidor B)',
        observed: hB.json,
      });
    }

    ctx = await findReunionParticipants();
    logEntry({
      type: 'context',
      reunionId: ctx.reunion.reunionId,
      roomId: ctx.reunion.roomId,
      inicioIso: ctx.inicioIso,
    });

    const tokenA = await login(PORT_A);

    console.log('[phase-b] Reiniciando instancia B para RAM limpia (pruebas socket)…');
    await freshServerBForSocketTests();
    const tokenB = await login(PORT_B);

    // --- Escenario A: solo docente ---
    const runA = await runSocketScenario(PORT_B, ctx, 'A-solo-docente', [
      { action: 'join-docente' },
      { action: 'wait', ms: 2000 },
      { action: 'captureSnapshot', label: 'during-docente-only' },
      { action: 'leave-docente' },
    ]);
    const snapA = runA.snapAfter.snap || {};
    const passA =
      snapA && Number(snapA.teacherPresenceMs) > 0 && Number(snapA.copresenceMs) === 0;
    record('socket-A', 'A) solo docente', passA, {
      assertions: ['teacherPresenceMs>0', 'copresenceMs===0'],
      observed: snapA,
      snapshot: runA.snapshots,
    });

    // --- Escenario B: docente luego estudiante ---
    const runB = await runSocketScenario(PORT_B, ctx, 'B-docente-estudiante', [
      { action: 'join-docente' },
      { action: 'wait', ms: 1000 },
      { action: 'join-estudiante' },
      { action: 'wait', ms: 1000, captureSnapshot: true, label: 'both-present' },
      { action: 'leave-estudiante' },
      { action: 'wait', ms: 1000 },
      { action: 'leave-docente' },
    ]);
    const snapB = runB.snapAfter.snap || {};
    const passB =
      snapB &&
      Number(snapB.teacherPresenceMs) >= 1000 &&
      Number(snapB.copresenceMs) >= 500;
    record('socket-B', 'B) docente luego estudiante', passB, {
      assertions: ['teacherPresenceMs>=1000', 'copresenceMs>=500'],
      observed: snapB,
      snapshot: runB.snapshots,
    });

    // --- Escenario C: estudiante antes docente ---
    const runC = await runSocketScenario(PORT_B, ctx, 'C-estudiante-docente', [
      { action: 'join-estudiante' },
      { action: 'wait', ms: 1000 },
      { action: 'join-docente' },
      { action: 'wait', ms: 1000, captureSnapshot: true, label: 'both-present' },
      { action: 'leave-estudiante' },
      { action: 'leave-docente' },
    ]);
    const snapC = runC.snapAfter.snap || {};
    const passC =
      snapC &&
      Number(snapC.copresenceMs) >= 500 &&
      Number(snapC.teacherPresenceMs) >= Number(snapC.copresenceMs);
    record('socket-C', 'C) estudiante antes docente', passC, {
      assertions: ['copresenceMs>=500', 'teacherPresenceMs>=copresenceMs'],
      observed: snapC,
      snapshot: runC.snapshots,
    });

    // --- HTTP instancia A flag off ---
    const repA = await fetchReporte(PORT_A, ctx.reunion.reunionId, tokenA, {
      metrics: 'session',
      live: '0',
    });
    const mA = repA.json?.metrics;
    const passAHttp =
      repA.status === 200 &&
      (mA == null || (mA.enabled === false && mA.included === false && !mA.session));
    record('http-A-session', 'API 3001 metrics=session flag off', passAHttp, {
      request: { port: PORT_A, metrics: 'session' },
      response: { status: repA.status, metrics: mA },
      assertions: ['200', 'metrics null o enabled/included false sin session'],
    });

    // --- HTTP instancia B flag on ---
    const repB = await fetchReporte(PORT_B, ctx.reunion.reunionId, tokenB, {
      metrics: 'session',
      live: '0',
    });
    const mB = repB.json?.metrics;
    const sB = mB?.session;
    const umbral = Number(sB?.umbralMs) || 0;
    const cpMs = Number(sB?.copresenceMs) || 0;
    const passBSession =
      repB.status === 200 &&
      mB?.enabled === true &&
      mB?.included === true &&
      sB?.source === 'ram' &&
      typeof sB?.teacherPresenceMs === 'number' &&
      typeof sB?.copresenceMs === 'number' &&
      (cpMs < umbral ? sB.fulfilled === false : sB.fulfilled === true || cpMs >= umbral);
    record('http-B-session', 'API 3002 metrics=session flag on', passBSession, {
      request: { port: PORT_B, metrics: 'session' },
      response: { status: repB.status, metrics: mB },
      observed: sB,
      assertions: ['enabled/included true', 'session.source=ram', 'fulfilled coherente'],
    });

    const repFull = await fetchReporte(PORT_B, ctx.reunion.reunionId, tokenB, {
      metrics: 'full',
      live: '0',
    });
    const mFull = repFull.json?.metrics;
    const passFull =
      repFull.status === 200 &&
      mFull?.session?.source === 'ram' &&
      Array.isArray(mFull?.participation?.chatByUser);
    record('http-B-full', 'API 3002 metrics=full', passFull, {
      request: { port: PORT_B, metrics: 'full' },
      response: {
        status: repFull.status,
        hasSession: !!mFull?.session,
        chatLen: mFull?.participation?.chatByUser?.length,
      },
      assertions: ['session + chatByUser array'],
    });

    const rep0 = await fetchReporte(PORT_B, ctx.reunion.reunionId, tokenB, {
      metrics: '0',
      live: '0',
    });
    const pass0 = rep0.status === 200 && rep0.json?.metrics == null;
    record('http-B-metrics-0', 'API 3002 metrics=0', pass0, {
      request: { port: PORT_B, metrics: '0' },
      response: { status: rep0.status, metrics: rep0.json?.metrics },
      assertions: ['metrics null'],
    });

    const repBase = await fetchReporte(PORT_B, ctx.reunion.reunionId, tokenB, { live: '0' });
    const passBase =
      repBase.status === 200 &&
      !!repBase.json?.basic &&
      !!repBase.json?.live;
    record('http-B-baseline', 'API 3002 sin metrics (regresión basic/live)', passBase, {
      response: {
        status: repBase.status,
        hasBasic: !!repBase.json?.basic,
        hasLive: !!repBase.json?.live,
      },
      assertions: ['basic y live presentes'],
    });
  } catch (e) {
    logEntry({ type: 'fatal', error: e.message, stack: e.stack });
    record('fatal', 'error general', false, { error: e.message, stack: e.stack });
  }

  const failed = results.filter((r) => !r.pass);
  logEntry({
    type: 'summary',
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results: results.map((r) => ({ testId: r.testId, pass: r.pass })),
  });

  console.log('\n========== RESUMEN FASE B ==========');
  console.log('Pruebas ejecutadas:', results.length);
  for (const r of results) {
    console.log(`  [${r.pass ? 'OK' : 'FAIL'}] ${r.testId} — ${r.scenario}`);
  }
  if (ctx) {
    const last = results.find((r) => r.testId === 'http-B-session');
    if (last?.observed) {
      console.log('\nValores clave (último metrics.session):');
      console.log('  teacherPresenceMs:', last.observed.teacherPresenceMs);
      console.log('  copresenceMs:', last.observed.copresenceMs);
      console.log('  fulfilled:', last.observed.fulfilled);
      console.log('  umbralMs:', last.observed.umbralMs);
    }
  }
  console.log('\nLog NDJSON:', LOG_PATH);
  if (failed.length) {
    console.log('\nRecomendaciones:');
    console.log('  - Reinicia servidores 3001/3002 con código actual y flags correctos.');
    console.log('  - ASISTENCIA_COPRESENCIA_MS_MIN bajo (p. ej. 3000) acelera pruebas de umbral.');
    console.log('  - Verifica reunion con fechaHora y participantes docente/estudiante en BD.');
    process.exit(1);
  }
  console.log('\nTodas las pruebas Fase B: OK');
}

main();
