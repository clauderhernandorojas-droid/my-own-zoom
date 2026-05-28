const { getMeetingOccurrencesInRange } = require('./reunionHorarioSolapamiento');
const { listarReunionesParaUsuario } = require('./reunionesListing');

function getReunionPk(reunion) {
  if (!reunion || typeof reunion !== 'object') return '';
  const pk = reunion.reunionId ?? reunion.reunion_id;
  return pk != null && String(pk).trim() !== '' ? String(pk).trim() : '';
}

function getNextMeetingOccurrence(reunion, fromDate = new Date()) {
  const horizon = new Date(fromDate.getTime() + 180 * 86400000);
  const occurrences = getMeetingOccurrencesInRange(reunion, fromDate, horizon);
  return occurrences.length ? occurrences[0] : null;
}

function enrichBucketItem(reunion, refDate) {
  const out = { ...reunion };
  if (refDate instanceof Date && !Number.isNaN(refDate.getTime())) {
    out._ref = refDate.toISOString();
    out._ts = refDate.getTime();
  }
  return out;
}

function selectMeetingsForBucket(all, mode, now) {
  const base = all || [];
  if (mode === 'upcoming') {
    return base
      .filter((r) => r?.fechaHora && r?.estado !== 'finalizada')
      .map((r) => {
        const next = getNextMeetingOccurrence(r, new Date(now - 10 * 60_000));
        return enrichBucketItem(r, next);
      })
      .filter((r) => Number.isFinite(r._ts))
      .sort((a, b) => a._ts - b._ts)
      .slice(0, 10);
  }

  const upcomingIds = new Set(
    selectMeetingsForBucket(all, 'upcoming', now).map((r) => getReunionPk(r))
  );
  const horizonStart = new Date(now - 180 * 86400000);
  const horizonEnd = new Date(now);
  return base
    .filter((r) => r?.fechaHora && !upcomingIds.has(getReunionPk(r)))
    .map((r) => {
      const occs = getMeetingOccurrencesInRange(r, horizonStart, horizonEnd) || [];
      const prev = occs.length ? occs[occs.length - 1] : null;
      return enrichBucketItem(r, prev);
    })
    .filter((r) => Number.isFinite(r._ts))
    .sort((a, b) => b._ts - a._ts)
    .slice(0, 10);
}

/**
 * Devuelve buckets de Acciones rápidas (≤10 próximas, ≤10 anteriores) para el usuario.
 *
 * @param {{ usuarioId: string, rol?: string }} usuario
 * @returns {Promise<{ proximas: object[], anteriores: object[] }>}
 */
async function buildMisBucketsForUsuario(usuario) {
  const all = await listarReunionesParaUsuario(usuario);
  const now = Date.now();
  return {
    proximas: selectMeetingsForBucket(all, 'upcoming', now),
    anteriores: selectMeetingsForBucket(all, 'past', now),
  };
}

module.exports = {
  buildMisBucketsForUsuario,
  _internals: { selectMeetingsForBucket, getNextMeetingOccurrence },
};
