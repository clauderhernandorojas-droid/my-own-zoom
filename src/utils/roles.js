function normalizeRol(rol) {
  return String(rol || '').trim().toLowerCase();
}

/** Crear/editar/eliminar reuniones (misma regla que el lobby). */
function canManageReuniones(usuarioOrRol) {
  const r =
    usuarioOrRol != null && typeof usuarioOrRol === 'object'
      ? normalizeRol(usuarioOrRol.rol)
      : normalizeRol(usuarioOrRol);
  return r === 'docente' || r === 'admin';
}

module.exports = { normalizeRol, canManageReuniones };
