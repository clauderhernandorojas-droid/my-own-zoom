/**
 * Composición de datos para reportes/impresión de asistencia (BD + snapshot en vivo opcional).
 * No duplica reglas de copresencia: delega en asistencia.js y copresencia.js.
 */

const { Reunion } = require('../models');
const { listarAsistenciaPorReunion, resumenAsistenciaStub } = require('./asistencia');
const copresencia = require('./copresencia');
const metricasParticipacion = require('./metricasParticipacion');

function parseIncludeLive(liveParam) {
  if (liveParam === undefined || liveParam === null || String(liveParam).trim() === '') {
    return true;
  }
  const s = String(liveParam).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'no') return false;
  return true;
}

/**
 * @param {string|undefined} metricsParam
 * @returns {'none'|'chat'|'session'|'full'}
 */
function parseMetricsMode(metricsParam) {
  if (metricsParam === undefined || metricsParam === null || String(metricsParam).trim() === '') {
    return 'none';
  }
  const s = String(metricsParam).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'no') return 'none';
  if (s === 'chat') return 'chat';
  if (s === 'session') return 'session';
  if (s === '1' || s === 'true' || s === 'full') return 'full';
  return 'none';
}

function resolveInicioSesionForReport(reunion, opts) {
  if (opts.inicioSesion) {
    return copresencia.normalizeInicioSesion(new Date(String(opts.inicioSesion)));
  }
  return copresencia.inicioSesionDesdeReunion(reunion);
}

function buildSessionMetricsFromSnapshot(snap) {
  if (!snap) {
    return {
      inicioSesion: null,
      teacherPresenceMs: 0,
      copresenceMs: 0,
      umbralMs: copresencia.getUmbralMs(),
      fulfilled: false,
      teacherPresent: false,
      copresenceActive: false,
      source: 'ram',
    };
  }
  return {
    inicioSesion: snap.inicioSesion ?? null,
    teacherPresenceMs: snap.teacherPresenceMs ?? 0,
    copresenceMs: snap.copresenceMs ?? snap.acumuladoMs ?? 0,
    umbralMs: snap.umbralMs ?? copresencia.getUmbralMs(),
    fulfilled: !!snap.fulfilled,
    teacherPresent: !!snap.teacherPresent,
    copresenceActive: !!snap.copresenceActive,
    source: 'ram',
  };
}

/**
 * @param {string} reunionId
 * @param {{ desde?: string, hasta?: string, inicioSesion?: string, live?: string|boolean, metrics?: string, includeLive?: boolean }} opts
 * @returns {Promise<object|null>} null si reunión no existe
 */
async function buildReporteAsistenciaPayload(reunionId, opts = {}) {
  const reunion = await Reunion.findByPk(reunionId);
  if (!reunion) return null;

  const rangeOpts = {
    desde: opts.desde || undefined,
    hasta: opts.hasta || undefined,
  };

  const asistencia = await listarAsistenciaPorReunion(reunion.reunionId, rangeOpts);
  const resumen = await resumenAsistenciaStub(reunion.reunionId, rangeOpts);

  const inicioSesion = resolveInicioSesionForReport(reunion, opts);

  const serverLiveOn = copresencia.isAsistenciaLiveEnabled();
  const wantLive = opts.includeLive !== false && parseIncludeLive(opts.live);

  let live = { enabled: serverLiveOn, snapshot: null, included: false };

  if (wantLive && serverLiveOn) {
    live.snapshot = inicioSesion
      ? copresencia.getSessionSnapshot(reunion.reunionId, inicioSesion)
      : null;
    live.included = true;
  }

  const metricsMode = parseMetricsMode(opts.metrics);
  const serverMetricsOn = metricasParticipacion.isAsistenciaMetricasEnabled();
  let metrics = null;

  if (metricsMode !== 'none') {
    const wantChat = metricsMode === 'chat' || metricsMode === 'full';
    const wantSession = metricsMode === 'session' || metricsMode === 'full';

    metrics = {
      enabled: serverMetricsOn,
      included: serverMetricsOn && (wantChat || wantSession),
      participation: {},
    };

    if (serverMetricsOn && wantSession) {
      const snap = inicioSesion
        ? copresencia.getSessionSnapshot(reunion.reunionId, inicioSesion)
        : null;
      metrics.session = buildSessionMetricsFromSnapshot(snap);
    }

    if (serverMetricsOn && wantChat) {
      const chatByUser = await metricasParticipacion.countMensajesPorReunion(reunion.reunionId, {
        desde: rangeOpts.desde,
        hasta: rangeOpts.hasta,
        inicioSesion: opts.inicioSesion,
      });
      metrics.participation.chatByUser = chatByUser;
    }
  }

  return {
    reunionId: reunion.reunionId,
    titulo: reunion.titulo != null ? String(reunion.titulo) : '',
    basic: { asistencia, resumen },
    live,
    metrics,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildReporteAsistenciaPayload,
  parseIncludeLive,
  parseMetricsMode,
  buildSessionMetricsFromSnapshot,
};
