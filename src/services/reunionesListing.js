/**
 * Listado de reuniones por usuario.
 *
 * Cada rol obtiene un "scope" distinto:
 *   - admin     → todas las reuniones del sistema.
 *   - docente   → solo las reuniones que él creó (incluye finalizadas, para que
 *                 puedan inspeccionarse a posteriori en el calendario).
 *   - resto     → reuniones a las que está unido vía `Participa` (comportamiento
 *                 histórico necesario para estudiantes).
 *
 * La política vive en `src/utils/roles.js` (`getReunionScopeForUser`), de modo
 * que este servicio se limita a traducir el scope a la query Sequelize
 * correspondiente. El JSON de salida lo produce `reunionPresenter`.
 */

const { Reunion, Participa, ReunionOcurrencia } = require('../models');
const { getReunionScopeForUser } = require('../utils/roles');
const { reunionJsonWithReagenda } = require('./reunionPresenter');

const includeOcurrenciaExcepciones = {
  model: ReunionOcurrencia,
  as: 'ocurrenciaExcepciones',
  required: false,
};

async function listarTodas() {
  const rows = await Reunion.findAll({ include: [includeOcurrenciaExcepciones] });
  return rows.map(reunionJsonWithReagenda);
}

async function listarPropiasDeDocente(usuarioId) {
  const rows = await Reunion.findAll({
    where: { docenteUsuarioId: usuarioId },
    include: [includeOcurrenciaExcepciones],
  });
  return rows.map(reunionJsonWithReagenda);
}

async function listarParticipantes(usuarioId) {
  const participaciones = await Participa.findAll({
    where: { usuarioId },
    include: [
      {
        model: Reunion,
        required: true,
        include: [includeOcurrenciaExcepciones],
      },
    ],
  });
  const seen = new Set();
  const out = [];
  for (const p of participaciones) {
    const row = p.Reunion ?? p.reunion;
    if (!row) continue;
    const id = row.reunionId != null ? String(row.reunionId) : '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(reunionJsonWithReagenda(row));
  }
  return out;
}

/**
 * Devuelve la lista de reuniones que le corresponde ver al `usuario`, ya
 * serializada en el JSON que espera el cliente.
 *
 * @param {{ usuarioId: any, rol?: string }} usuario
 * @returns {Promise<object[]>}
 */
async function listarReunionesParaUsuario(usuario) {
  const scope = getReunionScopeForUser(usuario);
  if (scope === 'all') return listarTodas();
  if (scope === 'owned') return listarPropiasDeDocente(usuario.usuarioId);
  return listarParticipantes(usuario.usuarioId);
}

module.exports = {
  listarReunionesParaUsuario,
  // Exportados para tests/uso interno; no forman parte del contrato público.
  _internals: { listarTodas, listarPropiasDeDocente, listarParticipantes },
};
