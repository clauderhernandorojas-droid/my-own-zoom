/**
 * Métricas de participación para reportes (conteos agregados; sin contenido de mensajes).
 */

const { Op, fn, col } = require('sequelize');
const { Mensaje, Reunion } = require('../models');
const copresencia = require('./copresencia');

function isAsistenciaMetricasEnabled() {
  const raw = process.env.ASISTENCIA_METRICAS_ENABLED;
  if (raw == null || String(raw).trim() === '') return false;
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function sessionDurationMs(reunion) {
  if (!reunion) return 60 * 60 * 1000;
  const a = reunion.fechaHora && new Date(reunion.fechaHora);
  const b = reunion.fechaHoraFin && new Date(reunion.fechaHoraFin);
  if (a && b && !Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime()) && b > a) {
    return Math.max(15 * 60 * 1000, b.getTime() - a.getTime());
  }
  return 60 * 60 * 1000;
}

/**
 * Ventana efectiva: intersección de [inicioSesion, inicioSesion+duración] con opcional desde/hasta.
 */
function resolveMessageWindow(reunion, opts = {}) {
  let sessionStart = null;
  if (opts.inicioSesion) {
    sessionStart = copresencia.normalizeInicioSesion(new Date(String(opts.inicioSesion)));
  } else if (reunion?.fechaHora) {
    sessionStart = copresencia.inicioSesionDesdeReunion(reunion);
  }

  let start = sessionStart;
  let end = sessionStart ? new Date(sessionStart.getTime() + sessionDurationMs(reunion)) : null;

  if (opts.desde) {
    const d = new Date(opts.desde);
    if (!Number.isNaN(d.getTime())) {
      start = start ? new Date(Math.max(start.getTime(), d.getTime())) : d;
    }
  }
  if (opts.hasta) {
    const h = new Date(opts.hasta);
    if (!Number.isNaN(h.getTime())) {
      end = end ? new Date(Math.min(end.getTime(), h.getTime())) : h;
    }
  }

  if (!start && opts.desde) start = new Date(opts.desde);
  if (!end && opts.hasta) end = new Date(opts.hasta);

  if (start && end && start > end) return null;
  return start && end ? { start, end } : null;
}

/**
 * @param {string} reunionId
 * @param {{ desde?: string, hasta?: string, inicioSesion?: string }} opts
 * @returns {Promise<Array<{ userId: string, count: number }>>}
 */
async function countMensajesPorReunion(reunionId, opts = {}) {
  const reunion = await Reunion.findByPk(reunionId);
  if (!reunion) return [];

  const window = resolveMessageWindow(reunion, opts);
  if (!window) return [];

  const rows = await Mensaje.findAll({
    attributes: ['usuarioId', [fn('COUNT', col('mensaje_id')), 'count']],
    where: {
      reunionId: reunion.reunionId,
      marcaTiempo: {
        [Op.gte]: window.start,
        [Op.lte]: window.end,
      },
    },
    group: ['usuarioId'],
    raw: true,
  });

  return rows
    .map((r) => ({
      userId: String(r.usuarioId),
      count: Number(r.count) || 0,
    }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
}

module.exports = {
  isAsistenciaMetricasEnabled,
  countMensajesPorReunion,
  resolveMessageWindow,
  sessionDurationMs,
};
