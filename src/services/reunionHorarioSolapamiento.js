/**
 * Detección de solapamiento de intervalos [fechaHora, fechaHoraFin] para agenda del docente.
 * Expansión de RRULE alineada con public/index.html (getMeetingOccurrencesInRange).
 */

const { Op } = require('sequelize');
const { Reunion } = require('../models');

const CONFLICT_MESSAGE =
  'Conflicto de horario: Ya existe una sesión de esta serie en la fecha seleccionada';

function formatOverlapConflictMessage(blockingInterval) {
  const titulo =
    blockingInterval.titulo != null && String(blockingInterval.titulo).trim()
      ? String(blockingInterval.titulo).trim()
      : 'una clase';
  const endMs = blockingInterval.end;
  const d = new Date(endMs);
  const hora = Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  return `Conflicto de horario: Este espacio ya está ocupado por la clase "${titulo}" que termina a las ${hora}`;
}

function intervalsOverlap(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
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

/** Convención Opción B: excepción que solo omite un día de la serie (sin DDL nuevo). */
function parseOmitInstance(recRaw) {
  if (!recRaw) return false;
  let obj = recRaw;
  if (typeof recRaw === 'string') {
    try {
      obj = JSON.parse(recRaw);
    } catch (_) {
      return false;
    }
  }
  return !!(obj && typeof obj === 'object' && obj.omitInstance === true);
}

function parseMeetingRecurrence(recRaw) {
  if (!recRaw) return null;
  let obj = recRaw;
  if (typeof recRaw === 'string') {
    try {
      obj = JSON.parse(recRaw);
    } catch (_) {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.omitInstance === true) return null;
  const mode = String(obj.mode || 'none').toLowerCase();
  if (mode === 'none') return null;
  const base = String(obj.base || 'weekly').toLowerCase();
  const interval = Math.max(1, Number(obj.interval) || 1);
  const until = obj.until ? String(obj.until) : '';
  const weekDays = Array.isArray(obj.weekDays)
    ? obj.weekDays.map((n) => Number(n)).filter((n) => n >= 1 && n <= 7)
    : [];
  return { mode, base, interval, until, weekDays };
}

function formatOccurrenceDayKey(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function getMeetingOccurrencesInRange(reunion, rangeStart, rangeEnd) {
  const rawStart = reunion?.fechaHora ?? reunion?.fecha_hora;
  if (rawStart == null || rawStart === '') return [];
  const start = new Date(rawStart);
  if (Number.isNaN(start.getTime())) return [];
  const rec = parseMeetingRecurrence(reunion.recurrencia);
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

function durationMsFromReunion(row) {
  const s = row.fechaHora ? new Date(row.fechaHora) : null;
  const e = row.fechaHoraFin ? new Date(row.fechaHoraFin) : null;
  if (!s || !e || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 60 * 60 * 1000;
  const d = e.getTime() - s.getTime();
  return d > 0 ? d : 60 * 60 * 1000;
}

async function loadDocenteReuniones(docenteUsuarioId) {
  return Reunion.findAll({
    where: {
      docenteUsuarioId,
      estado: { [Op.ne]: 'finalizada' },
    },
  });
}

function buildBusyIntervals({
  rows,
  candidateStart,
  candidateEnd,
  excludeReunionId,
  mergeParentSubstitution,
}) {
  const intervals = [];
  const exclude = excludeReunionId != null ? String(excludeReunionId) : '';

  const rangePadMs = 3 * 86400000;
  const rangeStart = new Date(candidateStart.getTime() - rangePadMs);
  const rangeEnd = new Date(candidateEnd.getTime() + rangePadMs);

  const parents = rows.filter((r) => !r.esExcepcion);
  const exceptions = rows.filter((r) => r.esExcepcion);

  const substitutionKeysByParent = new Map();
  for (const ex of exceptions) {
    const pid = ex.parentReunionId != null ? String(ex.parentReunionId) : '';
    const ok = ex.occurrenceDayKey != null ? String(ex.occurrenceDayKey).trim() : '';
    if (!pid || !ok) continue;
    if (!substitutionKeysByParent.has(pid)) substitutionKeysByParent.set(pid, new Set());
    substitutionKeysByParent.get(pid).add(ok);
  }
  if (mergeParentSubstitution && mergeParentSubstitution.parentReunionId) {
    const pid = String(mergeParentSubstitution.parentReunionId);
    const keys = Array.isArray(mergeParentSubstitution.occurrenceDayKeys)
      ? mergeParentSubstitution.occurrenceDayKeys
      : [];
    if (!substitutionKeysByParent.has(pid)) substitutionKeysByParent.set(pid, new Set());
    const set = substitutionKeysByParent.get(pid);
    for (const k of keys) {
      const kk = k != null ? String(k).trim() : '';
      if (kk) set.add(kk);
    }
  }

  for (const ex of exceptions) {
    if (parseOmitInstance(ex.recurrencia)) continue;
    const id = ex.reunionId != null ? String(ex.reunionId) : '';
    if (exclude && id === exclude) continue;
    const fs = ex.fechaHora ? new Date(ex.fechaHora) : null;
    const fe = ex.fechaHoraFin ? new Date(ex.fechaHoraFin) : null;
    if (!fs || !fe || Number.isNaN(fs.getTime()) || Number.isNaN(fe.getTime())) continue;
    if (fe <= fs) continue;
    intervals.push({
      start: fs.getTime(),
      end: fe.getTime(),
      titulo: ex.titulo != null ? String(ex.titulo) : '',
    });
  }

  for (const parent of parents) {
    const pid = parent.reunionId != null ? String(parent.reunionId) : '';
    if (exclude && pid === exclude) continue;
    const rec = parseMeetingRecurrence(parent.recurrencia);
    const dur = durationMsFromReunion(parent);

    if (!rec) {
      const fs = parent.fechaHora ? new Date(parent.fechaHora) : null;
      const fe = parent.fechaHoraFin ? new Date(parent.fechaHoraFin) : null;
      if (!fs || !fe || Number.isNaN(fs.getTime()) || Number.isNaN(fe.getTime())) continue;
      if (fe <= fs) continue;
      intervals.push({
        start: fs.getTime(),
        end: fe.getTime(),
        titulo: parent.titulo != null ? String(parent.titulo) : '',
      });
      continue;
    }

    const occList = getMeetingOccurrencesInRange(parent, rangeStart, rangeEnd);
    const subSet = substitutionKeysByParent.get(pid) || new Set();

    for (const occ of occList) {
      const dayKey = formatOccurrenceDayKey(occ);
      if (subSet.has(dayKey)) continue;
      const occStart = occ.getTime();
      const occEnd = occStart + dur;
      intervals.push({
        start: occStart,
        end: occEnd,
        titulo: parent.titulo != null ? String(parent.titulo) : '',
      });
    }
  }

  return intervals;
}

/**
 * @returns {{ conflict: boolean, message?: string }}
 */
function assertNoScheduleConflictDocente({
  rows,
  start,
  end,
  excludeReunionId,
  serieLogId,
  mergeParentSubstitution,
}) {
  const intervals = buildBusyIntervals({
    rows,
    candidateStart: start,
    candidateEnd: end,
    excludeReunionId,
    mergeParentSubstitution,
  });
  const a0 = start.getTime();
  const a1 = end.getTime();
  for (const it of intervals) {
    if (intervalsOverlap(a0, a1, it.start, it.end)) {
      const serie = serieLogId != null ? String(serieLogId) : '';
      const fechaLegible = start.toISOString();
      console.log(
        `[Conflicto Detectado] Intento de solapamiento en Serie ${serie} para la fecha ${fechaLegible}`
      );
      return {
        conflict: true,
        message: formatOverlapConflictMessage(it),
      };
    }
  }
  return { conflict: false };
}

/**
 * Valida todas las ocurrencias de una serie (reunionLike con recurrencia JSON) frente a la agenda cargada.
 * Si no hay recurrencia, equivale a un solo intervalo [fechaHora, fechaHoraFin].
 */
function assertSeriesOccurrencesNoOverlap({ rows, reunionLike, excludeReunionId }) {
  const rawStart = reunionLike?.fechaHora ?? reunionLike?.fecha_hora;
  const start = rawStart ? new Date(rawStart) : null;
  if (!start || Number.isNaN(start.getTime())) return { conflict: false };
  const dur = durationMsFromReunion(reunionLike);
  const farEnd = new Date(start.getTime() + 400 * 86400000);
  const occs = getMeetingOccurrencesInRange(reunionLike, start, farEnd);
  if (!occs.length) return { conflict: false };

  const minT = occs[0].getTime();
  const maxT = occs[occs.length - 1].getTime();
  const padMs = 3 * 86400000;
  const busy = buildBusyIntervals({
    rows,
    candidateStart: new Date(minT - padMs),
    candidateEnd: new Date(maxT + dur + padMs),
    excludeReunionId,
    mergeParentSubstitution: null,
  });

  for (const occ of occs) {
    const a0 = occ.getTime();
    const a1 = a0 + dur;
    for (const it of busy) {
      if (intervalsOverlap(a0, a1, it.start, it.end)) {
        return { conflict: true, message: formatOverlapConflictMessage(it) };
      }
    }
  }
  return { conflict: false };
}

async function validateSeriesOccurrencesNoOverlap({ docenteUsuarioId, reunionLike, excludeReunionId }) {
  const rows = await loadDocenteReuniones(docenteUsuarioId);
  return assertSeriesOccurrencesNoOverlap({ rows, reunionLike, excludeReunionId });
}

async function validateNoOverlapForDocente({
  docenteUsuarioId,
  start,
  end,
  excludeReunionId,
  serieLogId,
  mergeParentSubstitution,
}) {
  const rows = await loadDocenteReuniones(docenteUsuarioId);
  return assertNoScheduleConflictDocente({
    rows,
    start,
    end,
    excludeReunionId,
    serieLogId,
    mergeParentSubstitution,
  });
}

module.exports = {
  intervalsOverlap,
  CONFLICT_MESSAGE,
  validateNoOverlapForDocente,
  assertNoScheduleConflictDocente,
  buildBusyIntervals,
  getMeetingOccurrencesInRange,
  parseMeetingRecurrence,
  parseOmitInstance,
  formatOccurrenceDayKey,
  validateSeriesOccurrencesNoOverlap,
  assertSeriesOccurrencesNoOverlap,
  formatOverlapConflictMessage,
};
