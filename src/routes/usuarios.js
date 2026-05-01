const express = require('express');
const { authRequired, loadUsuario } = require('../middleware/auth');

const router = express.Router();

router.get('/me', authRequired, loadUsuario, (req, res) => {
  res.json({ usuario: req.usuario.toJSON() });
});

module.exports = router;
