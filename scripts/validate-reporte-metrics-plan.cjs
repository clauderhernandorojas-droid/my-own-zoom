/**
 * Validación de métricas en reporte de asistencia (Fase A chat + Fase B sesión RAM).
 * Uso: node scripts/validate-reporte-metrics-plan.cjs
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const PORT = Number(process.env.VALIDATE_PORT || process.env.PORT) || 3001;
const BASE = `http://127.0.0.1:${PORT}`;

function signToken(usuarioId, rol) {
  return jwt.sign(
    { sub: String(usuarioId), rol },
    process.env.JWT_SECRET || 'dev_secret',
    { expiresIn: '2h' }
  );
}

function httpGetReporte(reunionId, query, token) {
  const qs = new URLSearchParams(query).toString();
  const p = `/api/reuniones/${reunionId}/asistencia/reporte${qs ? `?${qs}` : ''}`;
  return new Promise((resolve, reject) => {
    const u = new URL(p, BASE);
    const req = http.request(
      {
        hostname: u.hostname,
        port: Number(u.port) || PORT,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
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
            reject(new Error(`JSON inválido: ${buf.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function summarizePayload(json) {
  if (!json || typeof json !== 'object') return {};
  const m = json.metrics;
  return {
    topKeys: Object.keys(json),
    hasBasic: !!json.basic,
    live: json.live
      ? { enabled: json.live.enabled, included: json.live.included }
      : null,
    metrics: m
      ? {
          enabled: m.enabled,
          included: m.included,
          hasSession: !!m.session,
          sessionSource: m.session?.source,
          teacherPresenceMs: m.session?.teacherPresenceMs,
          copresenceMs: m.session?.copresenceMs,
          chatByUserLen: Array.isArray(m.participation?.chatByUser)
            ? m.participation.chatByUser.length
            : null,
          chatSample: Array.isArray(m.participation?.chatByUser)
            ? m.participation.chatByUser.slice(0, 2)
            : null,
        }
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

async function runPayloadWithEnv(envPatch, reunionId, query) {
  const saved = {};
  for (const [k, v] of Object.entries(envPatch)) {
    saved[k] = process.env[k];
    process.env[k] = String(v);
  }
  clearServiceCaches();
  const { buildReporteAsistenciaPayload } = require('../src/services/reporteAsistencia');
  let payload;
  try {
    payload = await buildReporteAsistenciaPayload(reunionId, {
      desde: query.desde,
      hasta: query.hasta,
      live: query.live,
      metrics: query.metrics,
    });
  } finally {
    for (const k of Object.keys(envPatch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearServiceCaches();
  }
  return summarizePayload(payload);
}

function testPrintModules() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'reporteAsistenciaPrint.js'),
    'utf8'
  );
  return {
    hasBuildMetricsHtml: /function buildMetricsHtml/.test(src),
    hasBuildSessionMetricsHtml: /function buildSessionMetricsHtml/.test(src),
    buildMetricsUsesMetrics: /reportPayload\?\.metrics/.test(src),
    hasBasicGuard: /reportPayload\?\.basic/.test(src),
  };
}

async function testCopresenciaTeacherMs() {
  clearServiceCaches();
  const cop = require('../src/services/copresencia');
  const reunionId = `test-reunion-phase-b-${Date.now()}`;
  const inicio = new Date('2026-05-10T15:00:00.000Z');
  cop.registrarEntrada('doc-1', reunionId, inicio, 'docente');
  const snapSolo = cop.getSessionSnapshot(reunionId, inicio);
  if (!(snapSolo.teacherPresenceMs > 0) || snapSolo.acumuladoMs !== 0) {
    throw new Error('docente solo: teacherPresenceMs>0 y acumuladoMs===0');
  }
  cop.registrarEntrada('est-1', reunionId, inicio, 'estudiante');
  const snapPar = cop.getSessionSnapshot(reunionId, inicio);
  if (!snapPar.copresenceActive || snapPar.copresenceMs < 0) {
    throw new Error('con estudiante: copresenceActive y copresenceMs válidos');
  }
  cop.registrarSalida('est-1', reunionId, inicio);
  cop.registrarSalida('doc-1', reunionId, inicio);
  const after = cop.getSessionSnapshot(reunionId, inicio);
  if (!(after.teacherPresenceMs > 0) || !(after.copresenceMs >= 0)) {
    throw new Error('tras salidas: acumulados deben persistir en RAM');
  }
}

async function findReunionAndToken() {
  const { Participa, Reunion } = require('../src/models');
  const part = await Participa.findOne({
    where: { rolEnReunion: 'docente' },
    include: [{ model: Reunion, required: true }],
  });
  if (!part) throw new Error('No hay participación docente');
  const reunion = part.Reunion || (await Reunion.findByPk(part.reunionId));
  return { reunionId: reunion.reunionId, token: signToken(part.usuarioId, 'docente') };
}

async function main() {
  const desde = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const hasta = new Date(new Date().getFullYear(), new Date().getMonth() + 2, 0, 23, 59, 59, 999).toISOString();
  const range = { desde, hasta };

  let health = {};
  try {
    health = await new Promise((resolve, reject) => {
      http
        .get(`${BASE}/health`, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(JSON.parse(b || '{}')));
        })
        .on('error', reject);
    });
    console.log('[validate] health', JSON.stringify(health));
  } catch (e) {
    console.error('[validate] Servidor no responde en', BASE);
    process.exit(1);
  }

  const { reunionId, token } = await findReunionAndToken();
  let failed = 0;

  const httpCases = [
    { id: 'metrics-0', query: { ...range, metrics: '0', live: '1' } },
    { id: 'metrics-chat', query: { ...range, metrics: 'chat', live: '1' } },
    { id: 'metrics-session', query: { ...range, metrics: 'session', live: '0' } },
    { id: 'metrics-full', query: { ...range, metrics: 'full', live: '0' } },
    { id: 'baseline', query: { ...range, live: '1' } },
  ];

  for (const c of httpCases) {
    const res = await httpGetReporte(reunionId, c.query, token);
    const summary = summarizePayload(res.json);
    console.log(`[validate] HTTP ${c.id}`, res.status, JSON.stringify(summary));
    if (c.id === 'metrics-0' && summary.metrics != null) {
      console.error('[validate] FAIL metrics=0 debe devolver metrics null');
      failed += 1;
    }
    if (c.id === 'metrics-session' && health.asistenciaMetricasEnabled) {
      if (summary.metrics == null) {
        console.warn(
          '[validate] skip HTTP metrics=session (servidor sin Fase B — reinicia npm start)'
        );
      } else if (!summary.metrics?.hasSession || summary.metrics.sessionSource !== 'ram') {
        console.error('[validate] FAIL metrics=session con flag on debe incluir session.source=ram');
        failed += 1;
      }
    }
    if (c.id === 'metrics-full' && health.asistenciaMetricasEnabled) {
      if (summary.metrics == null) {
        console.warn('[validate] skip HTTP metrics=full (servidor sin Fase B — reinicia npm start)');
      } else if (!summary.metrics?.hasSession) {
        console.warn('[validate] skip HTTP metrics=full session (servidor sin Fase B — reinicia npm start)');
      } else if (summary.metrics.chatByUserLen == null) {
        console.error('[validate] FAIL metrics=full debe incluir chatByUser array');
        failed += 1;
      }
    }
  }

  try {
    await testCopresenciaTeacherMs();
    console.log('[validate] copresencia teacherPresenceMs OK');
  } catch (e) {
    console.error('[validate] FAIL copresencia', e.message);
    failed += 1;
  }

  const chatOn = await runPayloadWithEnv(
    { ASISTENCIA_METRICAS_ENABLED: 'true' },
    reunionId,
    { ...range, metrics: 'chat', live: '0' }
  );
  console.log('[validate] env metrics on + chat', JSON.stringify(chatOn));
  if (!chatOn.metrics?.enabled || !chatOn.metrics?.included) {
    console.error('[validate] FAIL metrics=chat con flag on debe tener enabled/included true');
    failed += 1;
  }
  if (chatOn.metrics?.included && chatOn.metrics?.chatByUserLen == null) {
    console.error('[validate] FAIL chatByUser debe ser array cuando included=true');
    failed += 1;
  }
  if (chatOn.metrics?.hasSession) {
    console.error('[validate] FAIL metrics=chat no debe incluir session');
    failed += 1;
  }

  const sessionOn = await runPayloadWithEnv(
    { ASISTENCIA_METRICAS_ENABLED: 'true' },
    reunionId,
    { ...range, metrics: 'session', live: '0' }
  );
  console.log('[validate] env metrics on + session', JSON.stringify(sessionOn));
  if (!sessionOn.metrics?.hasSession || sessionOn.metrics.sessionSource !== 'ram') {
    console.error('[validate] FAIL metrics=session con flag on debe tener session ram');
    failed += 1;
  }
  if (sessionOn.metrics?.chatByUserLen != null) {
    console.error('[validate] FAIL metrics=session no debe poblar chatByUser');
    failed += 1;
  }

  const fullOn = await runPayloadWithEnv(
    { ASISTENCIA_METRICAS_ENABLED: 'true' },
    reunionId,
    { ...range, metrics: 'full', live: '0' }
  );
  console.log('[validate] env metrics on + full', JSON.stringify(fullOn));
  if (!fullOn.metrics?.hasSession || fullOn.metrics.chatByUserLen == null) {
    console.error('[validate] FAIL metrics=full debe tener session y chatByUser');
    failed += 1;
  }

  const chatOff = await runPayloadWithEnv(
    { ASISTENCIA_METRICAS_ENABLED: 'false' },
    reunionId,
    { ...range, metrics: 'chat', live: '0' }
  );
  console.log('[validate] env metrics off + chat', JSON.stringify(chatOff));
  if (chatOff.metrics?.enabled !== false || chatOff.metrics?.included !== false) {
    console.error('[validate] FAIL flag off debe tener enabled/included false');
    failed += 1;
  }

  const m0env = await runPayloadWithEnv(
    { ASISTENCIA_METRICAS_ENABLED: 'true' },
    reunionId,
    { ...range, metrics: '0', live: '0' }
  );
  if (m0env.metrics != null) {
    console.error('[validate] FAIL metrics=0 en builder debe ser null');
    failed += 1;
  }

  const printMods = testPrintModules();
  console.log('[validate] print modules', printMods);
  if (!printMods.hasBuildMetricsHtml) {
    console.error('[validate] FAIL falta buildMetricsHtml');
    failed += 1;
  }
  if (!printMods.hasBuildSessionMetricsHtml) {
    console.error('[validate] FAIL falta buildSessionMetricsHtml');
    failed += 1;
  }

  if (failed) {
    console.error(`\n[validate] ${failed} comprobación(es) fallida(s)`);
    process.exit(1);
  }
  console.log('\n[validate] OK — Fase A (chat) + Fase B (sesión RAM)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
