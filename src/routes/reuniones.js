const express = require('express');
const fs = require('fs');
const multer = require('multer');
const { Op, Sequelize } = require('sequelize');
const { authRequired, loadUsuario } = require('../middleware/auth');
const {
  Reunion,
  Participa,
  Tablero,
  Usuario,
  Mensaje,
  MensajeReaccion,
  ReunionOcurrencia,
} = require('../models');
const { MAX_ESTUDIANTES, puedeUnirseParticipar } = require('../services/reunionParticipacion');
const { canManageReuniones } = require('../utils/roles');
const { findReunionByRoomKey } = require('../services/reunionByRoom');
const {
  validateNoOverlapForDocente,
  validateSeriesOccurrencesNoOverlap,
  CONFLICT_MESSAGE,
  durationMsFromReunion,
  getMeetingOccurrencesInRange,
  formatOccurrenceDayKey,
  parseOmitInstance,
} = require('../services/reunionHorarioSolapamiento');
const {
  MAX_BYTES,
  isAllowedExtension,
  reunionUploadDir,
  multerFilename,
  posixRelPath,
} = require('../services/chatAdjuntos');
const {
  listarAsistenciaPorReunion,
  registrarEntradaStub,
  registrarSalidaStub,
  resumenAsistenciaStub,
} = require('../services/asistencia');
const { reagendarOcurrencia, occurrenceIdFromLegacyOldDate } = require('../services/reuniones');
const { buildReporteAsistenciaPayload } = require('../services/reporteAsistencia');
const { reunionJsonWithReagenda } = require('../services/reunionPresenter');
const { listarReunionesParaUsuario } = require('../services/reunionesListing');

const router = express.Router();

router.use(authRequired, loadUsuario);

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

function recurrenceNormKey(raw) {
  const n = normalizeRecurrence(raw);
  return n == null ? '' : JSON.stringify(n);
}

function sameInstantOrBothNull(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const da = a instanceof Date ? a : new Date(a);
  const db = b instanceof Date ? b : new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return da.getTime() === db.getTime();
}

/** true si el PATCH no altera título, fechas, zona ni recurrencia respecto a la fila actual. */
function isAgendaPatchNoOp(reunion, { titulo, fechaHora, fechaHoraFin, zonaHoraria, recurrencia }) {
  if (String(reunion.titulo || '').trim() !== String(titulo || '').trim()) return false;
  const effStart =
    fechaHora !== undefined && fechaHora !== null && fechaHora !== ''
      ? new Date(fechaHora)
      : reunion.fechaHora
        ? new Date(reunion.fechaHora)
        : null;
  const oldStart = reunion.fechaHora ? new Date(reunion.fechaHora) : null;
  if (effStart && Number.isNaN(effStart.getTime())) return false;
  if (!sameInstantOrBothNull(effStart, oldStart)) return false;

  const effEnd =
    fechaHoraFin !== undefined && fechaHoraFin !== null && fechaHoraFin !== ''
      ? new Date(fechaHoraFin)
      : reunion.fechaHoraFin
        ? new Date(reunion.fechaHoraFin)
        : null;
  const oldEnd = reunion.fechaHoraFin ? new Date(reunion.fechaHoraFin) : null;
  if (effEnd && Number.isNaN(effEnd.getTime())) return false;
  if (!sameInstantOrBothNull(effEnd, oldEnd)) return false;

  const effZone = zonaHoraria !== undefined ? zonaHoraria || null : reunion.zonaHoraria ?? null;
  if (String(effZone || '') !== String((reunion.zonaHoraria ?? null) || '')) return false;

  const incomingRec = recurrencia !== undefined ? recurrencia : reunion.recurrencia;
  return recurrenceNormKey(incomingRec) === recurrenceNormKey(reunion.recurrencia);
}

async function destroyReunionCascade(reunionId) {
  const mids = (
    await Mensaje.findAll({ where: { reunionId }, attributes: ['mensajeId'] })
  ).map((m) => m.mensajeId);
  if (mids.length) {
    await MensajeReaccion.destroy({ where: { mensajeId: { [Op.in]: mids } } });
    await Mensaje.destroy({ where: { reunionId } });
  }
  await Participa.destroy({ where: { reunionId } });
  await Tablero.destroy({ where: { reunionId } });
  await Reunion.destroy({ where: { reunionId } });
}

