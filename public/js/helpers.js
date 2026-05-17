/**
 * Helpers compartidos (sin bundler).
 */
function isAdminRole(rol) {
  return String(rol || '').trim().toLowerCase() === 'admin';
}

if (typeof window !== 'undefined') {
  window.isAdminRole = isAdminRole;
}
