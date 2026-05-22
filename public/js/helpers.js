/**
 * Predicados de rol compartidos (sin bundler).
 * Alineado con src/utils/roles.js en el servidor.
 */
function normalizeRol(rol) {
  return String(rol || '').trim().toLowerCase();
}

function isTeacherRole(rol) {
  const r = normalizeRol(rol);
  return r === 'docente' || r === 'profesor';
}

function isAdminRole(rol) {
  return normalizeRol(rol) === 'admin';
}

/** Agenda en lobby/calendario: docente o admin (API reuniones). */
function canManageScheduleRole(rol) {
  return isTeacherRole(rol) || isAdminRole(rol);
}

function getUserRoleLabel(rol) {
  const r = normalizeRol(rol);
  if (r === 'admin') return 'Admin';
  return isTeacherRole(rol) ? 'Profesor' : 'Estudiante';
}

if (typeof window !== 'undefined') {
  window.normalizeRol = normalizeRol;
  window.isTeacherRole = isTeacherRole;
  window.isAdminRole = isAdminRole;
  window.canManageScheduleRole = canManageScheduleRole;
  window.getUserRoleLabel = getUserRoleLabel;
}