const uploadChatAdjunto = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const roomKey = String(req.params.roomId || '')
        .trim()
        .toLowerCase();
      findReunionByRoomKey(roomKey)
        .then((reunion) => {
          if (!reunion) {
            cb(new Error('Sala no encontrada'));
            return;
          }
          req._chatAdjReunion = reunion;
          cb(null, reunionUploadDir(reunion.reunionId));
        })
        .catch((e) => cb(e));
    },
    filename(req, file, cb) {
      cb(null, multerFilename(file.originalname));
    },
  }),
  limits: { fileSize: MAX_BYTES },
  fileFilter(req, file, cb) {
    if (!isAllowedExtension(file.originalname)) {
      cb(new Error('Tipo de archivo no permitido'));
      return;
    }
    cb(null, true);
  },
});

router.post('/', async (req, res, next) => {
  try {
    if (!canManageReuniones(req.usuario)) {
      return res.status(403).json({ error: 'Solo docentes pueden crear reuniones' });
    }
    const { titulo, fechaHora, fechaHoraFin, zonaHoraria, recurrencia } = req.body;
    if (!titulo) return res.status(400).json({ error: 'titulo es obligatorio' });
    const startDate = fechaHora ? new Date(fechaHora) : null;
    const endDate = fechaHoraFin ? new Date(fechaHoraFin) : null;
    if (startDate && Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: 'fechaHora inv?lida' });
    }
    if (endDate && Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'fechaHoraFin inv?lida' });
    }
    if (startDate && endDate && endDate <= startDate) {
      return res.status(400).json({ error: 'fechaHoraFin debe ser posterior a fechaHora' });
    }
    const hasFutureSchedule = startDate && startDate.getTime() > Date.now() + 30_000;
    const recurrenceNorm = normalizeRecurrence(recurrencia);

    if (
      startDate &&
      endDate &&
      !Number.isNaN(startDate.getTime()) &&
      !Number.isNaN(endDate.getTime()) &&
      endDate > startDate
    ) {
      const overlapNew = await validateSeriesOccurrencesNoOverlap({
        docenteUsuarioId: req.usuario.usuarioId,
        reunionLike: {
          fechaHora: startDate,
          fechaHoraFin: endDate,
          recurrencia: recurrenceNorm ? JSON.stringify(recurrenceNorm) : null,
          titulo,
        },
        excludeReunionId: null,
      });
      if (overlapNew.conflict) {
        return res.status(409).json({ error: overlapNew.message || CONFLICT_MESSAGE });
      }
    }

    const reunion = await Reunion.create({
      titulo,
      fechaHora: startDate || null,
      fechaHoraFin: endDate || null,
      zonaHoraria: zonaHoraria || null,
      recurrencia: recurrenceNorm ? JSON.stringify(recurrenceNorm) : null,
      docenteUsuarioId: req.usuario.usuarioId,
      estado: hasFutureSchedule ? 'programada' : 'activa',
    });

    await Participa.create({
      usuarioId: req.usuario.usuarioId,
      reunionId: reunion.reunionId,
      rolEnReunion: 'docente',
    });

    await Tablero.create({
      reunionId: reunion.reunionId,
      contenido: { elementos: [] },
      ultimaEdicion: new Date(),
    });

    return res.status(201).json({ reunion });
  } catch (e) {
    const raw = String(e?.parent?.message || e?.original?.message || e?.message || '');
    if (/unique|UNIQUE|constraint/i.test(raw) && /room/i.test(raw)) {
      console.error('[POST /reuniones] Conflicto room_id:', raw);
      return res.status(409).json({
        error:
          'No se pudo crear la reunión: conflicto en sala (room_id). Reinicia el servidor para aplicar la migración SQLite o revisa índices únicos en room_id.',
      });
    }
    next(e);
  }
});

router.get('/mis', async (req, res, next) => {
  try {
    const reuniones = await listarReunionesParaUsuario(req.usuario);
    res.json({ reuniones });
  } catch (e) {
    next(e);
  }
});

