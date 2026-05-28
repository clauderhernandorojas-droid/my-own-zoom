const express = require('express');
const { Usuario } = require('../models');
const { authRequired, loadUsuario } = require('../middleware/auth');

const router = express.Router();

router.get('/me', authRequired, loadUsuario, (req, res) => {
  res.json({ usuario: req.usuario.toJSON() });
});

/** TEMPORAL (solo desarrollo): bootstrap del primer admin sin SQL. Eliminar tras usarlo. */
if (process.env.NODE_ENV !== 'production') {
  router.patch('/me/make-admin', authRequired, loadUsuario, async (req, res, next) => {
    try {
      const usuario = req.usuario;
      if (usuario.rol !== 'admin') {
        usuario.rol = 'admin';
        await usuario.save();
        console.info({
          action: 'makeAdminBootstrap',
          id: usuario.usuarioId,
          email: usuario.email,
        });
      }
      return res.json({ ok: true, id: usuario.usuarioId, rol: 'admin' });
    } catch (e) {
      next(e);
    }
  });
}

router.patch('/:usuarioId/rol', authRequired, loadUsuario, async (req, res, next) => {
  try {
    const actor = req.usuario;
    if (!actor || actor.rol !== 'admin') {
      return res.status(403).json({ error: 'Solo un admin puede cambiar roles' });
    }

    const usuarioId = String(req.params.usuarioId || '').trim();
    const nextRol = String(req.body?.rol || '').trim().toLowerCase();
    if (!usuarioId) {
      return res.status(400).json({ error: 'usuarioId requerido' });
    }
    if (!['docente', 'estudiante', 'admin'].includes(nextRol)) {
      return res.status(400).json({ error: 'rol inválido' });
    }

    const target = await Usuario.findByPk(usuarioId);
    if (!target) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const prevRol = target.rol;
    if (prevRol === nextRol) {
      return res.json({ ok: true, usuario: target.toJSON() });
    }

    target.rol = nextRol;
    await target.save();

    // Auditoría básica: quién cambió, a quién, y desde dónde.
    console.info(
      '[AUDIT] usuario:rol:update',
      JSON.stringify({
        at: new Date().toISOString(),
        actorUserId: actor.usuarioId,
        actorEmail: actor.email,
        targetUserId: target.usuarioId,
        targetEmail: target.email,
        fromRol: prevRol,
        toRol: nextRol,
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
      })
    );

    return res.json({ ok: true, usuario: target.toJSON() });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
