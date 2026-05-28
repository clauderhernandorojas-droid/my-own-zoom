/**
 * chat.js — dominio de chat en sala (fase 1): bus de notificaciones y reglas de no-leídos.
 * No confundir `moj:chat:notify` / `moj:chat:read` con eventos Socket.IO `chat:message`.
 */
(function (global) {
  const EVENT_NOTIFY = "moj:chat:notify";
  const EVENT_READ = "moj:chat:read";

  /** @type {object | null} */
  let deps = null;

  function emitNotify(detail) {
    document.dispatchEvent(new CustomEvent(EVENT_NOTIFY, { detail: detail || {} }));
  }

  function emitRead(detail) {
    document.dispatchEvent(new CustomEvent(EVENT_READ, { detail: detail || {} }));
  }

  function sameUserId(a, b) {
    if (a == null || b == null) return false;
    return String(a).toLowerCase() === String(b).toLowerCase();
  }

  /**
   * Hilo activo con panel visible = leído; panel oculto siempre cuenta como no leído.
   * @param {string} threadKey
   */
  function shouldMarkUnread(threadKey) {
    if (!threadKey || !deps) return false;
    if (deps.getChatPanelHidden?.()) return true;
    return deps.getActiveChatThreadKey?.() !== threadKey;
  }

  /**
   * @param {string} mensajeId
   * @returns {string|null}
   */
  function findThreadKeyForMessage(mensajeId) {
    const id = String(mensajeId || "").trim();
    if (!id) return null;
    const threads = deps.getChatThreads?.();
    if (!threads) return null;
    for (const [key, thread] of threads) {
      if (!thread?.messages) continue;
      if (thread.messages.some((m) => String(m?.mensajeId || "") === id)) {
        return key;
      }
    }
    return null;
  }

  /**
   * @param {string} threadKey
   * @param {{ kind?: string, mensajeId?: string, fromUserId?: string }} meta
   */
  function bumpThreadUnread(threadKey, meta) {
    const threads = deps.getChatThreads?.();
    if (!threads || !threads.has(threadKey)) return;
    const thread = threads.get(threadKey);
    thread.unread = (thread.unread || 0) + 1;
    deps.renderChatThreadTabs?.();
    emitNotify({
      kind: meta?.kind || "message",
      threadKey,
      mensajeId: meta?.mensajeId,
      fromUserId: meta?.fromUserId,
      roomId: deps.getActiveRoomId?.(),
    });
  }

  function markThreadRead(threadKey) {
    const threads = deps.getChatThreads?.();
    if (threads && threadKey && threads.has(threadKey)) {
      const thread = threads.get(threadKey);
      thread.unread = 0;
      deps.renderChatThreadTabs?.();
    }
    emitRead({ threadKey });
  }

  function markAllRead() {
    const threads = deps.getChatThreads?.();
    if (threads) {
      threads.forEach((t) => {
        t.unread = 0;
      });
      deps.renderChatThreadTabs?.();
    }
    emitRead({ all: true });
  }

  /**
   * @param {{ mensaje?: object }} payload
   */
  function onIncomingMessage(payload) {
    deps.appendChatLineCore?.(payload);
  }

  /**
   * @param {{ mensajeId?: string, reactions?: object[] }} payload
   */
  function onIncomingReaction(payload) {
    const mensajeId = payload?.mensajeId;
    if (!mensajeId) return;

    const threadKey = findThreadKeyForMessage(mensajeId);
    deps.applyMessageReactionsUpdate?.(String(mensajeId), payload.reactions);

    if (threadKey && shouldMarkUnread(threadKey)) {
      bumpThreadUnread(threadKey, { kind: "reaction", mensajeId: String(mensajeId) });
    } else if (threadKey) {
      emitNotify({ kind: "reaction", threadKey, mensajeId: String(mensajeId) });
    }
  }

  /**
   * Llamar tras setActiveChatThread cuando el panel está visible.
   * @param {string} threadKey
   */
  function onActiveThreadChanged(threadKey) {
    if (!threadKey || deps.getChatPanelHidden?.()) return;
    markThreadRead(threadKey);
  }

  /**
   * @param {{ getCurrentUser: Function, getActiveChatThreadKey: Function, getChatPanelHidden: Function, getChatThreads: Function, getActiveRoomId: Function, appendChatLineCore: Function, applyMessageReactionsUpdate: Function, renderChatThreadTabs: Function }} hooks
   */
  function initChat(hooks) {
    deps = hooks || null;
  }

  global.ChatModule = {
    initChat,
    onIncomingMessage,
    onIncomingReaction,
    onActiveThreadChanged,
    markThreadRead,
    markAllRead,
    shouldMarkUnread,
    bumpThreadUnread,
    emitNotify,
    emitRead,
    EVENT_NOTIFY,
    EVENT_READ,
    findThreadKeyForMessage,
    sameUserId,
  };
})(typeof window !== "undefined" ? window : globalThis);