/** Une por `room_id` (insensible a mayúsculas) o por PK `reunion_id`; misma validación de cupo que `POST /room/:roomId/unirse`. */
router.post('/unirse-con-token', async (req, res, next) => {
  try {
    const codigo = String(req.body?.codigo ?? req.body?.token ?? '').trim();
    if (!codigo) {
      return res.status(400).json({ error: 'Indica el código de invitación' });
    }
    let reunion = await findReunionByRoomKey(codigo);
    if (!reunion) reunion = await Reunion.findByPk(codigo);
    if (!reunion) {
      return res.status(404).json({ error: 'Código no reconocido' });
    }
    const roomKey = reunion.roomId != null ? String(reunion.roomId).trim() : '';
    if (!roomKey) {
      return res.status(404).json({ error: 'Código no reconocido' });
    }

    const existente = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (existente) {
      return res.status(200).json({
        participa: existente,
        reunionId: reunion.reunionId,
        roomId: roomKey,
      });
    }

    const cupo = await puedeUnirseParticipar(reunion, req.usuario.usuarioId);
    if (!cupo.ok) {
      return res.status(403).json({ error: cupo.error });
    }

    const row = await Participa.create({
      usuarioId: req.usuario.usuarioId,
      reunionId: reunion.reunionId,
      rolEnReunion: req.usuario.rol === 'docente' ? 'docente' : 'estudiante',
    });

    return res.status(201).json({
      participa: row,
      reunionId: reunion.reunionId,
      roomId: roomKey,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:reunionId/excepcion-ocurrencia', async (req, res, next) => {
  try {
    if (!canManageReuniones(req.usuario)) {
      return res.status(403).json({ error: 'Solo docentes pueden editar excepciones' });
    }
    let parent = await Reunion.findByPk(req.params.reunionId);
    if (!parent) return res.status(404).json({ error: 'Reunión no encontrada' });
    const requestedId = req.params.reunionId;
    if (parent.esExcepcion) {
      const masterId = parent.parentReunionId;
      if (!masterId) {
        return res.status(400).json({ error: 'Excepción sin reunión padre asociada' });
      }
      const master = await Reunion.findByPk(masterId);
      if (!master || master.esExcepcion) {
        return res.status(400).json({ error: 'La reunión padre no puede ser una excepción' });
      }
      parent = master;
    }
    if (!normalizeRecurrence(parent.recurrencia)) {
      return res.status(400).json({ error: 'Solo series recurrentes admiten excepciones por día' });
    }

    const isOwner = String(parent.docenteUsuarioId) === String(req.usuario.usuarioId);
    const isAdmin = req.usuario.rol === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Solo el docente creador puede crear excepciones' });
    }

    const { titulo, fechaHora, fechaHoraFin, zonaHoraria, occurrenceDayKey } = req.body || {};
    const dayKey = occurrenceDayKey != null ? String(occurrenceDayKey).trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      return res.status(400).json({ error: 'occurrenceDayKey debe ser YYYY-MM-DD' });
    }
    const startDate = fechaHora ? new Date(fechaHora) : null;
    const endDate = fechaHoraFin ? new Date(fechaHoraFin) : null;
    if (!startDate || Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: 'fechaHora inválida' });
    }
    if (!endDate || Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'fechaHoraFin inválida' });
    }
    if (endDate <= startDate) {
      return res.status(400).json({ error: 'fechaHoraFin debe ser posterior a fechaHora' });
    }

    const hasFutureSchedule = startDate.getTime() > Date.now() + 30_000;
    const serieKey = parent.serieId || parent.reunionId;

    let reunion = await Reunion.findOne({
      where: {
        parentReunionId: parent.reunionId,
        esExcepcion: true,
        occurrenceDayKey: dayKey,
      },
    });

    const overlapEx = await validateNoOverlapForDocente({
      docenteUsuarioId: parent.docenteUsuarioId,
      start: startDate,
      end: endDate,
      excludeReunionId: reunion ? reunion.reunionId : null,
      serieLogId: parent.serieId || parent.reunionId,
      mergeParentSubstitution: {
        parentReunionId: parent.reunionId,
        occurrenceDayKeys: [dayKey],
      },
    });
    if (overlapEx.conflict) {
      return res.status(409).json({ error: overlapEx.message || CONFLICT_MESSAGE });
    }

    console.log(`Detectada edición de instancia individual para la serie ${parent.reunionId}`);

    if (reunion) {
      reunion.titulo = titulo != null && String(titulo).trim() ? String(titulo).trim() : parent.titulo;
      reunion.fechaHora = startDate;
      reunion.fechaHoraFin = endDate;
      reunion.zonaHoraria = zonaHoraria != null ? zonaHoraria : parent.zonaHoraria;
      reunion.estado = hasFutureSchedule ? 'programada' : 'activa';
      await reunion.save();
      return res.json({ reunion });
    }

    reunion = await Reunion.create({
      titulo: titulo != null && String(titulo).trim() ? String(titulo).trim() : parent.titulo,
      fechaHora: startDate,
      fechaHoraFin: endDate,
      zonaHoraria: zonaHoraria != null ? zonaHoraria : parent.zonaHoraria,
      roomId: parent.roomId,
      docenteUsuarioId: parent.docenteUsuarioId,
      estado: hasFutureSchedule ? 'programada' : 'activa',
      recurrencia: null,
      serieId: serieKey,
      parentReunionId: parent.reunionId,
      esExcepcion: true,
      occurrenceDayKey: dayKey,
    });

    const participantesPadre = await Participa.findAll({ where: { reunionId: parent.reunionId } });
    for (const p of participantesPadre) {
      await Participa.create({
        usuarioId: p.usuarioId,
        reunionId: reunion.reunionId,
        rolEnReunion: p.rolEnReunion,
      });
    }

    await Tablero.create({
      reunionId: reunion.reunionId,
      contenido: { elementos: [] },
      ultimaEdicion: new Date(),
    });

    return res.status(201).json({ reunion });
  } catch (e) {
    next(e);
  }
});

