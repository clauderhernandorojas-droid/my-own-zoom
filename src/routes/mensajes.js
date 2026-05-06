const express = require('express');
const fs = require('fs');
const { Op } = require('sequelize');
const { authRequired, loadUsuario } = require('../middleware/auth');
const { Mensaje, Participa, Reunion } = require('../models');
const { adjuntoAbsoluteOrNull } = require('../services/chatAdjuntos');

const router = express.Router();

router.use(authRequired, loadUsuario);

router.get('/adjunto/:mensajeId', async (req, res, next) => {
  try {
    const { mensajeId } = req.params;
    const m = await Mensaje.findByPk(mensajeId);
    if (!m || !m.adjuntoRelPath) {
      return res.status(404).json({ error: 'Adjunto no encontrado' });
    }

    const participa = await assertParticipa(m.reunionId, req.usuario.usuarioId);
    if (!participa && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const abs = adjuntoAbsoluteOrNull(m.reunionId, m.adjuntoRelPath);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    res.setHeader('Content-Type', m.adjuntoMime || 'application/octet-stream');
    const name = m.adjuntoNombreOriginal || 'adjunto';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    next(e);
  }
});

async function assertParticipa(reunionId, usuarioId) {
  return Participa.findOne({ where: { reunionId, usuarioId } });
}

router.delete('/:mensajeId', async (req, res, next) => {
  try {
    const { mensajeId } = req.params;
    const m = await Mensaje.findByPk(mensajeId);
    if (!m) {
      return res.status(404).json({ error: 'Mensaje no encontrado' });
    }

    const participa = await assertParticipa(m.reunionId, req.usuario.usuarioId);
    if (!participa && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'No autorizado' });
    }
    const isAuthor =
      String(m.usuarioId || '').toLowerCase() === String(req.usuario.usuarioId || '').toLowerCase();
    if (!isAuthor && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'Solo el autor puede borrar el mensaje' });
    }

    if (m.adjuntoRelPath) {
      const abs = adjuntoAbsoluteOrNull(m.reunionId, m.adjuntoRelPath);
      if (abs && fs.existsSync(abs)) {
        try {
          fs.unlinkSync(abs);
        } catch (err) {
          console.warn('unlink adjunto chat', err);
        }
      }
    }

    const deletedId = m.mensajeId;
    const reunionId = m.reunionId;
    const tipoMsg = m.tipo;
    const destinatario = m.destinatarioUsuarioId;
    const authorUserId = m.usuarioId;
    await m.destroy();

    const io = req.app.get('io');
    if (io) {
      const reunion = await Reunion.findByPk(reunionId);
      if (reunion?.roomId) {
        const roomKey = String(reunion.roomId).trim().toLowerCase();
        const payload = { mensajeId: deletedId };
        if (tipoMsg === 'general') {
          io.to(roomKey).emit('chat:messageDeleted', payload);
        } else {
          const sockets = await io.fetchSockets();
          const targets = sockets.filter((s) => {
            const uid = s.data?.userId;
            if (!uid || !authorUserId || !destinatario) return false;
            const u = String(uid).trim().toLowerCase();
            return (
              u === String(authorUserId).trim().toLowerCase() ||
              u === String(destinatario).trim().toLowerCase()
            );
          });
          targets.forEach((s) => s.emit('chat:messageDeleted', payload));
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

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
