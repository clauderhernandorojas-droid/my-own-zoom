const express = require('express');
const authRoutes = require('./auth');
const usuariosRoutes = require('./usuarios');
const reunionesRoutes = require('./reuniones');
const mensajesRoutes = require('./mensajes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/usuarios', usuariosRoutes);
router.use('/reuniones', reunionesRoutes);
router.use('/mensajes', mensajesRoutes);

module.exports = router;