/**
 * Omite una sola instancia de una serie recurrente (Opción B: fila excepción con recurrencia JSON
 * {"omitInstance":true}). No usa DELETE del padre — ese flujo finaliza toda la serie (estado).
 */
router.post('/:reunionId/omitir-ocurrencia', async (req, res, next) => {
  try {
    if (!canManageReuniones(req.usuario)) {
      return res.status(403).json({ error: 'Solo docentes pueden omitir ocurrencias' });
    }
    const parent = await Reunion.findByPk(req.params.reunionId);
    if (!parent) return res.status(404).json({ error: 'Reunión no encontrada' });
    if (parent.esExcepcion) {
      return res.status(400).json({ error: 'Solo la reunión padre de una serie admite omisión por día' });
    }
    if (!normalizeRecurrence(parent.recurrencia)) {
      return res.status(400).json({ error: 'Solo series recurrentes admiten omitir un día' });
    }

    const isOwner = String(parent.docenteUsuarioId) === String(req.usuario.usuarioId);
    const isAdmin = req.usuario.rol === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Solo el docente creador puede omitir ocurrencias' });
    }

    const { occurrenceDayKey } = req.body || {};
    const dayKey = occurrenceDayKey != null ? String(occurrenceDayKey).trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
      return res.status(400).json({ error: 'occurrenceDayKey debe ser YYYY-MM-DD' });
    }

    const existing = await Reunion.findOne({
      where: {
        parentReunionId: parent.reunionId,
        esExcepcion: true,
        occurrenceDayKey: dayKey,
      },
    });
    if (existing) {
      if (parseOmitInstance(existing.recurrencia)) {
        return res.json({ reunion: existing, idempotent: true });
      }
      return res.status(409).json({
        error:
          'Ya existe una excepción para esta fecha. Elimínala o edítala desde el calendario antes de omitir.',
      });
    }

    const rangeStart = new Date(`${dayKey}T00:00:00`);
    const rangeEnd = new Date(`${dayKey}T23:59:59.999`);
    const occs = getMeetingOccurrencesInRange(parent, rangeStart, rangeEnd);
    const occStart =
      occs.find((o) => formatOccurrenceDayKey(o) === dayKey) ||
      occs.find((o) => {
        const k = formatOccurrenceDayKey(o);
        return k === dayKey;
      });
    if (!occStart || Number.isNaN(occStart.getTime())) {
      return res.status(400).json({ error: 'Esa fecha no corresponde a una ocurrencia de esta serie.' });
    }

    const durMs = (() => {
      const s = parent.fechaHora ? new Date(parent.fechaHora) : null;
      const e = parent.fechaHoraFin ? new Date(parent.fechaHoraFin) : null;
      if (!s || !e || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 60 * 60 * 1000;
      const d = e.getTime() - s.getTime();
      return d > 0 ? d : 60 * 60 * 1000;
    })();
    const startDate = new Date(occStart.getTime());
    const endDate = new Date(occStart.getTime() + durMs);

    const serieKey = parent.serieId || parent.reunionId;
    const omitPayload = JSON.stringify({ omitInstance: true });

    const reunion = await Reunion.create({
      titulo: parent.titulo,
      fechaHora: startDate,
      fechaHoraFin: endDate,
      zonaHoraria: parent.zonaHoraria,
      roomId: parent.roomId,
      docenteUsuarioId: parent.docenteUsuarioId,
      estado: 'programada',
      recurrencia: omitPayload,
      serieId: serieKey,
      parentReunionId: parent.reunionId,
      esExcepcion: true,
      occurrenceDayKey: dayKey,
    });

    const participantesPadre = await Participa.findAll({ where: { reunionId: parent.reunionId } });
    for (const p of participantesPadre) {
      await Participa.create({
        usuarioId: p.usuarioId,
        reunionId: reunion.reunionId,
        rolEnReunion: p.rolEnReunion,
      });
    }

    await Tablero.create({
      reunionId: reunion.reunionId,
      contenido: { elementos: [] },
      ultimaEdicion: new Date(),
    });

    return res.status(201).json({ reunion });
  } catch (e) {
    next(e);
  }
});

