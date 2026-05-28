const { Op } = require('sequelize');
const {
  Reunion,
  Participa,
  Mensaje,
  MensajeReaccion,
  Tablero,
  ReunionOcurrencia,
  ReunionInvitado,
  ReunionSolicitudAcceso,
  ReunionAsistencia,
  ReunionAsistenciaMs,
} = require('../models');

async function destroyReunionCascade(reunionId) {
  const childRows = await Reunion.findAll({
    where: { parentReunionId: reunionId },
    attributes: ['reunionId'],
  });
  for (const child of childRows) {
    await destroyReunionCascade(child.reunionId);
  }

  const mids = (
    await Mensaje.findAll({ where: { reunionId }, attributes: ['mensajeId'] })
  ).map((m) => m.mensajeId);
  if (mids.length) {
    await MensajeReaccion.destroy({ where: { mensajeId: { [Op.in]: mids } } });
    await Mensaje.destroy({ where: { reunionId } });
  }
  await Participa.destroy({ where: { reunionId } });
  await Tablero.destroy({ where: { reunionId } });
  await ReunionOcurrencia.destroy({ where: { reunionId } });
  await ReunionInvitado.destroy({ where: { reunionId } });
  await ReunionSolicitudAcceso.destroy({ where: { reunionId } });
  await ReunionAsistencia.destroy({ where: { reunionId } });
  await ReunionAsistenciaMs.destroy({ where: { reunionId } });
  await Reunion.destroy({ where: { reunionId } });
}

/**
 * Elimina la reunión y todas sus dependencias en BD (hard-delete).
 *
 * @param {string} reunionId
 * @param {{ usuarioId: string, rol?: string }} usuario
 * @returns {Promise<{ ok: true, reunionId: string, destroyed: true } | { ok: false, status: number, error: string }>}
 */
async function eliminarReunionEnBd(reunionId, usuario) {
  const reunion = await Reunion.findByPk(reunionId);
  if (!reunion) {
    return { ok: false, status: 404, error: 'Reunión no encontrada' };
  }

  const isOwner = String(reunion.docenteUsuarioId) === String(usuario.usuarioId);
  const isAdmin = usuario.rol === 'admin';
  if (!isOwner && !isAdmin) {
    return { ok: false, status: 403, error: 'Solo el docente creador puede eliminar esta reunión' };
  }

  await destroyReunionCascade(reunion.reunionId);
  return { ok: true, reunionId: reunion.reunionId, destroyed: true };
}

module.exports = {
  destroyReunionCascade,
  eliminarReunionEnBd,
};
