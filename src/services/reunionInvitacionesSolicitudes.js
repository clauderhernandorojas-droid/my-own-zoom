const { ReunionInvitado, ReunionSolicitudAcceso } = require('../models');

async function listarInvitadosPorReunion(reunionId) {
  if (!reunionId) return [];
  return ReunionInvitado.findAll({
    where: { reunionId },
    order: [['creadoEn', 'DESC']],
  });
}

async function crearInvitadoEnReunion({
  reunionId,
  email = null,
  tokenInvitacion = null,
  invitadoPorUsuarioId,
}) {
  return ReunionInvitado.create({
    reunionId,
    email,
    tokenInvitacion,
    invitadoPorUsuarioId,
    estado: 'pendiente',
  });
}

/** Stub: revocación masiva o por criterio (p. ej. invalidar enlaces). */
async function revocarInvitacionesStub(_reunionId, _criterio = {}) {
  return { ok: true, afectadas: 0 };
}

async function listarSolicitudesPorReunion(reunionId, { soloPendientes = false } = {}) {
  if (!reunionId) return [];
  const where = { reunionId };
  if (soloPendientes) where.estado = 'pendiente';
  return ReunionSolicitudAcceso.findAll({
    where,
    order: [['creadoEn', 'DESC']],
  });
}

async function crearSolicitudAcceso({ reunionId, usuarioId }) {
  const existente = await ReunionSolicitudAcceso.findOne({
    where: { reunionId, usuarioId, estado: 'pendiente' },
  });
  if (existente) return existente;
  return ReunionSolicitudAcceso.create({
    reunionId,
    usuarioId,
    estado: 'pendiente',
  });
}

async function marcarSolicitudRespondida(solicitudId, { aprobada, respondidoPorUsuarioId }) {
  const row = await ReunionSolicitudAcceso.findByPk(solicitudId);
  if (!row) return null;
  row.estado = aprobada ? 'aprobada' : 'rechazada';
  row.respondidoPorUsuarioId = respondidoPorUsuarioId;
  await row.save();
  return row;
}

/** Stub: notificación por correo al invitado. */
async function enviarCorreoInvitacionStub(_reunionInvitadoId) {
  return { ok: false, razon: 'no_configurado' };
}

module.exports = {
  listarInvitadosPorReunion,
  crearInvitadoEnReunion,
  revocarInvitacionesStub,
  listarSolicitudesPorReunion,
  crearSolicitudAcceso,
  marcarSolicitudRespondida,
  enviarCorreoInvitacionStub,
};
