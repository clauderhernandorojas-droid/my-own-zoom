/**
 * ChatRoomUiModule — visibilidad del panel de chat en sala y botón de barra (no reemplaza ChatModule).
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let barBound = false;

  function init(options = {}) {
    deps = options;
  }

  function isWebEnv() {
    if (typeof deps?.isWeb === "function") return !!deps.isWeb();
    return global.ClientEnv?.isWeb?.() ?? !global.__MOJ_ELECTRON;
  }

  /** Ocultar chat al entrar en modo pantalla compartida (todos los entornos). */
  function onShareLayoutEnter() {
    deps?.setChatPanelHidden?.(true);
    const shell = document.getElementById("roomShell");
    if (shell) {
      shell.classList.remove("room-shell--chat-open");
      shell.classList.add("room-shell--chat-hidden");
    }
  }

  function onEnterRoomWeb() {
    onShareLayoutEnter();
  }

  function toggleFromBar() {
    const chatHidden = deps?.getChatPanelHidden?.() ?? true;
    if (!chatHidden) {
      deps?.setChatPanelHidden?.(true);
      const shell = document.getElementById("roomShell");
      if (shell) {
        shell.classList.remove("room-shell--chat-open");
        shell.classList.add("room-shell--chat-hidden");
      }
      return;
    }
    global.ChatModule?.openChatFromBar?.();
  }

  /**
   * @param {{ ChatModule: object, UiBarra: object, NotificationsModule?: object, Notificaciones?: object }} mods
   */
  function bindBottomBar(mods) {
    if (barBound) return;
    const ChatModule = mods?.ChatModule;
    const UiBarra = mods?.UiBarra;
    const Notify = mods?.NotificationsModule || mods?.Notificaciones || global.NotificationsModule;
    if (!ChatModule || !UiBarra || !Notify) return;
    barBound = true;
    Notify.init({
      getChatThreads: () => ChatModule.getChatThreads(),
      onUpdate: (state) => {
        UiBarra.updateBadge(state?.totalUnread);
      },
    });
    UiBarra.mountRoomBottomBar({
      onOpenChat: () => toggleFromBar(),
    });
  }

  global.ChatRoomUiModule = {
    init,
    bindBottomBar,
    onShareLayoutEnter,
    onEnterRoomWeb,
    toggleFromBar,
  };
})(typeof window !== "undefined" ? window : global);
