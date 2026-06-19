/**
 * ChatPanel — visibilidad DOM del chat (observa AppState).
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let unsub = null;
  let initialized = false;

  function applyChatOpenDeferredUi(isOpen, hidden) {
    const $ = deps?.$;
    const text = hidden ? "Mostrar chat" : "Ocultar chat";
    const pressed = hidden ? "true" : "false";
    const btn = $?.("btnToggleChat");
    if (btn) {
      btn.textContent = text;
      btn.setAttribute("aria-pressed", pressed);
    }
    const btnInline = $?.("btnToggleChatInline");
    if (btnInline) {
      btnInline.textContent = text;
      btnInline.setAttribute("aria-pressed", pressed);
    }
    const btnBar = document.getElementById("btnChatBar");
    if (btnBar) {
      btnBar.setAttribute("aria-pressed", pressed);
      btnBar.setAttribute("aria-label", text);
      btnBar.classList.toggle("room-tb-btn--chat-open", !hidden);
    }
    if (!hidden && global.ChatModule) {
      global.ChatModule.markAllRead();
    }
  }

  function applyChatOpen(isOpen) {
    const hidden = !isOpen;
    const inShare =
      typeof global.isInShareContext === "function" && global.isInShareContext();

    if (inShare) {
      deps?.legacySyncHidden?.(hidden);
      const shell = deps?.$?.("roomShell") ?? document.getElementById("roomShell");
      if (shell) {
        shell.classList.remove("room-shell--chat-slide-hidden");
        shell.classList.remove("room-shell--chat-hidden");
        shell.classList.toggle("room-shell--chat-css-only-off", hidden);
      }
      const runDeferred = () => applyChatOpenDeferredUi(isOpen, hidden);
      global.requestAnimationFrame(() => {
        global.requestAnimationFrame(() => {
          if (typeof global.requestIdleCallback === "function") {
            global.requestIdleCallback(runDeferred, { timeout: 800 });
          } else {
            runDeferred();
          }
        });
      });
      return;
    }

    deps?.legacySyncHidden?.(hidden);
    const $ = deps?.$;
    const shell = $?.("roomShell");
    if (shell) {
      shell.classList.toggle("room-shell--chat-hidden", hidden);
    }
    const text = hidden ? "Mostrar chat" : "Ocultar chat";
    const pressed = hidden ? "true" : "false";
    const btn = $?.("btnToggleChat");
    if (btn) {
      btn.textContent = text;
      btn.setAttribute("aria-pressed", pressed);
    }
    const btnInline = $?.("btnToggleChatInline");
    if (btnInline) {
      btnInline.textContent = text;
      btnInline.setAttribute("aria-pressed", pressed);
    }
    const btnBar = document.getElementById("btnChatBar");
    if (btnBar) {
      btnBar.setAttribute("aria-pressed", pressed);
      btnBar.setAttribute("aria-label", text);
      btnBar.classList.toggle("room-tb-btn--chat-open", !hidden);
    }
    if (!hidden && global.ChatModule) {
      global.ChatModule.onActiveThreadChanged(global.ChatModule.getActiveChatThreadKey());
    }
    deps?.onChatVisibilityChange?.(isOpen);
  }

  function update(_prev, next) {
    if (!initialized) return;
    const flags = global.AppState?.getState?.()?.flags;
    if (flags && flags.enableChat === false) {
      applyChatOpen(false);
      return;
    }
    applyChatOpen(!!next);
  }

  function init(options = {}) {
    deps = options;
    if (initialized) return;
    initialized = true;
    const store = global.AppState;
    if (!store) return;
    unsub = store.subscribe((s) => s.ui.isChatOpen, update);
    update(null, store.getState().ui.isChatOpen);
  }

  function destroy() {
    if (unsub) {
      unsub();
      unsub = null;
    }
    initialized = false;
    deps = null;
  }

  function toggleFromBar() {
    const store = global.AppState;
    const T = global.MojActionTypes;
    if (!store || !T) {
      deps?.legacyToggle?.();
      return;
    }
    const flags = store.getState().flags;
    if (flags?.enableChat === false) return;
    const isOpen = store.getState().ui.isChatOpen;
    if (isOpen) {
      store.dispatch({ type: T.UI_TOGGLE_CHAT });
      return;
    }
    store.dispatch({ type: T.UI_SET_CHAT_OPEN, open: true });
    global.ChatModule?.openChatFromBar?.();
  }

  function bindBottomBar(mods) {
    if (typeof global.ChatRoomUiModule !== "undefined") {
      global.ChatRoomUiModule.bindBottomBar(mods);
      return;
    }
    const ChatModule = mods?.ChatModule;
    const UiBarra = mods?.UiBarra;
    const Notify = mods?.NotificationsModule || mods?.Notificaciones || global.NotificationsModule;
    if (!ChatModule || !UiBarra || !Notify) return;
    Notify.init({
      getChatThreads: () => ChatModule.getChatThreads(),
      onUpdate: (state) => UiBarra.updateBadge(state),
    });
    UiBarra.mountRoomBottomBar({ onOpenChat: () => toggleFromBar() });
  }

  global.ChatPanelModule = {
    init,
    update,
    destroy,
    applyChatOpen,
    toggleFromBar,
    bindBottomBar,
  };
})(typeof window !== "undefined" ? window : global);