router.patch('/:reunionId', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const isOwner = String(reunion.docenteUsuarioId) === String(req.usuario.usuarioId);
    const isAdmin = req.usuario.rol === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Solo el docente creador puede editar esta reuni?n' });
    }

    const { titulo, fechaHora, fechaHoraFin, zonaHoraria, recurrencia } = req.body || {};
    if (!titulo || !String(titulo).trim()) {
      return res.status(400).json({ error: 'titulo es obligatorio' });
    }
    const startDate = fechaHora ? new Date(fechaHora) : null;
    const endDate = fechaHoraFin ? new Date(fechaHoraFin) : null;
    if (startDate && Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: 'fechaHora inv?lida' });
    }
    if (endDate && Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'fechaHoraFin inv?lida' });
    }
    if (startDate && endDate && endDate <= startDate) {
      return res.status(400).json({ error: 'fechaHoraFin debe ser posterior a fechaHora' });
    }
    const patchNoOp = isAgendaPatchNoOp(reunion, {
      titulo,
      fechaHora,
      fechaHoraFin,
      zonaHoraria,
      recurrencia,
    });
    if (
      !patchNoOp &&
      reunion.esExcepcion &&
      startDate &&
      endDate &&
      !Number.isNaN(startDate.getTime()) &&
      !Number.isNaN(endDate.getTime())
    ) {
      const serieLogId = reunion.serieId || reunion.parentReunionId || reunion.reunionId;
      const overlapPatch = await validateNoOverlapForDocente({
        docenteUsuarioId: reunion.docenteUsuarioId,
        start: startDate,
        end: endDate,
        excludeReunionId: reunion.reunionId,
        serieLogId,
      });
      if (overlapPatch.conflict) {
        return res.status(409).json({ error: overlapPatch.message || CONFLICT_MESSAGE });
      }
    }

    if (!patchNoOp && !reunion.esExcepcion) {
      const effectiveStart =
        startDate && !Number.isNaN(startDate.getTime())
          ? startDate
          : reunion.fechaHora
            ? new Date(reunion.fechaHora)
            : null;
      const effectiveEnd =
        endDate && !Number.isNaN(endDate.getTime())
          ? endDate
          : reunion.fechaHoraFin
            ? new Date(reunion.fechaHoraFin)
            : null;
      if (
        effectiveStart &&
        effectiveEnd &&
        !Number.isNaN(effectiveStart.getTime()) &&
        !Number.isNaN(effectiveEnd.getTime()) &&
        effectiveEnd > effectiveStart
      ) {
        let effectiveRecStr = reunion.recurrencia;
        if (recurrencia !== undefined) {
          const nr = normalizeRecurrence(recurrencia);
          effectiveRecStr = nr ? JSON.stringify(nr) : null;
        }
        const overlapParent = await validateSeriesOccurrencesNoOverlap({
          docenteUsuarioId: reunion.docenteUsuarioId,
          reunionLike: {
            fechaHora: effectiveStart,
            fechaHoraFin: effectiveEnd,
            recurrencia: effectiveRecStr,
            titulo: String(titulo).trim(),
          },
          excludeReunionId: reunion.reunionId,
        });
        if (overlapParent.conflict) {
          return res.status(409).json({ error: overlapParent.message || CONFLICT_MESSAGE });
        }
      }
    }

    const hasFutureSchedule = startDate && startDate.getTime() > Date.now() + 30_000;
    const recurrenceNorm = reunion.esExcepcion ? null : normalizeRecurrence(recurrencia);

    reunion.titulo = String(titulo).trim();
    reunion.fechaHora = startDate || null;
    reunion.fechaHoraFin = endDate || null;
    reunion.zonaHoraria = zonaHoraria || null;
    if (!reunion.esExcepcion) {
      reunion.recurrencia = recurrenceNorm ? JSON.stringify(recurrenceNorm) : null;
    }
    reunion.estado = hasFutureSchedule ? 'programada' : 'activa';
    await reunion.save();

    const reloaded = await Reunion.findByPk(req.params.reunionId, {
      include: [{ model: ReunionOcurrencia, as: 'ocurrenciaExcepciones', required: false }],
    });
    const lastEx = await ReunionOcurrencia.findOne({
      where: { reunionId: reunion.reunionId },
      order: [['actualizadoEn', 'DESC']],
    });
    const reunionOut = reunionJsonWithReagenda(reloaded);
    if (lastEx) {
      return res.json({
        reunion: reunionOut,
        reagendada: true,
        fechaOriginal: new Date(lastEx.fechaOcurrenciaOriginal).toISOString(),
        nuevaFecha: new Date(lastEx.fechaOcurrenciaOverride).toISOString(),
      });
    }
    return res.json({
      reunion: reunionOut,
      reagendada: false,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/:reunionId/reagendar', async (req, res, next) => {
  try {
    if (!canManageReuniones(req.usuario)) {
      return res.status(403).json({ error: 'Solo docentes pueden reagendar ocurrencias' });
    }
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const isOwner = String(reunion.docenteUsuarioId) === String(req.usuario.usuarioId);
    const isAdmin = req.usuario.rol === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Solo el docente creador puede reagendar esta serie' });
    }

    let { occurrenceId, newDate, oldDate } = req.body || {};
    if (newDate == null) {
      return res.status(400).json({ error: 'Se requiere newDate (ISO)' });
    }
    if (occurrenceId == null || String(occurrenceId).trim() === '') {
      if (oldDate == null) {
        return res.status(400).json({
          error:
            'Se requieren occurrenceId y newDate (ISO). Si usas un cliente antiguo, envía oldDate y newDate.',
        });
      }
      const leg = await occurrenceIdFromLegacyOldDate(reunion, oldDate);
      if (!leg.ok) {
        const st = leg.code === 'NOT_FOUND' ? 404 : 400;
        return res.status(st).json({ error: leg.error, code: leg.code });
      }
      occurrenceId = leg.occurrenceId;
    }

    const newD = new Date(newDate);
    if (Number.isNaN(newD.getTime())) {
      return res.status(400).json({ error: 'newDate inválida' });
    }
    const durMs = durationMsFromReunion(reunion);
    const endD = new Date(newD.getTime() + durMs);
    const origDayKeys = [];
    const oidTrim = String(occurrenceId).trim();
    const tMatch = /^t_(-?\d+)$/.exec(oidTrim);
    if (tMatch) {
      const origMs = Number(tMatch[1]);
      if (Number.isFinite(origMs)) {
        const dk = formatOccurrenceDayKey(new Date(origMs));
        if (dk) origDayKeys.push(dk);
      }
    } else {
      const exRow = await ReunionOcurrencia.findOne({
        where: { reunionOcurrenciaId: oidTrim, reunionId: reunion.reunionId },
      });
      if (exRow?.fechaOcurrenciaOriginal) {
        const dk = formatOccurrenceDayKey(exRow.fechaOcurrenciaOriginal);
        if (dk) origDayKeys.push(dk);
      }
    }
    const newDayKey = formatOccurrenceDayKey(newD);
    const substDayKeys = [...origDayKeys];
    if (newDayKey && !substDayKeys.includes(newDayKey)) substDayKeys.push(newDayKey);
    const overlapReag = await validateNoOverlapForDocente({
      docenteUsuarioId: reunion.docenteUsuarioId,
      start: newD,
      end: endD,
      excludeReunionId: null,
      serieLogId: reunion.serieId || reunion.reunionId,
      mergeParentSubstitution:
        substDayKeys.length > 0
          ? { parentReunionId: reunion.reunionId, occurrenceDayKeys: substDayKeys }
          : null,
    });
    if (overlapReag.conflict) {
      return res.status(409).json({ error: overlapReag.message || CONFLICT_MESSAGE });
    }

    const result = await reagendarOcurrencia(req.params.reunionId, occurrenceId, newDate);
    if (!result.ok) {
      const status = result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ error: result.error, code: result.code });
    }
    const reloaded = await Reunion.findByPk(req.params.reunionId, {
      include: [{ model: ReunionOcurrencia, as: 'ocurrenciaExcepciones', required: false }],
    });
    return res.status(200).json({
      ok: true,
      reagendada: true,
      fechaOriginal: result.fechaOriginal,
      nuevaFecha: result.nuevaFecha,
      excepcion: result.excepcion,
      reunion: reunionJsonWithReagenda(reloaded),
    });
  } catch (e) {
    next(e);
  }
});

