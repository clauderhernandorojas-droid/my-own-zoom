const { Reunion, ReunionOcurrencia } = require('../models');

/** Ancla de ocurrencia teórica de serie al segundo (coincide con el cliente `t_<ms>`). */
function normalizeOccurrenceMsAtSec(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return Math.floor(t.getTime() / 1000) * 1000;
}

function isUuidLike(s) {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim())
  );
}

const LEGACY_OLD_DATE_MATCH_MS = 120000;

/**
 * Clientes antiguos envían `oldDate`; se resuelve a `occurrenceId` (UUID de fila o `t_<ms>` teórico).
 * También intenta coincidir por `fechaOcurrenciaOverride` si oldDate era la hora efectiva reagendada.
 */
async function occurrenceIdFromLegacyOldDate(reunion, oldDate) {
  const oldD = oldDate instanceof Date ? oldDate : new Date(oldDate);
  if (Number.isNaN(oldD.getTime())) {
    return { ok: false, code: 'BAD_DATE', error: 'oldDate inválida' };
  }
  const rec = parseMeetingRecurrenceFromRow(reunion.recurrencia);
  if (!rec) {
    return { ok: false, code: 'NOT_SERIES', error: 'La reunión no tiene recurrencia' };
  }
  const rows = await ReunionOcurrencia.findAll({ where: { reunionId: reunion.reunionId } });
  const winStart = new Date(oldD.getTime() - 400 * 86400000);
  const winEnd = new Date(oldD.getTime() + 400 * 86400000);
  const occs = expandOccurrencesInRange(reunion, winStart, winEnd);
  const matched = occs.find((d) => Math.abs(d.getTime() - oldD.getTime()) <= LEGACY_OLD_DATE_MATCH_MS);
  if (matched) {
    const ms = normalizeOccurrenceMsAtSec(matched);
    const hit = rows.find((r) => normalizeOccurrenceMsAtSec(r.fechaOcurrenciaOriginal) === ms);
    if (hit?.reunionOcurrenciaId) {
      return { ok: true, occurrenceId: String(hit.reunionOcurrenciaId) };
    }
    return { ok: true, occurrenceId: `t_${ms}` };
  }
  for (const r of rows) {
    const ov = new Date(r.fechaOcurrenciaOverride);
    if (Number.isNaN(ov.getTime())) continue;
    if (Math.abs(ov.getTime() - oldD.getTime()) <= LEGACY_OLD_DATE_MATCH_MS && r.reunionOcurrenciaId) {
      return { ok: true, occurrenceId: String(r.reunionOcurrenciaId) };
    }
  }
  return {
    ok: false,
    code: 'OCCURRENCE_NOT_FOUND',
    error: 'No hay ninguna ocurrencia de la serie que coincida con oldDate',
  };
}

function normalizeRecurrence(raw) {
  if (!raw) return null;
  let rec = raw;
  if (typeof raw === 'string') {
    try {
      rec = JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (!rec || typeof rec !== 'object') return null;
  const mode = String(rec.mode || 'none').trim().toLowerCase();
  if (mode === 'none') return null;
  const until = rec.until ? String(rec.until).trim() : null;
  if (until) {
    const u = new Date(`${until}T23:59:59`);
    if (Number.isNaN(u.getTime())) return null;
  }
  if (mode === 'daily' || mode === 'weekly' || mode === 'monthly') {
    return { mode, interval: 1, until: until || null };
  }
  if (mode === 'custom') {
    const base = String(rec.base || 'weekly').trim().toLowerCase();
    const interval = Math.max(1, Number(rec.interval) || 1);
    const weekDays = Array.isArray(rec.weekDays)
      ? rec.weekDays.map((n) => Number(n)).filter((n) => n >= 1 && n <= 7)
      : [];
    return {
      mode: 'custom',
      base: ['daily', 'weekly', 'monthly'].includes(base) ? base : 'weekly',
      interval,
      weekDays,
      until: until || null,
    };
  }
  return null;
}

function weekdayIdFromDate(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

function addMonthsKeepClock(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months, 1);
  const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, maxDay));
  return d;
}

function parseMeetingRecurrenceFromRow(recRaw) {
  return normalizeRecurrence(recRaw);
}

/**
 * Expande ocurrencias de una reunión en [rangeStart, rangeEnd] (misma lógica que el cliente).
 * @param {import('sequelize').Model} reunion
 */
