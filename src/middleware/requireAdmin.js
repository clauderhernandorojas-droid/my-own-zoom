function isAdmin(usuario) {
  return String(usuario?.rol || '').toLowerCase() === 'admin';
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.usuario)) {
    return res.status(403).json({ error: 'Solo administradores' });
  }
  return next();
}

module.exports = { requireAdmin, isAdmin };
