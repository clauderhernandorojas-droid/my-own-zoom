const express = require('express');
const fs = require('fs');
const multer = require('multer');
const { Op, Sequelize } = require('sequelize');
const { authRequired, loadUsuario } = require('../middleware/auth');
const { Reunion, Participa, Tablero, Usuario } = require('../models');
const { MAX_ESTUDIANTES, puedeUnirseParticipar } = require('../services/reunionParticipacion');
const {
  MAX_BYTES,
  isAllowedExtension,
  reunionUploadDir,
  multerFilename,
  posixRelPath,
} = require('../services/chatAdjuntos');

const router = express.Router();

router.use(authRequired, loadUsuario);

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
    const { titulo, fechaHora, fechaHoraFin, zonaHoraria } = req.body;
    if (!titulo) return res.status(400).json({ error: 'titulo es obligatorio' });

    const reunion = await Reunion.create({
      titulo,
      fechaHora: fechaHora || null,
      fechaHoraFin: fechaHoraFin || null,
      zonaHoraria: zonaHoraria || null,
      docenteUsuarioId: req.usuario.usuarioId,
      estado: 'activa',
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
      include: [{ model: Reunion, required: true }],
    });
    const reuniones = participaciones.map((p) => p.Reunion);
    res.json({ reuniones });
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
    if (!reunion) return res.status(404).json({ error: 'Reunión no encontrada' });

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
    if (!reunion) return res.status(404).json({ error: 'Reunión no encontrada' });

    const soyParticipante = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (!soyParticipante && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reunión' });
    }
    res.json({ reunion });
  } catch (e) {
    next(e);
  }
});

router.get('/:reunionId/participantes', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reunión no encontrada' });

    const soyParticipante = await Participa.findOne({
      where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
    });
    if (!soyParticipante && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reunión' });
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

router.post('/:reunionId/unirse', async (req, res, next) => {
  try {
    const reunion = await Reunion.findByPk(req.params.reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reunión no encontrada' });

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

/** Sube un archivo al disco (sin crear fila en `mensajes`; el cliente envía el mensaje por Socket con los metadatos). */
router.post('/room/:roomId/chat-adjunto', (req, res, next) => {
  uploadChatAdjunto.single('file')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Archivo demasiado grande (máx. 20 MB)' });
      }
      return res.status(400).json({ error: err.message || 'Error al subir archivo' });
    }
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No se recibió el archivo' });

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
        return res.status(404).json({ error: 'Reunión no encontrada' });
      }

      const participa = await Participa.findOne({
        where: { reunionId: reunion.reunionId, usuarioId: req.usuario.usuarioId },
      });
      if (!participa && req.usuario.rol !== 'admin') {
        fs.unlink(file.path, () => {});
        return res.status(403).json({ error: 'No participas en esta reunión' });
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