function expandOccurrencesInRange(reunion, rangeStart, rangeEnd) {
  if (!reunion?.fechaHora) return [];
  const start = new Date(reunion.fechaHora);
  if (Number.isNaN(start.getTime())) return [];
  const rec = parseMeetingRecurrenceFromRow(reunion.recurrencia);
  const untilDate = rec?.until ? new Date(`${rec.until}T23:59:59`) : null;
  const capEnd =
    untilDate && !Number.isNaN(untilDate.getTime()) && untilDate < rangeEnd ? untilDate : rangeEnd;
  if (!rec) {
    return start >= rangeStart && start <= capEnd ? [start] : [];
  }
  const out = [];
  const safetyMax = 700;
  if (rec.mode === 'daily' || (rec.mode === 'custom' && rec.base === 'daily')) {
    const interval = rec.interval || 1;
    let cur = new Date(start);
    let guard = 0;
    while (cur <= capEnd && guard++ < safetyMax) {
      if (cur >= rangeStart) out.push(new Date(cur));
      cur.setDate(cur.getDate() + interval);
    }
    return out;
  }
  if (rec.mode === 'monthly' || (rec.mode === 'custom' && rec.base === 'monthly')) {
    const interval = rec.interval || 1;
    let cur = new Date(start);
    let guard = 0;
    while (cur <= capEnd && guard++ < safetyMax) {
      if (cur >= rangeStart) out.push(new Date(cur));
      cur = addMonthsKeepClock(cur, interval);
    }
    return out;
  }
  const weekDays =
    rec.mode === 'weekly'
      ? [weekdayIdFromDate(start)]
      : rec.weekDays?.length
        ? rec.weekDays
        : [weekdayIdFromDate(start)];
  const interval = rec.interval || 1;
  let cur = new Date(Math.max(start.getTime(), rangeStart.getTime()));
  cur.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds());
  let guard = 0;
  while (cur <= capEnd && guard++ < 3500) {
    if (cur >= start) {
      const diffDays = Math.floor((cur - start) / 86400000);
      const weekSpan = Math.floor(diffDays / 7);
      if (weekSpan % interval === 0 && weekDays.includes(weekdayIdFromDate(cur))) {
        out.push(new Date(cur));
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/**
 * Reagenda una ocurrencia de una serie: guarda o actualiza excepción en `reunion_ocurrencias`.
 * @param {string} reunionId
 * @param {string} occurrenceId — `reunionOcurrenciaId` (UUID) o `t_<epochMs>` ancla al segundo de la ocurrencia teórica en la serie
 * @param {string|Date} newDate
 */
async function reagendarOcurrencia(reunionId, occurrenceId, newDate) {
  const reunion = await Reunion.findByPk(reunionId);
  if (!reunion) {
    return { ok: false, code: 'NOT_FOUND', error: 'Reunión no encontrada' };
  }

  const newD = newDate instanceof Date ? newDate : new Date(newDate);
  if (occurrenceId == null || String(occurrenceId).trim() === '' || Number.isNaN(newD.getTime())) {
    return {
      ok: false,
      code: 'BAD_REQUEST',
      error: 'occurrenceId y newDate son obligatorios; newDate debe ser una fecha válida',
    };
  }

  const rec = parseMeetingRecurrenceFromRow(reunion.recurrencia);
  if (!rec) {
    return { ok: false, code: 'NOT_SERIES', error: 'La reunión no tiene recurrencia (no es una serie)' };
  }

  const serieRoot = reunion.serieId || reunion.reunionId;
  const oid = String(occurrenceId).trim();

  if (isUuidLike(oid)) {
    const ex = await ReunionOcurrencia.findOne({
      where: { reunionOcurrenciaId: oid, reunionId: reunion.reunionId },
    });
    if (!ex) {
      return {
        ok: false,
        code: 'OCCURRENCE_NOT_FOUND',
        error: 'No existe la ocurrencia indicada (occurrenceId)',
      };
    }
    ex.fechaOcurrenciaOverride = newD;
    ex.serieId = serieRoot;
    await ex.save();
    const fechaOriginal = new Date(ex.fechaOcurrenciaOriginal).toISOString();
    const nuevaFecha = new Date(ex.fechaOcurrenciaOverride).toISOString();
    return { ok: true, reagendada: true, fechaOriginal, nuevaFecha, excepcion: ex, reunion };
  }

  const tMatch = /^t_(-?\d+)$/.exec(oid);
  if (!tMatch) {
    return {
      ok: false,
      code: 'BAD_OCCURRENCE_ID',
      error: 'occurrenceId debe ser el UUID de la excepción o t_<epochMs> de la ancla de serie',
    };
  }
  const targetMs = Number(tMatch[1]);
  if (!Number.isFinite(targetMs)) {
    return { ok: false, code: 'BAD_OCCURRENCE_ID', error: 'occurrenceId t_<epochMs> inválido' };
  }

  const rows = await ReunionOcurrencia.findAll({ where: { reunionId: reunion.reunionId } });
  let ex = rows.find((r) => normalizeOccurrenceMsAtSec(r.fechaOcurrenciaOriginal) === targetMs);

  if (ex) {
    ex.fechaOcurrenciaOverride = newD;
    ex.serieId = serieRoot;
    await ex.save();
  } else {
    const winStart = new Date(targetMs - 400 * 86400000);
    const winEnd = new Date(targetMs + 400 * 86400000);
    const occs = expandOccurrencesInRange(reunion, winStart, winEnd);
    const matched = occs.find((d) => normalizeOccurrenceMsAtSec(d) === targetMs);
    if (!matched) {
      return {
        ok: false,
        code: 'OCCURRENCE_NOT_FOUND',
        error: 'No hay ocurrencia de la serie con esa ancla (occurrenceId t_)',
      };
    }
    ex = await ReunionOcurrencia.create({
      reunionId: reunion.reunionId,
      fechaOcurrenciaOriginal: matched,
      fechaOcurrenciaOverride: newD,
      serieId: serieRoot,
    });
  }

  const fechaOriginal = new Date(ex.fechaOcurrenciaOriginal).toISOString();
  const nuevaFecha = new Date(ex.fechaOcurrenciaOverride).toISOString();
  return { ok: true, reagendada: true, fechaOriginal, nuevaFecha, excepcion: ex, reunion };
}

module.exports = {
  reagendarOcurrencia,
  expandOccurrencesInRange,
  occurrenceIdFromLegacyOldDate,
};