router.delete('/:reunionId', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const isOwner = String(reunion.docenteUsuarioId) === String(req.usuario.usuarioId);
    const isAdmin = req.usuario.rol === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Solo el docente creador puede eliminar esta reuni?n' });
    }

    if (reunion.esExcepcion) {
      await destroyReunionCascade(reunion.reunionId);
      return res.json({ ok: true, reunionId: reunion.reunionId, destroyed: true });
    }

    reunion.estado = 'finalizada';
    reunion.fechaHoraFin = reunion.fechaHoraFin || new Date();
    await reunion.save();

    return res.json({ ok: true, reunionId: reunion.reunionId });
  } catch (e) {
    next(e);
  }
});

router.get('/room/:roomId', async (req, res, next) => {
  try {
    const roomKey = String(req.params.roomId || '')
      .trim()
      .toLowerCase();
    const reunion = await findReunionByRoomKey(roomKey);
    if (!reunion) return res.status(404).json({ error: 'Reunión no encontrada' });

    const reunionFull = await Reunion.findByPk(reunion.reunionId, {
      include: [
        { model: Usuario, as: 'docente', attributes: ['usuarioId', 'nombre', 'email', 'rol'] },
        { model: Tablero, as: 'tablero', required: false },
      ],
    });
    if (!reunionFull) return res.status(404).json({ error: 'Reunión no encontrada' });

    const participantes = await Participa.count({
      where: { reunionId: reunionFull.reunionId },
    });
    const estudiantes = await Participa.count({
      where: {
        reunionId: reunionFull.reunionId,
        usuarioId: { [Op.ne]: reunionFull.docenteUsuarioId },
      },
    });

    res.json({
      reunion: reunionFull,
      cupo: {
        participantes,
        estudiantes,
        maxEstudiantes: MAX_ESTUDIANTES,
        maxTotal: MAX_ESTUDIANTES + 1,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.get('/:reunionId', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId, {
      include: [
        { model: Usuario, as: 'docente', attributes: ['usuarioId', 'nombre', 'email', 'rol'] },
        { model: Tablero, as: 'tablero', required: false },
      ],
    });
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const soyParticipante = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (!soyParticipante && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reuni?n' });
    }
    res.json({ reunion });
  } catch (e) {
    next(e);
  }
});

router.get('/:reunionId/participantes', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const soyParticipante = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (!soyParticipante && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reuni?n' });
    }

    const rows = await Participa.findAll({
      where: { reunionId: reunion.reunionId },
      include: [
        {
          model: Usuario,
          attributes: ['usuarioId', 'nombre', 'email', 'rol'],
          required: true,
        },
      ],
    });

    const participantes = rows.map((r) => ({
      usuarioId: r.usuarioId,
      rolEnReunion: r.rolEnReunion,
      usuario: r.Usuario,
    }));

    res.json({ participantes });
  } catch (e) {
    next(e);
  }
});

router.get('/:reunionId/asistencia/reporte', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const soyParticipante = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (!soyParticipante && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reuni?n' });
    }

    const asRequester =
      req.query.asRequester === 'true' || req.query.asRequester === '1';
    const payload = await buildReporteAsistenciaPayload(reunion.reunionId, {
      desde: req.query.desde || undefined,
      hasta: req.query.hasta || undefined,
      inicioSesion: req.query.inicioSesion || undefined,
      live: req.query.live,
      metrics: req.query.metrics,
      requesterId: req.usuario.usuarioId,
      requesterRole: req.usuario.rol,
      asRequester,
      docenteUsuarioId: reunion.docenteUsuarioId,
    });
    if (!payload) return res.status(404).json({ error: 'Reuni?n no encontrada' });
    res.json(payload);
  } catch (e) {
    next(e);
  }
});

