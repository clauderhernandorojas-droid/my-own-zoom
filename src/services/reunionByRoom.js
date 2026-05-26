const { Sequelize } = require('sequelize');
const { Reunion } = require('../models');

/**
 * Varias filas pueden compartir room_id (serie + excepciones). Para socket/API de sala
 * se usa la fila canónica: no excepción primero, luego la más antigua.
 *
 * Nota sobre el `order`: el atributo de timestamp del modelo se llama `creado_en`
 * (alias físico declarado en options con `createdAt: 'creado_en'`); no existe el
 * atributo `createdAt` en `Reunion.rawAttributes`. Usar `'createdAt'` aquí produce
 * `SQLITE_ERROR: no such column: Reunion.createdAt`.
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
      ['creado_en', 'ASC'],
    ],
  });
  return rows[0] || null;
}

module.exports = { findReunionByRoomKey };
