const { Op } = require('sequelize');
const { Participa } = require('../models');

/** 1 docente (dueño de la reunión) + 5 estudiantes u otros participantes */
const MAX_ESTUDIANTES = 5;

/** @param {object} reunion instancia Sequelize Reunion (con reunionId, docenteUsuarioId) */
async function puedeUnirseParticipar(reunion, usuarioId) {
  const existente = await Participa.findOne({
    where: { reunionId: reunion.reunionId, usuarioId },
  });
  if (existente) {
    return { ok: true };
  }

  if (usuarioId === reunion.docenteUsuarioId) {
    return { ok: true };
  }

  const nEstudiantes = await Participa.count({
    where: {
      reunionId: reunion.reunionId,
      usuarioId: { [Op.ne]: reunion.docenteUsuarioId },
    },
  });

  if (nEstudiantes >= MAX_ESTUDIANTES) {
    return {
      ok: false,
      error:
        'La sala está completa (máximo 1 docente y 5 estudiantes).',
    };
  }

  return { ok: true };
}

module.exports = {
  MAX_ESTUDIANTES,
  puedeUnirseParticipar,
};
