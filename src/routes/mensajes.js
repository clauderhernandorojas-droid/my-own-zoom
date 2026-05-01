const express = require('express');
const { Op } = require('sequelize');
const { authRequired, loadUsuario } = require('../middleware/auth');
const { Mensaje, Participa, Reunion } = require('../models');

const router = express.Router();

router.use(authRequired, loadUsuario);

async function assertParticipa(reunionId, usuarioId) {
  return Participa.findOne({ where: { reunionId, usuarioId } });
}

router.get('/reunion/:reunionId', async (req, res, next) => {
  try {
    const { reunionId } = req.params;
    const desde = req.query.desde ? new Date(req.query.desde) : null;

    const reunion = await Reunion.findByPk(reunionId);
    if (!reunion) return res.status(404).json({ error: 'Reunión no encontrada' });

    const participa = await assertParticipa(reunionId, req.usuario.usuarioId);
    if (!participa && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reunión' });
    }

    const where = { reunionId };
    if (desde && !Number.isNaN(desde.getTime())) {
      where.marcaTiempo = { [Op.gte]: desde };
    }

    const mensajes = await Mensaje.findAll({
      where,
      order: [['marca_tiempo', 'ASC']],
      include: [
        { association: 'autor', attributes: ['usuarioId', 'nombre', 'email', 'rol'] },
        {
          association: 'destinatario',
          attributes: ['usuarioId', 'nombre', 'email', 'rol'],
          required: false,
        },
      ],
    });

    res.json({ mensajes });
  } catch (e) {
    next(e);
  }
});

router.post('/reunion/:reunionId', async (req, res, next) => {
  try {
    const { reunionId } = req.params;
    const { contenido, tipo, destinatarioUsuarioId } = req.body;

    if (!contenido || String(contenido).trim() === '') {
      return res.status(400).json({ error: 'contenido es obligatorio' });
    }

    const reunion = await Reunion.findByPk(reunionId, {
      include: [{ association: 'docente', attributes: ['usuarioId'] }],
    });
    if (!reunion) return res.status(404).json({ error: 'Reunión no encontrada' });

    const participa = await assertParticipa(reunionId, req.usuario.usuarioId);
    if (!participa && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No participas en esta reunión' });
    }

    const tipoMsg = tipo === 'privado' ? 'privado' : 'general';
    if (tipoMsg === 'privado') {
      const docenteId = reunion.docenteUsuarioId;
      const destinatario = destinatarioUsuarioId || docenteId;
      const esDocenteEnSala = participa?.rolEnReunion === 'docente' || req.usuario.usuarioId === docenteId;
      const enviaAEstudiante = esDocenteEnSala && destinatario !== req.usuario.usuarioId;
      const estudianteADocente =
        !esDocenteEnSala && destinatario === docenteId && req.usuario.usuarioId !== docenteId;
      if (!enviaAEstudiante && !estudianteADocente && req.usuario.rol !== 'admin') {
        return res.status(403).json({
          error: 'Chat privado: estudiante → docente o docente → estudiante con destinatario válido',
        });
      }
      const mensaje = await Mensaje.create({
        reunionId,
        usuarioId: req.usuario.usuarioId,
        tipo: 'privado',
        contenido: String(contenido).trim(),
        destinatarioUsuarioId: destinatario,
      });
      const full = await Mensaje.findByPk(mensaje.mensajeId, {
        include: [
          { association: 'autor', attributes: ['usuarioId', 'nombre', 'email', 'rol'] },
          { association: 'destinatario', attributes: ['usuarioId', 'nombre', 'email', 'rol'] },
        ],
      });
      return res.status(201).json({ mensaje: full });
    }

    const mensaje = await Mensaje.create({
      reunionId,
      usuarioId: req.usuario.usuarioId,
      tipo: 'general',
      contenido: String(contenido).trim(),
    });
    const full = await Mensaje.findByPk(mensaje.mensajeId, {
      include: [{ association: 'autor', attributes: ['usuarioId', 'nombre', 'email', 'rol'] }],
    });
    return res.status(201).json({ mensaje: full });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
