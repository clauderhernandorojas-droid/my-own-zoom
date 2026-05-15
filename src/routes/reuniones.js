const express = require('express');
const fs = require('fs');
const multer = require('multer');
const { Op, Sequelize } = require('sequelize');
const { authRequired, loadUsuario } = require('../middleware/auth');
const { Reunion, Participa, Tablero, Usuario, ReunionOcurrencia } = require('../models');
const { MAX_ESTUDIANTES, puedeUnirseParticipar } = require('../services/reunionParticipacion');
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

/** Enriquece JSON de reunión con `reagendada` y metadatos legibles en cada excepción. */
function reunionJsonWithReagenda(reunion) {
  if (!reunion) return null;
  const j = typeof reunion.toJSON === 'function' ? reunion.toJSON() : { ...reunion };
  const ex = Array.isArray(j.ocurrenciaExcepciones) ? j.ocurrenciaExcepciones : [];
  j.reagendada = ex.length > 0;
  j.ocurrenciaExcepciones = ex.map((row) => {
    const o = { ...row };
    o.reagendada = true;
    o.fechaOriginal = o.fechaOcurrenciaOriginal ?? o.fecha_ocurrencia_original;
    o.nuevaFecha = o.fechaOcurrenciaOverride ?? o.fecha_ocurrencia_override;
    o.occurrenceId = o.reunionOcurrenciaId ?? o.reunion_ocurrencia_id ?? null;
    return o;
  });
  return j;
}

const uploadChatAdjunto = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const roomKey = String(req.params.roomId || '')
        .trim()
        .toLowerCase();
      Reunion.findOne({
        where: Sequelize.where(Sequelize.fn('lower', Sequelize.col('room_id')), roomKey),
      })
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
    if (req.usuario.rol !== 'docente' && req.usuario.rol !== 'admin') {
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
    next(e);
  }
});

router.get('/mis', async (req, res, next) => {
  try {
    const participaciones = await Participa.findAll({
      where: { usuarioId: req.usuario.usuarioId },
      include: [
        {
          model: Reunion,
          required: true,
          include: [
            {
              model: ReunionOcurrencia,
              as: 'ocurrenciaExcepciones',
              required: false,
            },
          ],
        },
      ],
    });
    const reuniones = participaciones.map((p) => reunionJsonWithReagenda(p.Reunion));
    res.json({ reuniones });
  } catch (e) {
    next(e);
  }
});

/** Une por `room_id` (insensible a may?sculas) o por PK `reunion_id`; misma validaci?n de cupo que `POST /room/:roomId/unirse`. */
router.post('/unirse-con-token', async (req, res, next) => {
  try {
    const codigo = String(req.body?.codigo ?? req.body?.token ?? '').trim();
    if (!codigo) {
      return res.status(400).json({ error: 'Indica el c?digo de invitaci?n' });
    }
    const roomKeyLower = codigo.toLowerCase();
    let reunion = await Reunion.findOne({
      where: Sequelize.where(Sequelize.fn('lower', Sequelize.col('room_id')), roomKeyLower),
    });
    if (!reunion) {
      reunion = await Reunion.findByPk(codigo);
    }
    if (!reunion) {
      return res.status(404).json({ error: 'C?digo no reconocido' });
    }
    const roomKey = reunion.roomId != null ? String(reunion.roomId).trim() : '';
    if (!roomKey) {
      return res.status(404).json({ error: 'C?digo no reconocido' });
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
    const hasFutureSchedule = startDate && startDate.getTime() > Date.now() + 30_000;
    const recurrenceNorm = normalizeRecurrence(recurrencia);

    reunion.titulo = String(titulo).trim();
    reunion.fechaHora = startDate || null;
    reunion.fechaHoraFin = endDate || null;
    reunion.zonaHoraria = zonaHoraria || null;
    reunion.recurrencia = recurrenceNorm ? JSON.stringify(recurrenceNorm) : null;
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
    if (req.usuario.rol !== 'docente' && req.usuario.rol !== 'admin') {
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
    const reunion = await Reunion.findOne({
      where: Sequelize.where(Sequelize.fn('lower', Sequelize.col('room_id')), roomKey),
      include: [
        { model: Usuario, as: 'docente', attributes: ['usuarioId', 'nombre', 'email', 'rol'] },
        { model: Tablero, as: 'tablero', required: false },
      ],
    });
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

    const participantes = await Participa.count({
      where: { reunionId: reunion.reunionId },
    });
    const estudiantes = await Participa.count({
      where: {
        reunionId: reunion.reunionId,
        usuarioId: { [Op.ne]: reunion.docenteUsuarioId },
      },
    });

    res.json({
      reunion,
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
    const reunion = await Reunion.findOne({
      where: Sequelize.where(Sequelize.fn('lower', Sequelize.col('room_id')), roomKey),
    });
    if (!reunion) return res.status(404).json({ error: 'Reuni?n no encontrada' });

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
      const reunion =
        req._chatAdjReunion ||
        (await Reunion.findOne({
          where: Sequelize.where(Sequelize.fn('lower', Sequelize.col('room_id')), roomKey),
        }));
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
