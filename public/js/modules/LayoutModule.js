/**
 * LayoutModule — orquesta layout web al entrar/salir de sala y cuando cambia el share.
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let initialized = false;

  function init(options = {}) {
    deps = options;
    const isWeb = global.ClientEnv?.isWebLayoutEnabled?.() ?? !global.__MOJ_ELECTRON;
    if (!isWeb) return;
    global.FloatPanelModule?.init?.({
      $: deps.$,
      getActiveRoomId: deps.getActiveRoomId,
      getStageElement: () => document.getElementById("roomRemoteScreenStage"),
      clamp: global.UiFloatClamp,
    });
    global.ChatRoomUiModule?.init?.({
      setChatPanelHidden: deps.setChatPanelHidden,
      getChatPanelHidden: deps.getChatPanelHidden,
      isWeb: () => global.ClientEnv?.isWeb?.() ?? !global.__MOJ_ELECTRON,
    });
    global.ToolbarModule?.initWebLayerPolicy?.();
    initialized = true;
  }

  function isActive() {
    return !!global.FloatPanelModule?.isActive?.();
  }

  function onEnterRoom() {
    if (!initialized) return;
    global.FloatPanelModule?.activate?.();
    global.ChatRoomUiModule?.onEnterRoomWeb?.();
  }

  function onLeaveRoom() {
    global.FloatPanelModule?.deactivate?.();
  }

  function onShareLayoutChange() {
    global.FloatPanelModule?.onShareLayoutChange?.();
    deps?.onShareLayoutChange?.();
  }

  global.LayoutModule = {
    init,
    isActive,
    onEnterRoom,
    onLeaveRoom,
    onShareLayoutChange,
  };
})(typeof window !== "undefined" ? window : global);
