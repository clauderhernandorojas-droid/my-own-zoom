const express = require('express');
const { Op } = require('sequelize');
const { authRequired, loadUsuario } = require('../middleware/auth');
const { Reunion, Participa, Tablero, Usuario } = require('../models');
const { MAX_ESTUDIANTES, puedeUnirseParticipar } = require('../services/reunionParticipacion');

const router = express.Router();

router.use(authRequired, loadUsuario);

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
    const reunion = await Reunion.findOne({
      where: { roomId: req.params.roomId },
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
    const reunion = await Reunion.findOne({ where: { roomId: req.params.roomId } });
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

module.exports = router;
