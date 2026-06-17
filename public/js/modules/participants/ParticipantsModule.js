/**
 * ParticipantsModule — panel flotante participantes (observa AppState).
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let unsubLayout = null;
  let unsubFlags = null;
  let floatInited = false;
  let onTrackRaf = 0;
  let panelSyncRaf = 0;

  function isShareActiveState(state) {
    if (global.AppState?.isShareActive) {
      return global.AppState.isShareActive(state);
    }
    const s = state?.share;
    return !!(s?.isLocalShareActive || s?.isRemoteShareActive);
  }

  function isEnabled(state) {
    return state?.flags?.enableParticipantsPanel !== false;
  }

  function shouldActivate(state) {
    if (!isEnabled(state)) return false;
    if (!isShareActiveState(state)) return false;
    if (state.ui.currentLayout !== "share") return false;
    if (state.ui.participantsPanelState === "hidden") return false;
    return state.ui.isParticipantsPanelVisible !== false;
  }

  function initFloatPanel() {
    if (floatInited || !isEnabled(global.AppState?.getState?.())) return;
    global.FloatPanelModule?.init?.({
      $: deps?.$,
      getActiveRoomId: deps?.getActiveRoomId,
      getStageElement: () => document.getElementById("roomRemoteScreenStage"),
      clamp: global.UiFloatClamp,
      shareModularClass: deps?.shareModularClass || "room-shell--share-layout-modular",
      isDisplayCaptureVideoTrack: (track) =>
        typeof global.isDisplayCaptureVideoTrack === "function"
          ? global.isDisplayCaptureVideoTrack(track)
          : false,
      getShareOwnerId: () =>
        typeof global.__mojGetShareOwnerId === "function"
          ? global.__mojGetShareOwnerId()
          : global.AppState?.getState?.()?.share?.ownerId || "",
      peerSocketToUserId: global.__mojPeerSocketToUserId || null,
      onPanelStateChange: (panelState) => {
        const T = global.MojActionTypes;
        if (T && global.AppState?.dispatch) {
          global.AppState.dispatch({ type: T.PARTICIPANTS_PANEL_SET, state: panelState });
        }
      },
    });
    floatInited = true;
  }

  function teardownPanelDom() {
    global.UiPresenterFloat?.deactivate?.();
    global.FloatPanelModule?.deactivate?.({ force: true, clearMinimizeState: true });
  }

  function syncPanelImmediate(state) {
    if (shouldActivate(state)) {
      if (!floatInited) initFloatPanel();
      const ui = state.ui;
      if (global.FloatPanelModule?.isActive?.()) {
        global.FloatPanelModule?.applyPanelStateFromStore?.(ui);
        global.FloatPanelModule?.onShareLayoutChange?.();
      } else {
        global.FloatPanelModule?.activate?.();
        global.FloatPanelModule?.applyPanelStateFromStore?.(ui);
        global.FloatPanelModule?.onShareLayoutChange?.();
      }
    } else {
      teardownPanelDom();
    }
  }

  function syncPanel(_state) {
    if (panelSyncRaf) return;
    panelSyncRaf = global.requestAnimationFrame(() => {
      panelSyncRaf = 0;
      const fresh = global.AppState?.getState?.();
      if (fresh) syncPanelImmediate(fresh);
    });
  }

  function onRemoteTrackMounted(_socketId) {
    if (!global.AppState?.getState?.()) return;
    if (onTrackRaf) global.cancelAnimationFrame(onTrackRaf);
    onTrackRaf = global.requestAnimationFrame(() => {
      onTrackRaf = 0;
      const stateNow = global.AppState.getState();
      if (shouldActivate(stateNow)) {
        global.FloatPanelModule?.onShareLayoutChange?.();
        global.scheduleRemoteScreenLayoutUpdate?.();
      } else if (!global.isInShareContext?.()) {
        global.refreshGalleryVideoMosaic?.();
      } else {
        global.scheduleRemoteScreenLayoutUpdate?.();
      }
    });
  }

  function updateFromStore(state) {
    if (!state) return;
    syncPanel(state);
  }

  let inited = false;

  function init(options = {}) {
    if (inited) return;
    deps = options;
    const store = global.AppState;
    if (!store) return;

    const handler = () => updateFromStore(store.getState());
    unsubLayout = store.subscribe(
      (s) => ({
        layout: s.ui.currentLayout,
        visible: s.ui.isParticipantsPanelVisible,
        panelState: s.ui.participantsPanelState,
        share: s.share,
      }),
      handler
    );
    unsubFlags = store.subscribe((s) => s.flags.enableParticipantsPanel, handler);

    const initial = store.getState();
    if (isShareActiveState(initial) && shouldActivate(initial)) {
      initFloatPanel();
      handler();
    }
    inited = true;
  }

  function update(_prev, _next) {
    updateFromStore(global.AppState?.getState?.());
  }

  function teardownPanel() {
    teardownPanelDom();
  }

  function destroy() {
    if (panelSyncRaf) {
      global.cancelAnimationFrame(panelSyncRaf);
      panelSyncRaf = 0;
    }
    if (unsubLayout) {
      unsubLayout();
      unsubLayout = null;
    }
    if (unsubFlags) {
      unsubFlags();
      unsubFlags = null;
    }
    teardownPanelDom();
    inited = false;
    deps = null;
  }

  global.ParticipantsModule = {
    init,
    update,
    destroy,
    teardownPanel,
    shouldActivate,
    onRemoteTrackMounted,
  };
})(typeof window !== "undefined" ? window : global);

