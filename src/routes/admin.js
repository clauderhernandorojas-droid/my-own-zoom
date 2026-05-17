const express = require('express');
const { Usuario } = require('../models');
const { authRequired, loadUsuario } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/requireAdmin');

const router = express.Router();

const VALID_ROLES = ['docente', 'estudiante', 'admin'];

router.get('/usuarios', authRequired, loadUsuario, requireAdmin, async (req, res, next) => {
  try {
    const rows = await Usuario.findAll({
      order: [['nombre', 'ASC']],
    });
    res.json({ usuarios: rows.map((u) => u.toJSON()) });
  } catch (e) {
    next(e);
  }
});

router.patch('/usuarios/:id/rol', authRequired, loadUsuario, requireAdmin, async (req, res, next) => {
  try {
    const usuarioId = String(req.params.id || '').trim();
    const rol = String(req.body?.rol || '').trim().toLowerCase();

    if (!usuarioId) {
      return res.status(400).json({ error: 'id requerido' });
    }
    if (!VALID_ROLES.includes(rol)) {
      return res.status(400).json({ error: 'rol inválido' });
    }

    const target = await Usuario.findByPk(usuarioId);
    if (!target) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (target.rol !== rol) {
      target.rol = rol;
      await target.save();
      console.info({
        action: 'changeRole',
        by: req.usuario.email,
        target: req.params.id,
        newRole: rol,
      });
    }

    return res.json({ ok: true, usuario: target.toJSON() });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
