const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Usuario } = require('../models');

const router = express.Router();

function signToken(usuario) {
  return jwt.sign(
    { sub: usuario.usuarioId, rol: usuario.rol },
    process.env.JWT_SECRET || 'dev_secret',
    { expiresIn: '7d' }
  );
}

router.post('/register', async (req, res, next) => {
  try {
    const { nombre, email, password, rol } = req.body;
    if (!nombre || !email || !password) {
      return res.status(400).json({ error: 'nombre, email y password son obligatorios' });
    }
    const rolValido = ['docente', 'estudiante', 'admin'].includes(rol) ? rol : 'estudiante';
    const exists = await Usuario.findOne({ where: { email: email.toLowerCase() } });
    if (exists) return res.status(409).json({ error: 'Email ya registrado' });

    const contrasenaHasheada = await bcrypt.hash(password, 10);
    const usuario = await Usuario.create({
      nombre,
      email: email.toLowerCase(),
      contrasenaHasheada,
      rol: rolValido,
    });
    const token = signToken(usuario);
    return res.status(201).json({ usuario: usuario.toJSON(), token });
  } catch (e) {
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email y password son obligatorios' });
    }
    const usuario = await Usuario.findOne({ where: { email: email.toLowerCase() } });
    if (!usuario) return res.status(401).json({ error: 'Credenciales inválidas' });
    const ok = await bcrypt.compare(password, usuario.contrasenaHasheada);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });
    const token = signToken(usuario);
    return res.json({ usuario: usuario.toJSON(), token });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