router.get('/:reunionId/asistencia/live', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const soyParticipante = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (!soyParticipante && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reuni?n' });
    }

    const copresencia = require('../services/copresencia');
    let inicioSesion = null;
    if (req.query.inicioSesion) {
      inicioSesion = copresencia.normalizeInicioSesion(new Date(String(req.query.inicioSesion)));
    } else {
      inicioSesion = copresencia.inicioSesionDesdeReunion(reunion);
    }
    const snapshot = inicioSesion
      ? copresencia.getSessionSnapshot(reunion.reunionId, inicioSesion)
      : null;
    res.json({
      liveEnabled: copresencia.isAsistenciaLiveEnabled(),
      reunionId: reunion.reunionId,
      snapshot,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/:reunionId/asistencia', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const soyParticipante = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (!soyParticipante && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reuni?n' });
    }

    const opts = {
      desde: req.query.desde || undefined,
      hasta: req.query.hasta || undefined,
    };
    const asistencia = await listarAsistenciaPorReunion(reunion.reunionId, opts);
    const resumen = await resumenAsistenciaStub(reunion.reunionId, opts);
    res.json({ asistencia, resumen });
  } catch (e) {
    next(e);
  }
});

router.post('/:reunionId/asistencia/entrada', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const soyParticipante = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (!soyParticipante && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reuni?n' });
    }

    const meta = req.body && typeof req.body === 'object' ? req.body : {};
    const registro = await registrarEntradaStub(reunion.reunionId, req.usuario.usuarioId, meta);
    res.status(201).json({ ok: true, registro });
  } catch (e) {
    next(e);
  }
});

