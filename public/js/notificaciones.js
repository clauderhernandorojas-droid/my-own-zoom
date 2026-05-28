/**
 * notificaciones.js — estado agregado de no-leídos de chat (solo RAM, sin DOM).
 */
(function (global) {
  let totalUnread = 0;
  /** @type {Map<string, number>} */
  const byThread = new Map();
  let hasReactionHint = false;
  /** @type {Function | null} */
  let onUpdateCb = null;
  /** @type {Function | null} */
  let getChatThreads = null;

  function recalcFromThreads() {
    byThread.clear();
    totalUnread = 0;
    hasReactionHint = false;
    const threads = getChatThreads?.();
    if (!threads || typeof threads.forEach !== "function") {
      onUpdateCb?.({ totalUnread, byThread, hasReactionHint });
      return;
    }
    threads.forEach((thread, key) => {
      const n = Number(thread?.unread) || 0;
      if (n > 0) {
        byThread.set(key, n);
        totalUnread += n;
      }
    });
    onUpdateCb?.({ totalUnread, byThread, hasReactionHint });
  }

  function onNotify(ev) {
    const kind = ev?.detail?.kind;
    if (kind === "reaction") hasReactionHint = true;
    recalcFromThreads();
  }

  function onRead() {
    hasReactionHint = false;
    recalcFromThreads();
  }

  function subscribeChatNotifyBus() {
    const notifyEv = global.ChatModule?.EVENT_NOTIFY || "moj:chat:notify";
    const readEv = global.ChatModule?.EVENT_READ || "moj:chat:read";
    document.addEventListener(notifyEv, onNotify);
    document.addEventListener(readEv, onRead);
  }

  /**
   * @param {{ getChatThreads: Function, onUpdate?: Function }} opts
   */
  function initNotificaciones(opts) {
    getChatThreads = opts?.getChatThreads || null;
    onUpdateCb = opts?.onUpdate || null;
    subscribeChatNotifyBus();
    recalcFromThreads();
  }

  function getTotalUnread() {
    return totalUnread;
  }

  function getUnreadForThread(key) {
    return byThread.get(key) || 0;
  }

  function reset() {
    hasReactionHint = false;
    recalcFromThreads();
  }

  global.Notificaciones = {
    initNotificaciones,
    getTotalUnread,
    getUnreadForThread,
    reset,
    recalcFromThreads,
  };
})(typeof window !== "undefined" ? window : globalThis);
