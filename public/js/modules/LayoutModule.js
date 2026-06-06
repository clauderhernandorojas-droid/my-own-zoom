/**
 * LayoutModule — layout modular solo durante pantalla compartida (web + Electron).
 */
(function (global) {
  const SHARE_MODULAR_CLASS = "room-shell--share-layout-modular";

  /** @type {object | null} */
  let deps = null;
  let initialized = false;

  function getShell() {
    return deps?.$?.("roomShell") ?? null;
  }

  function isShareActive() {
    const shell = getShell();
    if (global.ClientEnv?.isShareLayoutActive) {
      return global.ClientEnv.isShareLayoutActive(shell);
    }
    return (
      shell?.classList.contains("room-shell--presenter-focus") ||
      shell?.classList.contains("room-shell--remote-screen-dominant")
    );
  }

  function applyShareModularClass(on) {
    const shell = getShell();
    if (!shell) return;
    shell.classList.toggle(SHARE_MODULAR_CLASS, !!on);
  }

  function resyncScreenOverlay() {
    const stage = document.getElementById("roomRemoteScreenStage");
    if (stage && global.ScreenOverlay?.syncWithStage) {
      global.ScreenOverlay.syncWithStage(stage);
    }
  }

  function syncParticipantsPanel() {
    global.requestAnimationFrame(() => {
      global.FloatPanelModule?.activate?.();
      global.requestAnimationFrame(() => {
        global.FloatPanelModule?.onShareLayoutChange?.();
      });
    });
  }

  function init(options = {}) {
    deps = options;
    if (!global.ClientEnv?.isModularShareLayoutEligible?.()) return;

    global.FloatPanelModule?.init?.({
      $: deps.$,
      getActiveRoomId: deps.getActiveRoomId,
      getStageElement: () => document.getElementById("roomRemoteScreenStage"),
      clamp: global.UiFloatClamp,
      shareModularClass: SHARE_MODULAR_CLASS,
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
    const shell = getShell();
    return (
      !!global.FloatPanelModule?.isActive?.() ||
      !!shell?.classList.contains(SHARE_MODULAR_CLASS)
    );
  }

  function onEnterRoom() {
    if (!isShareActive()) return;
    applyShareModularClass(true);
    global.requestAnimationFrame(() => {
      resyncScreenOverlay();
      global.requestAnimationFrame(() => {
        resyncScreenOverlay();
        syncParticipantsPanel();
      });
    });
  }

  function onLeaveRoom() {
    global.FloatPanelModule?.deactivate?.();
    applyShareModularClass(false);
  }

  function syncShareLayout() {
    if (!initialized) {
      if (deps) {
        init(deps);
      }
      if (!initialized) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[LayoutModule] syncShareLayout: init no completado");
        }
        return;
      }
    }
    if (isShareActive()) {
      global.ChatRoomUiModule?.onShareLayoutEnter?.();
      applyShareModularClass(true);
      global.requestAnimationFrame(() => {
        resyncScreenOverlay();
        syncParticipantsPanel();
      });
    } else {
      global.FloatPanelModule?.deactivate?.();
      applyShareModularClass(false);
    }
    deps?.onShareLayoutChange?.();
  }

  function onShareLayoutChange() {
    syncShareLayout();
  }

  global.LayoutModule = {
    init,
    isActive,
    onEnterRoom,
    onLeaveRoom,
    syncShareLayout,
    onShareLayoutChange,
    SHARE_MODULAR_CLASS,
  };
})(typeof window !== "undefined" ? window : global);