router.post('/:reunionId/asistencia/salida', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const soyParticipante = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (!soyParticipante && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reuni?n' });
    }

    const meta = req.body && typeof req.body === 'object' ? req.body : {};
    const registro = await registrarSalidaStub(reunion.reunionId, req.usuario.usuarioId, meta);
    res.status(201).json({ ok: true, registro });
  } catch (e) {
    next(e);
  }
});

router.post('/:reunionId/unirse', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const existente = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (existente) {
      return res.status(200).json({ participa: existente });
    }

    const cupo = await puedeUnirseParticipar(reunion, req.usuario.usuarioId);
    if (!cupo.ok) {
      return res.status(403).json({ error: cupo.error });
    }

    const row = await Participa.create({
      usuarioId: req.usuario.usuarioId,
      reunionId: reunion.reunionId,
      rolEnReunion: req.usuario.rol === 'docente' ? 'docente' : 'estudiante',
    });

    return res.status(201).json({ participa: row });
  } catch (e) {
    next(e);
  }
});

router.post('/room/:roomId/unirse', async (req, res, next) => {
  try {
    const roomKey = String(req.params.roomId || '')
      .trim()
      .toLowerCase();
    const reunion = await findReunionByRoomKey(roomKey);
    if (!reunion) return res.status(404).json({ error: 'Reunión no encontrada' });

    const existente = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (existente) {
      return res.status(200).json({ participa: existente, reunionId: reunion.reunionId });
    }

    const cupo = await puedeUnirseParticipar(reunion, req.usuario.usuarioId);
    if (!cupo.ok) {
      return res.status(403).json({ error: cupo.error });
    }

    const row = await Participa.create({
      usuarioId: req.usuario.usuarioId,
      reunionId: reunion.reunionId,
      rolEnReunion: req.usuario.rol === 'docente' ? 'docente' : 'estudiante',
    });

    return res.status(201).json({ participa: row, reunionId: reunion.reunionId });
  } catch (e) {
    next(e);
  }
});

/** Sube un archivo al disco (sin crear fila en `mensajes`; el cliente env?a el mensaje por Socket con los metadatos). */
router.post('/room/:roomId/chat-adjunto', (req, res, next) => {
  uploadChatAdjunto.single('file')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Archivo demasiado grande (m?x. 20 MB)' });
      }
      return res.status(400).json({ error: err.message || 'Error al subir archivo' });
    }
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No se recibi? el archivo' });

      const roomKey = String(req.params.roomId || '')
        .trim()
        .toLowerCase();
      const reunion = req._chatAdjReunion || (await findReunionByRoomKey(roomKey));
      if (!reunion) {
        fs.unlink(file.path, () => {});
        return res.status(404).json({ error: 'Reuni?n no encontrada' });
      }

      const participa = await Participa.findOne({
        where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
      });
      if (!participa && req.usuario.rol !== 'admin') {
        fs.unlink(file.path, () => {});
        return res.status(403).json({ error: 'No participas en esta reuni?n' });
      }

      const rel = posixRelPath(reunion.reunionId, file.filename);
      return res.status(201).json({
        adjuntoRelPath: rel,
        adjuntoNombreOriginal: file.originalname,
        adjuntoMime: file.mimetype || null,
        adjuntoBytes: file.size,
      });
    } catch (e) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      next(e);
    }
  });
});

module.exports = router;
