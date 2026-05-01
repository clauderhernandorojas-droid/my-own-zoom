const jwt = require('jsonwebtoken');
const { Usuario } = require('../models');

function getBearerToken(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7);
}

function authRequired(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

async function loadUsuario(req, res, next) {
  if (!req.userId) return next();
  try {
    const usuario = await Usuario.findByPk(req.userId);
    if (!usuario) return res.status(401).json({ error: 'Usuario no encontrado' });
    req.usuario = usuario;
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { getBearerToken, authRequired, loadUsuario };
