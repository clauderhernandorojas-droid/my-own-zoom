/**
 * ChatRoomUiModule — barra chat (dispatch AppState; compat legacy).
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let barBound = false;

  function init(options = {}) {
    deps = options;
  }

  function onShareLayoutEnter() {
    const T = global.MojActionTypes;
    if (deps?.dispatch && T) {
      deps.dispatch({ type: T.UI_SET_CHAT_OPEN, open: false });
      return;
    }
    deps?.setChatPanelHidden?.(true);
  }

  function toggleFromBar() {
    if (global.ChatPanelModule?.toggleFromBar) {
      global.ChatPanelModule.toggleFromBar();
      return;
    }
    const chatHidden = deps?.getChatPanelHidden?.() ?? true;
    if (!chatHidden) {
      deps?.setChatPanelHidden?.(true);
      return;
    }
    global.ChatModule?.openChatFromBar?.();
  }

  function bindBottomBar(mods) {
    if (barBound) return;
    const ChatModule = mods?.ChatModule;
    const UiBarra = mods?.UiBarra;
    const Notify = mods?.NotificationsModule || mods?.Notificaciones || global.NotificationsModule;
    if (!ChatModule || !UiBarra || !Notify) return;
    barBound = true;
    Notify.init({
      getChatThreads: () => ChatModule.getChatThreads(),
      onUpdate: (state) => UiBarra.updateBadge(state?.totalUnread),
    });
    UiBarra.mountRoomBottomBar({ onOpenChat: () => toggleFromBar() });
  }

  global.ChatRoomUiModule = {
    init,
    bindBottomBar,
    onShareLayoutEnter,
    toggleFromBar,
  };
})(typeof window !== "undefined" ? window : global);
