/**
 * LayoutModule — layout modular durante share (observa AppState).
 */
(function (global) {
  const SHARE_MODULAR_CLASS = "room-shell--share-layout-modular";

  /** @type {object | null} */
  let deps = null;
  let initialized = false;
  let unsubLayout = null;
  let unsubFlags = null;

  function getShell() {
    return deps?.$?.("roomShell") ?? null;
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

  function deactivateShareLayoutUi(options = {}) {
    applyShareModularClass(false);
    global.UiPresenterFloat?.deactivate?.();
    if (options.skipParticipants) return;
    global.ParticipantsModule?.destroy?.();
    global.FloatPanelModule?.deactivate?.(options);
  }

  function updateFromStore(state) {
    if (!state) return;
    const modular =
      state.flags?.enableModularLayout !== false &&
      global.ClientEnv?.isModularShareLayoutEligible?.() !== false;
    if (!modular) {
      applyShareModularClass(false);
      return;
    }
    const shareActive = state.ui.currentLayout === "share";
    applyShareModularClass(shareActive);
    if (shareActive) {
      global.requestAnimationFrame(() => {
        resyncScreenOverlay();
      });
    }
    deps?.onShareLayoutChange?.();
  }

  function init(options = {}) {
    deps = options;
    if (initialized) return;
    if (!global.ClientEnv?.isModularShareLayoutEligible?.()) return;

    global.ChatRoomUiModule?.init?.({
      dispatch: (action) => global.AppState?.dispatch?.(action),
      getChatPanelHidden: deps.getChatPanelHidden,
      isWeb: () => global.ClientEnv?.isWeb?.() ?? !global.__MOJ_ELECTRON,
    });
    global.ToolbarModule?.initWebLayerPolicy?.();

    const store = global.AppState;
    if (store) {
      const handler = () => updateFromStore(store.getState());
      unsubLayout = store.subscribe((s) => s.ui.currentLayout, handler);
      unsubFlags = store.subscribe((s) => s.flags.enableModularLayout, handler);
      handler();
    }

    global.ParticipantsModule?.init?.({
      $: deps.$,
      getActiveRoomId: deps.getActiveRoomId,
      shareModularClass: SHARE_MODULAR_CLASS,
    });

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
    if (!global.AppState) return;
    updateFromStore(global.AppState.getState());
    global.requestAnimationFrame(() => {
      resyncScreenOverlay();
      global.requestAnimationFrame(() => resyncScreenOverlay());
    });
  }

  function onLeaveRoom() {
    if (unsubLayout) {
      unsubLayout();
      unsubLayout = null;
    }
    if (unsubFlags) {
      unsubFlags();
      unsubFlags = null;
    }
    global.ParticipantsModule?.destroy?.();
    deactivateShareLayoutUi({ destroyDom: true, force: true, skipParticipants: true });
    global.AppState?.dispatch?.({ type: global.MojActionTypes?.ROOM_RESET });
    initialized = false;
  }

  function syncShareLayout() {
    if (!initialized && deps) init(deps);
    if (!initialized) {
      console.warn("[LayoutModule] syncShareLayout: init no completado");
      return;
    }
    if (global.AppState) {
      updateFromStore(global.AppState.getState());
      return;
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
    updateFromStore,
  };
})(typeof window !== "undefined" ? window : global);
