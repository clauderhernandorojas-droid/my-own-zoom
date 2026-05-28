function normalizeRol(rol) {
  return String(rol || '').trim().toLowerCase();
}

function rolFromUsuarioOrRol(usuarioOrRol) {
  return usuarioOrRol != null && typeof usuarioOrRol === 'object'
    ? normalizeRol(usuarioOrRol.rol)
    : normalizeRol(usuarioOrRol);
}

/** Crear/editar/eliminar reuniones (misma regla que el lobby). */
function canManageReuniones(usuarioOrRol) {
  const r = rolFromUsuarioOrRol(usuarioOrRol);
  return r === 'docente' || r === 'admin';
}

/**
 * Devuelve el alcance del listado "Mis reuniones" según el rol del usuario.
 *  - 'all'           → ve todas las reuniones del sistema (admin).
 *  - 'owned'         → ve solo las que él creó (docente).
 *  - 'participating' → ve solo aquellas a las que está unido vía Participa (estudiante u otros).
 */
function getReunionScopeForUser(usuarioOrRol) {
  const r = rolFromUsuarioOrRol(usuarioOrRol);
  if (r === 'admin') return 'all';
  if (r === 'docente') return 'owned';
  return 'participating';
}

module.exports = { normalizeRol, canManageReuniones, getReunionScopeForUser };
