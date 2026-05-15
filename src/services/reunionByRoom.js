const { Sequelize } = require('sequelize');
const { Reunion } = require('../models');

/**
 * Varias filas pueden compartir room_id (serie + excepciones). Para socket/API de sala
 * se usa la fila canónica: no excepción primero, luego la más antigua.
 */
async function findReunionByRoomKey(roomIdRaw) {
  const key = String(roomIdRaw || '')
    .trim()
    .toLowerCase();
  if (!key) return null;
  const rows = await Reunion.findAll({
    where: Sequelize.where(Sequelize.fn('lower', Sequelize.col('room_id')), key),
    order: [
      ['esExcepcion', 'ASC'],
      ['createdAt', 'ASC'],
    ],
  });
  return rows[0] || null;
}

module.exports = { findReunionByRoomKey };
