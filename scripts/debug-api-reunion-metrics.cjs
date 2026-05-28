/**
 * Pruebas API con login JWT + reporte métricas (modo DEBUG).
 * Uso: node scripts/debug-api-reunion-metrics.cjs
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const http = require('http');
const path = require('path');

const SESSION_ID = '966849';
const LOG_PATH = path.join(__dirname, '..', 'debug-966849.log');
const INGEST = 'http://127.0.0.1:7621/ingest/b0e5d29c-bc26-4f57-809a-14342a953be5';
const PORT = Number(process.env.VALIDATE_PORT || process.env.PORT) || 3001;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_EMAIL = process.env.TEST_DOCENTE_EMAIL || 'clauderrojas@hotmail.com';
const TEST_PASSWORD = process.env.TEST_DOCENTE_PASSWORD || '123456';

function debugLog(entry) {
  const line = JSON.stringify({
    sessionId: SESSION_ID,
    timestamp: Date.now(),
    runId: 'api-auto',
    ...entry,
  });
  fs.appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  fetch(INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION_ID },
    body: line,
  }).catch(() => {});
}

function httpJson(method, urlPath, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const data = body != null ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port) || PORT,
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
            json = { _raw: buf.slice(0, 500) };
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function summarizeReporte(json) {
  const m = json?.metrics;
  return {
    statusKeys: Object.keys(json || {}),
    metricsIsNull: m == null,
    metricsEnabled: m?.enabled,
    metricsIncluded: m?.included,
    hasSession: !!m?.session,
    sessionSource: m?.session?.source,
    teacherPresenceMs: m?.session?.teacherPresenceMs,
    copresenceMs: m?.session?.copresenceMs,
    chatByUserIsArray: Array.isArray(m?.participation?.chatByUser),
    chatByUserLen: Array.isArray(m?.participation?.chatByUser)
      ? m.participation.chatByUser.length
      : null,
  };
}

function clearServiceCaches() {
  const root = path.join(__dirname, '..');
  for (const mod of [
    'src/services/copresencia.js',
    'src/services/reporteAsistencia.js',
    'src/services/metricasParticipacion.js',
  ]) {
    try {
      delete require.cache[require.resolve(path.join(root, mod))];
    } catch (_) {}
  }
}

async function buildReporteWithEnv(envPatch, reunionId, query) {
  const saved = {};
  for (const [k, v] of Object.entries(envPatch)) {
    saved[k] = process.env[k];
    process.env[k] = String(v);
  }
  clearServiceCaches();
  const { buildReporteAsistenciaPayload } = require('../src/services/reporteAsistencia');
  let payload;
  try {
    payload = await buildReporteAsistenciaPayload(reunionId, query);
  } finally {
    for (const k of Object.keys(envPatch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearServiceCaches();
  }
  return payload;
}

async function main() {
  let failed = 0;
  const desde = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const hasta = new Date(new Date().getFullYear(), new Date().getMonth() + 2, 0, 23, 59, 59, 999).toISOString();
  const rangeQs = `desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`;

  console.log(`[api-test] BASE=${BASE} log=${LOG_PATH}`);

  const health = await httpJson('GET', '/health');
  console.log('[api-test] health', health.status, JSON.stringify(health.json));
  debugLog({
    location: 'debug-api-reunion-metrics.cjs:health',
    message: 'health',
    hypothesisId: 'H0',
    data: { status: health.status, body: health.json },
  });

  const login = await httpJson('POST', '/api/auth/login', {
    body: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  console.log('[api-test] login', login.status, login.json?.usuario?.rol, login.json?.usuario?.email);
  debugLog({
    location: 'debug-api-reunion-metrics.cjs:login',
    message: 'login',
    hypothesisId: 'H1',
    data: { status: login.status, rol: login.json?.usuario?.rol, hasToken: !!login.json?.token },
  });
  if (login.status !== 200 || !login.json?.token) {
    console.error('[api-test] FAIL login');
    process.exit(1);
  }
  const token = login.json.token;

  const cal = await httpJson('GET', '/api/reuniones/calendario', { token });
  const reunionId =
    cal.json?.reuniones?.[0]?.reunionId ||
    cal.json?.[0]?.reunionId ||
    '8c9714bb-2d97-43aa-a964-de58a4661065';
  console.log('[api-test] reunionId', reunionId);

  const reunionGet = await httpJson('GET', `/api/reuniones/${reunionId}`, { token });
  const reunionObj = reunionGet.json?.reunion || reunionGet.json;
  const tsOk =
    reunionGet.status === 200 &&
    reunionObj?.createdAt != null &&
    reunionObj?.updatedAt != null;
  console.log('[api-test] GET reunion', reunionGet.status, {
    createdAt: reunionObj?.createdAt,
    updatedAt: reunionObj?.updatedAt,
  });
  debugLog({
    location: 'debug-api-reunion-metrics.cjs:GET-reunion',
    message: 'GET reunion',
    hypothesisId: 'H2',
    data: {
      status: reunionGet.status,
      createdAt: reunionObj?.createdAt,
      updatedAt: reunionObj?.updatedAt,
      ok: tsOk,
    },
  });
  if (!tsOk) {
    console.error('[api-test] FAIL GET reunion — falta 200 o timestamps');
    failed += 1;
  }

  const cases = [
    { id: 'metrics-0', path: `/api/reuniones/${reunionId}/asistencia/reporte?${rangeQs}&metrics=0` },
    { id: 'baseline', path: `/api/reuniones/${reunionId}/asistencia/reporte?${rangeQs}` },
    { id: 'metrics-chat', path: `/api/reuniones/${reunionId}/asistencia/reporte?${rangeQs}&metrics=chat` },
    { id: 'metrics-session', path: `/api/reuniones/${reunionId}/asistencia/reporte?${rangeQs}&metrics=session` },
    { id: 'metrics-full', path: `/api/reuniones/${reunionId}/asistencia/reporte?${rangeQs}&metrics=full` },
  ];

  const httpSummaries = {};
  for (const c of cases) {
    const res = await httpJson('GET', c.path, { token });
    const summary = summarizeReporte(res.json);
    httpSummaries[c.id] = { status: res.status, ...summary };
    console.log(`[api-test] reporte ${c.id}`, res.status, JSON.stringify(summary));
    debugLog({
      location: 'debug-api-reunion-metrics.cjs:reporte',
      message: `reporte ${c.id}`,
      hypothesisId: 'H3',
      data: { caseId: c.id, status: res.status, ...summary },
    });
    if (res.status !== 200) {
      console.error(`[api-test] FAIL ${c.id} status ${res.status}`);
      failed += 1;
    }
    if (c.id === 'metrics-0' && summary.metricsIsNull !== true) {
      console.error('[api-test] FAIL metrics=0 debe tener metrics null');
      failed += 1;
    }
    if (c.id === 'baseline' && summary.metricsIsNull !== true) {
      console.error('[api-test] FAIL baseline debe tener metrics null');
      failed += 1;
    }
    if (c.id === 'metrics-chat' && !summary.chatByUserIsArray && health.json?.asistenciaMetricasEnabled) {
      console.error('[api-test] FAIL metrics=chat con flag on — falta chatByUser array');
      failed += 1;
    }
    if (c.id === 'metrics-session' && health.json?.asistenciaMetricasEnabled) {
      if (!summary.hasSession || summary.sessionSource !== 'ram') {
        console.error('[api-test] FAIL metrics=session — falta metrics.session source ram');
        failed += 1;
      }
    }
    if (c.id === 'metrics-full' && health.json?.asistenciaMetricasEnabled) {
      if (!summary.hasSession || !summary.chatByUserIsArray) {
        console.error('[api-test] FAIL metrics=full — falta session o chatByUser');
        failed += 1;
      }
    }
  }

  const serverFlagOn = !!health.json?.asistenciaMetricasEnabled;
  console.log('[api-test] servidor ASISTENCIA_METRICAS_ENABLED (health)', serverFlagOn);

  if (serverFlagOn) {
    if (httpSummaries['metrics-chat']?.metricsEnabled !== true) {
      console.error('[api-test] FAIL flag on HTTP — metrics.enabled debe ser true en chat');
      failed += 1;
    }
    if (!httpSummaries['metrics-chat']?.chatByUserIsArray) {
      console.error('[api-test] FAIL flag on HTTP — falta metrics.participation.chatByUser');
      failed += 1;
    }
    if (!httpSummaries['metrics-session']?.hasSession) {
      console.error('[api-test] FAIL flag on HTTP — metrics=session debe incluir session');
      failed += 1;
    }
  } else {
    // metrics=0 / baseline → null; metrics=chat con flag off → bloque metrics con enabled/included false
    if (httpSummaries['metrics-chat']?.metricsIsNull) {
      console.error('[api-test] FAIL flag off HTTP — metrics=chat debe incluir objeto metrics (no null)');
      failed += 1;
    } else if (httpSummaries['metrics-chat']?.metricsEnabled !== false) {
      console.error('[api-test] FAIL flag off HTTP — metrics.enabled debe ser false');
      failed += 1;
    }
  }

  const offPayload = await buildReporteWithEnv(
    { ASISTENCIA_METRICAS_ENABLED: 'false' },
    reunionId,
    { desde, hasta, metrics: 'chat', live: '0' }
  );
  const offSum = summarizeReporte(offPayload);
  console.log('[api-test] env flag OFF + metrics=chat', JSON.stringify(offSum));
  debugLog({
    location: 'debug-api-reunion-metrics.cjs:env-off',
    message: 'env ASISTENCIA_METRICAS_ENABLED=false',
    hypothesisId: 'H4',
    data: offSum,
  });
  if (offSum.metricsEnabled !== false || offSum.metricsIncluded !== false) {
    console.error('[api-test] FAIL env off — enabled/included deben ser false');
    failed += 1;
  }

  const onPayload = await buildReporteWithEnv(
    { ASISTENCIA_METRICAS_ENABLED: 'true' },
    reunionId,
    { desde, hasta, metrics: 'chat', live: '0' }
  );
  const onSum = summarizeReporte(onPayload);
  console.log('[api-test] env flag ON + metrics=chat', JSON.stringify(onSum));
  debugLog({
    location: 'debug-api-reunion-metrics.cjs:env-on',
    message: 'env ASISTENCIA_METRICAS_ENABLED=true',
    hypothesisId: 'H5',
    data: onSum,
  });
  if (onSum.metricsEnabled !== true || onSum.metricsIncluded !== true) {
    console.error('[api-test] FAIL env on — enabled/included deben ser true');
    failed += 1;
  }
  if (!onSum.chatByUserIsArray) {
    console.error('[api-test] FAIL env on — chatByUser debe ser array');
    failed += 1;
  }

  const m0Payload = await buildReporteWithEnv(
    { ASISTENCIA_METRICAS_ENABLED: 'true' },
    reunionId,
    { desde, hasta, metrics: '0', live: '0' }
  );
  if (m0Payload?.metrics != null) {
    console.error('[api-test] FAIL metrics=0 con cualquier flag — metrics debe ser null');
    failed += 1;
  } else {
    console.log('[api-test] env metrics=0 → metrics null OK');
  }

  debugLog({
    location: 'debug-api-reunion-metrics.cjs:summary',
    message: failed ? 'FAILED' : 'ALL_OK',
    hypothesisId: 'H6',
    data: { failed, serverFlagOn, httpSummaries },
  });

  if (failed) {
    console.error(`\n[api-test] ${failed} fallo(s)`);
    process.exit(1);
  }
  console.log('\n[api-test] OK — todas las comprobaciones pasaron');
}

main().catch((e) => {
  console.error('[api-test] error', e);
  debugLog({
    location: 'debug-api-reunion-metrics.cjs:fatal',
    message: String(e?.message || e),
    hypothesisId: 'ERR',
    data: { stack: e?.stack },
  });
  process.exit(1);
});
