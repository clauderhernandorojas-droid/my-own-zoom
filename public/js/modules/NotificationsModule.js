/**
 * NotificationsModule — fachada sobre notificaciones.js (badge / no-leídos).
 * @deprecated Usar NotificationsModule; Notificaciones se mantiene por compatibilidad.
 */
(function (global) {
  function init(opts) {
    return global.Notificaciones?.initNotificaciones?.(opts);
  }

  function getTotalUnread() {
    return global.Notificaciones?.getTotalUnread?.() ?? 0;
  }

  function getUnreadForThread(key) {
    return global.Notificaciones?.getUnreadForThread?.(key) ?? 0;
  }

  function reset() {
    global.Notificaciones?.reset?.();
  }

  function recalcFromThreads() {
    global.Notificaciones?.recalcFromThreads?.();
  }

  global.NotificationsModule = {
    init,
    getTotalUnread,
    getUnreadForThread,
    reset,
    recalcFromThreads,
  };
})(typeof window !== "undefined" ? window : global);
