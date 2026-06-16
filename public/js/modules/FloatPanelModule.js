/**
 * FloatPanelModule — panel #webFloatPeersRoot, reparent #videos, snap, localStorage.
 */
(function (global) {
  const STORAGE_KEY = "moj_web_float_peers_v1";
  const MARGIN = 12;
  const DRAG_THRESHOLD = 6;
  const DEFAULT_W = 280;
  const DEFAULT_H = 320;

  /** @type {object | null} */
  let deps = null;
  let active = false;
  let rootEl = null;
  let pillEl = null;
  let headerEl = null;
  let resizeEl = null;
  let bodyEl = null;
  let videosEl = null;
  let videosParent = null;
  let videosNext = null;
  /** @type {{ left: number, top: number, width: number, height: number, minimized: boolean, edge?: string } | null} */
  let state = null;
  /** @type {object | null} */
  let drag = null;
  let resizeDrag = null;
  let pillSuppressClickUntil = 0;
  let domReady = false;
  let resizeBound = false;
  let tilesSyncTimer = 0;
  let blurGuardBound = false;
  let windowLostFocusDev = false;
  let userSizedPanel = false;

  function getClamp() {
    return deps?.clamp || global.UiFloatClamp || null;
  }

  function shareRoleKey() {
    const shell = getShellEl();
    if (shell?.classList.contains("room-shell--presenter-focus")) return "presenter";
    if (shell?.classList.contains("room-shell--remote-screen-dominant")) return "guest";
    return "share";
  }

  function storageKey() {
    const rid = deps?.getActiveRoomId?.();
    const role = shareRoleKey();
    return rid ? `${STORAGE_KEY}_${rid}_${role}` : STORAGE_KEY;
  }

  function loadState() {
    try {
      const raw = global.localStorage?.getItem(storageKey());
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return null;
  }

  function saveState() {
    if (!state) return;
    try {
      global.localStorage?.setItem(storageKey(), JSON.stringify(state));
    } catch (_) {}
  }

  function defaultState() {
    return {
      left: MARGIN,
      top: MARGIN,
      width: DEFAULT_W,
      height: DEFAULT_H,
      minimized: false,
      edge: "top",
    };
  }

  function clampBox(left, top, width, height) {
    const limits = { minW: 200, minH: 160, maxW: 520, maxH: 480 };
    const w = Math.min(Math.max(limits.minW, width), limits.maxW);
    const h = Math.min(Math.max(limits.minH, height), limits.maxH);
    let out = { left, top, width: w, height: h };
    const clampFn = getClamp()?.clampDockPosition;
    if (clampFn) {
      const c = clampFn({
        left,
        top,
        width: w,
        height: h,
        margin: MARGIN,
      });
      out = { ...out, left: c.left, top: c.top };
    } else {
      const vw = global.innerWidth || 800;
      const vh = global.innerHeight || 600;
      out.left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - w - MARGIN));
      out.top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - h - MARGIN));
    }
    return out;
  }

  function snapToNearestEdge(left, top, width, height) {
    const vw = global.innerWidth || document.documentElement.clientWidth || 800;
    const vh = global.innerHeight || document.documentElement.clientHeight || 600;
    const distTop = Math.abs(top - MARGIN);
    const distLeft = Math.abs(left - MARGIN);
    const distRight = Math.abs(vw - MARGIN - (left + width));
    const distBottom = Math.abs(vh - MARGIN - (top + height));
    const min = Math.min(distTop, distLeft, distRight, distBottom);
    let edge = "top";
    let out = { left, top };
    if (min === distTop) {
      edge = "top";
      out.top = MARGIN;
    } else if (min === distLeft) {
      edge = "left";
      out.left = MARGIN;
    } else if (min === distRight) {
      edge = "right";
      out.left = Math.max(MARGIN, vw - MARGIN - width);
    } else {
      edge = "bottom";
      out.top = Math.max(MARGIN, vh - MARGIN - height);
    }
    const c = clampBox(out.left, out.top, width, height);
    return { ...c, edge };
  }

  function applyLayout() {
    if (!rootEl || !state) return;
    if (state.minimized) {
      rootEl.classList.add("web-float-peers-root--minimized");
      rootEl.style.display = "none";
      if (pillEl) {
        pillEl.classList.remove("hidden");
        pillEl.style.left = `${state.left}px`;
        pillEl.style.top = `${state.top}px`;
      }
      return;
    }
    rootEl.classList.remove("web-float-peers-root--minimized");
    rootEl.style.display = "flex";
    if (pillEl) {
      pillEl.classList.add("hidden");
      pillEl.style.left = "";
      pillEl.style.top = "";
    }
    rootEl.style.left = `${state.left}px`;
    rootEl.style.top = `${state.top}px`;
    rootEl.style.width = `${state.width}px`;
    rootEl.style.height = `${state.height}px`;
    rootEl.dataset.snapEdge = state.edge || "";
    rootEl.classList.toggle("web-float-peers-root--user-sized", userSizedPanel);
    if (bodyEl) bodyEl.style.height = userSizedPanel ? "" : "auto";
    if (!userSizedPanel) {
      global.requestAnimationFrame(() => shrinkPanelToFitContent());
    }
  }

  function shrinkPanelToFitContent() {
    if (!rootEl || !state || state.minimized || !bodyEl || !active || drag || resizeDrag) return;
    if (userSizedPanel) return;
    const videos = videosEl || document.getElementById("videos");
    const headerH = headerEl?.offsetHeight || 36;
    bodyEl.style.flex = "0 0 auto";
    bodyEl.style.height = "auto";
    if (videos) videos.style.height = "auto";
    const peers = videos?.querySelectorAll(".remote-peer:not([hidden])") || [];
    const peerCount = Math.max(1, peers.length);
    const cols = peerCount <= 1 ? 1 : 2;
    const rows = Math.ceil(peerCount / cols);
    const tileW = 120;
    const tileH = Math.round((tileW * 9) / 16);
    const gap = 8;
    const pad = 16;
    const naturalW = Math.min(520, Math.max(180, cols * tileW + (cols - 1) * gap + pad));
    const naturalH = Math.max(100, headerH + rows * tileH + (rows - 1) * gap + pad);
    state.width = naturalW;
    state.height = naturalH;
    rootEl.style.width = `${state.width}px`;
    rootEl.style.height = `${state.height}px`;
  }

  function onPanelPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.dragging) {
      drag.dragging = true;
      rootEl?.classList.add("web-float-peers-root--dragging");
      if (state) state.edge = null;
    }
    e.preventDefault();
    if (!state) return;
    const c = clampBox(
      drag.originLeft + dx,
      drag.originTop + dy,
      state.width,
      state.height
    );
    state.left = c.left;
    state.top = c.top;
    applyLayout();
  }

  function onPanelPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasDrag = drag.dragging;
    drag = null;
    rootEl?.classList.remove("web-float-peers-root--dragging");
    pillEl?.classList.remove("web-float-peers-pill--dragging");
    try {
      (headerEl || pillEl)?.releasePointerCapture(e.pointerId);
    } catch (_) {}
    global.removeEventListener("pointermove", onPanelPointerMove);
    global.removeEventListener("pointerup", onPanelPointerUp);
    global.removeEventListener("pointercancel", onPanelPointerUp);
    if (wasDrag && state) {
      if (state.minimized) pillSuppressClickUntil = Date.now() + 400;
      const snapped = snapToNearestEdge(state.left, state.top, state.width, state.height);
      state.left = snapped.left;
      state.top = snapped.top;
      state.edge = snapped.edge;
      applyPanelVisibility();
      saveState();
    }
  }

  function startPanelDrag(e, targetEl, originLeft, originTop) {
    if (e.button !== 0) return;
    const onBtn = e.target.closest?.("button");
    if (onBtn && onBtn !== pillEl) return;
    e.preventDefault();
    e.stopPropagation();
    drag = {
      dragging: false,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originLeft,
      originTop,
    };
    try {
      targetEl.setPointerCapture(e.pointerId);
    } catch (_) {}
    global.addEventListener("pointermove", onPanelPointerMove);
    global.addEventListener("pointerup", onPanelPointerUp);
    global.addEventListener("pointercancel", onPanelPointerUp);
  }

  function onResizePointerMove(e) {
    if (!resizeDrag || e.pointerId !== resizeDrag.pointerId || !state) return;
    const dx = e.clientX - resizeDrag.startX;
    const dy = e.clientY - resizeDrag.startY;
    if (!resizeDrag.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    resizeDrag.dragging = true;
    e.preventDefault();
    const c = clampBox(
      state.left,
      state.top,
      resizeDrag.originW + dx,
      resizeDrag.originH + dy
    );
    state.width = c.width;
    state.height = c.height;
    state.left = c.left;
    state.top = c.top;
    state.edge = null;
    applyLayout();
  }

  function onResizePointerUp(e) {
    if (!resizeDrag || e.pointerId !== resizeDrag.pointerId) return;
    const was = resizeDrag.dragging;
    resizeDrag = null;
    try {
      resizeEl?.releasePointerCapture(e.pointerId);
    } catch (_) {}
    global.removeEventListener("pointermove", onResizePointerMove);
    global.removeEventListener("pointerup", onResizePointerUp);
    global.removeEventListener("pointercancel", onResizePointerUp);
    if (was && state) {
      userSizedPanel = true;
      const snapped = snapToNearestEdge(state.left, state.top, state.width, state.height);
      state.left = snapped.left;
      state.top = snapped.top;
      state.edge = snapped.edge;
      applyLayout();
      saveState();
    }
  }

  function ensureDom() {
    if (domReady) return;
    domReady = true;
    rootEl = document.createElement("div");
    rootEl.id = "webFloatPeersRoot";
    rootEl.className = "web-float-peers-root hidden";
    rootEl.innerHTML =
      '<div class="web-float-peers-header">' +
      '<span class="web-float-peers-title">Participantes</span>' +
      '<button type="button" class="web-float-peers-btn-min" aria-label="Minimizar">−</button></div>' +
      '<div class="web-float-peers-body"></div>';
    resizeEl = document.createElement("div");
    resizeEl.className = "web-float-peers-resize-handle";
    resizeEl.title = "Redimensionar";
    rootEl.appendChild(resizeEl);
    document.body.appendChild(rootEl);

    headerEl = rootEl.querySelector(".web-float-peers-header");
    bodyEl = rootEl.querySelector(".web-float-peers-body");

    pillEl = document.createElement("button");
    pillEl.type = "button";
    pillEl.id = "webFloatPeersPill";
    pillEl.className = "web-float-peers-pill hidden";
    pillEl.textContent = "Participantes";
    pillEl.title = "Doble clic para expandir";
    document.body.appendChild(pillEl);

    headerEl?.addEventListener("pointerdown", (e) => {
      if (!state || state.minimized) return;
      startPanelDrag(e, headerEl, state.left, state.top);
    });
    pillEl.addEventListener("pointerdown", (e) => {
      if (!state || !state.minimized) return;
      startPanelDrag(e, pillEl, state.left, state.top);
    });
    pillEl.addEventListener("click", (e) => {
      if (Date.now() < pillSuppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    pillEl.addEventListener("dblclick", (e) => {
      e.preventDefault();
      restorePanel();
    });
    resizeEl.addEventListener("pointerdown", (e) => {
      if (!state || state.minimized) return;
      e.preventDefault();
      e.stopPropagation();
      resizeDrag = {
        dragging: false,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originW: state.width,
        originH: state.height,
      };
      try {
        resizeEl.setPointerCapture(e.pointerId);
      } catch (_) {}
      global.addEventListener("pointermove", onResizePointerMove);
      global.addEventListener("pointerup", onResizePointerUp);
      global.addEventListener("pointercancel", onResizePointerUp);
    });
    rootEl.querySelector(".web-float-peers-btn-min")?.addEventListener("click", (e) => {
      e.stopPropagation();
      minimizePanel();
    });

    if (!resizeBound) {
      resizeBound = true;
      global.addEventListener("resize", () => {
        if (!active || !state) return;
        const c = clampBox(state.left, state.top, state.width, state.height);
        state.left = c.left;
        state.top = c.top;
        state.width = c.width;
        state.height = c.height;
        applyLayout();
      });
    }
    bindBlurFloatPanelGuard();
  }

  function filterScreenShareTilesInPanel(videosRoot) {
    document.getElementById("webFloatStageMirror")?.remove();
    videosRoot?.querySelectorAll("#remotesContainer .remote-peer").forEach((peer) => {
      if (peer.getAttribute("data-moj-screen-stage") === "1") {
        peer.style.display = "none";
        return;
      }
      const vid = peer.querySelector("video");
      const track = vid?.srcObject?.getVideoTracks?.()?.[0];
      const label = String(track?.label || "").toLowerCase();
      const isScreen =
        label.includes("screen") ||
        label.includes("pantalla") ||
        label.includes("display") ||
        label.includes("window");
      if (isScreen) peer.style.display = "none";
    });
  }

  function resumeVideosPlayback(videosRoot) {
    videosRoot?.querySelectorAll("video").forEach((vid) => {
      vid.play?.().catch(() => {});
    });
  }

  function mountVideos() {
    const src = document.getElementById("videos");
    if (!bodyEl || !src) return;
    if (src.parentElement === bodyEl) {
      videosEl = src;
      resumeVideosPlayback(src);
      filterScreenShareTilesInPanel(src);
      global.requestAnimationFrame(() => {
        shrinkPanelToFitContent();
        global.requestAnimationFrame(shrinkPanelToFitContent);
      });
      return;
    }
    videosParent = src.parentElement;
    videosNext = src.nextSibling;
    videosEl = src;
    src.classList.add("web-float-peers-videos");
    bodyEl.appendChild(src);
    resumeVideosPlayback(src);
    filterScreenShareTilesInPanel(src);
    global.requestAnimationFrame(() => {
      shrinkPanelToFitContent();
      global.requestAnimationFrame(shrinkPanelToFitContent);
    });
  }

  function resolveGalleryVideosParent() {
    const stage = document.querySelector(".room-video-strip__stage");
    if (stage) return stage;
    const strip = document.getElementById("roomVideoStrip");
    return strip?.querySelector?.(".room-video-strip__stage") || null;
  }

  function unmountVideos() {
    const vid = videosEl || document.getElementById("videos");
    if (!vid) return;
    let parent = videosParent;
    if (!parent || !parent.isConnected) {
      parent = resolveGalleryVideosParent();
    }
    if (!parent) return;
    try {
      vid.classList.remove("web-float-peers-videos");
      if (videosNext && videosNext.parentNode === parent) {
        parent.insertBefore(vid, videosNext);
      } else {
        parent.appendChild(vid);
      }
    } catch (_) {}
    videosEl = null;
    videosParent = null;
    videosNext = null;
  }

  function getShellEl() {
    return deps?.$?.("roomShell") || null;
  }

  function isLocalDevHost() {
    const host = global.location?.hostname;
    return host === "localhost" || host === "127.0.0.1";
  }

  function isDevBlurFloatAutoDisabled() {
    try {
      return global.localStorage?.getItem("moj_dev_disable_float_blur_auto") === "1";
    } catch (_) {
      return false;
    }
  }

  function isLocalPresenterOrSharing() {
    if (typeof deps?.isBoardPresentationActive === "function" && deps.isBoardPresentationActive()) {
      return true;
    }
    if (typeof deps?.isLocallySharingScreen === "function" && deps.isLocallySharingScreen()) {
      return true;
    }
    const ctx =
      typeof global.__mojGetShareContext === "function" ? global.__mojGetShareContext() : null;
    if (ctx?.boardPresentationActive) return true;
    if (ctx?.locallySharingScreen) return true;
    const shell = getShellEl();
    return !!shell?.classList.contains("room-shell--presenter-focus");
  }

  function shouldSuppressBlurAutoFloatPanel() {
    if (!isLocalDevHost()) return false;
    if (isDevBlurFloatAutoDisabled()) return true;
    return isLocalPresenterOrSharing();
  }

  function isWindowUnfocusedForDev() {
    return (
      windowLostFocusDev ||
      (typeof document.hasFocus === "function" ? !document.hasFocus() : !!document.hidden)
    );
  }

  function shouldBlockFloatPanelActivateFromBlur() {
    return shouldSuppressBlurAutoFloatPanel() && isWindowUnfocusedForDev();
  }

  function onWindowBlurFloatPanel() {
    if (!isLocalDevHost()) return;
    windowLostFocusDev = true;
    if (shouldSuppressBlurAutoFloatPanel() && active) return;
  }

  function onVisibilityChangeFloatPanel() {
    if (!isLocalDevHost()) return;
    if (document.hidden) {
      windowLostFocusDev = true;
      return;
    }
    windowLostFocusDev = false;
  }

  function bindBlurFloatPanelGuard() {
    if (blurGuardBound) return;
    blurGuardBound = true;
    global.addEventListener("blur", onWindowBlurFloatPanel);
    document.addEventListener("visibilitychange", onVisibilityChangeFloatPanel);
  }

  function rectsIntersect(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  function avoidStageOverlap() {
    if (!rootEl || !state || state.minimized || drag || resizeDrag) return false;
    const shell = getShellEl();
    const shareLayoutActive =
      shell?.classList.contains("room-shell--remote-screen-dominant") ||
      shell?.classList.contains("room-shell--presenter-focus");
    if (!shareLayoutActive) return false;
    const fabHost = document.querySelector("#screenOverlayUiLayer .screen-overlay-fab-host");
    if (!fabHost) return false;
    const pr = rootEl.getBoundingClientRect();
    const fr = fabHost.getBoundingClientRect();
    const fabPad = 12;
    const fabZone = {
      left: fr.left - fabPad,
      top: fr.top - fabPad,
      right: fr.right + fabPad,
      bottom: fr.bottom + fabPad,
    };
    if (!rectsIntersect(pr, fabZone)) return false;
    state.left = fabZone.right + MARGIN;
    state.top = Math.max(MARGIN, state.top);
    state.edge = null;
    const c = clampBox(state.left, state.top, state.width, state.height);
    state.left = c.left;
    state.top = c.top;
    state.width = c.width;
    state.height = c.height;
    applyLayout();
    saveState();
    return true;
  }

  function shareModularClass() {
    return deps?.shareModularClass || "room-shell--share-layout-modular";
  }

  function suppressDesktopPresenterUi() {
    global.UiPresenterFloat?.deactivate?.();
  }

  function countVisiblePeerTiles() {
    const src = videosEl || document.getElementById("videos");
    if (!src) return 0;
    let n = 0;
    src.querySelectorAll(".remote-peer").forEach((peer) => {
      if (peer.closest("#roomRemoteScreenStage")) return;
      const video = peer.querySelector("video");
      if (!video) return;
      const track = video.srcObject?.getVideoTracks?.()[0];
      if (track && track.readyState === "live") {
        n += 1;
        return;
      }
      if (video.srcObject?.getTracks?.().length) {
        n += 1;
        return;
      }
      if (video.videoWidth > 0) n += 1;
    });
    return n;
  }

  function getStorePanelState() {
    return global.AppState?.getState?.()?.ui?.participantsPanelState;
  }

  function dispatchPanelState(panelState) {
    const T = global.MojActionTypes;
    if (T && global.AppState?.dispatch) {
      global.AppState.dispatch({ type: T.PARTICIPANTS_PANEL_SET, state: panelState });
    }
    deps?.onPanelStateChange?.(panelState);
  }

  function applyPanelVisibility() {
    if (!rootEl || !state) return;
    applyLayout();
    const storeState = getStorePanelState();
    if (storeState === "hidden" || !active) {
      rootEl.classList.add("hidden");
      pillEl?.classList.add("hidden");
      return;
    }
    const minimized = state.minimized || storeState === "minimized";
    if (minimized) {
      rootEl.classList.add("hidden");
      pillEl?.classList.remove("hidden");
    } else {
      rootEl.classList.remove("hidden");
      pillEl?.classList.add("hidden");
    }
  }

  function isShareOkInStore() {
    const store = global.AppState?.getState?.();
    return (
      store?.ui?.currentLayout === "share" &&
      global.AppState?.isShareActive?.(store)
    );
  }

  function syncPanelVisibilityForTiles() {
    if (!active) return;
    if (global.AppState?.getState?.()?.flags?.enableParticipantsPanel === false) {
      if (tilesSyncTimer) {
        clearTimeout(tilesSyncTimer);
        tilesSyncTimer = 0;
      }
      deactivate({ force: true, destroyDom: true });
      return;
    }
    if (!isShareOkInStore()) {
      if (tilesSyncTimer) {
        clearTimeout(tilesSyncTimer);
        tilesSyncTimer = 0;
      }
      deactivate({ force: true, destroyDom: true });
      return;
    }
    const tiles = countVisiblePeerTiles();
    if (tiles === 0) {
      if (tilesSyncTimer) return;
      tilesSyncTimer = setTimeout(() => {
        tilesSyncTimer = 0;
        if (!active || !isShareOkInStore()) return;
        if (countVisiblePeerTiles() === 0) {
          deactivate({ force: true, destroyDom: true });
        } else {
          applyPanelVisibility();
        }
      }, 400);
      return;
    }
    if (tilesSyncTimer) {
      clearTimeout(tilesSyncTimer);
      tilesSyncTimer = 0;
    }
    applyPanelVisibility();
  }

  function minimizePanel() {
    if (!state) return;
    state.minimized = true;
    applyPanelVisibility();
    saveState();
    dispatchPanelState("minimized");
  }

  function restorePanel() {
    if (!state || !state.minimized) return;
    state.minimized = false;
    applyPanelVisibility();
    saveState();
    dispatchPanelState("open");
  }

  function applyPanelStateFromStore(ui) {
    if (!state || !active) return;
    const ps = ui?.participantsPanelState;
    if (ps === "minimized") state.minimized = true;
    else if (ps === "open") state.minimized = false;
    applyPanelVisibility();
  }

  function shouldAllowActivate() {
    const store = global.AppState?.getState?.();
    if (!global.AppState?.isShareActive?.(store)) return false;
    if (store?.ui?.currentLayout !== "share") return false;
    return true;
  }

  function activate(options = {}) {
    if (options.fromBlur && shouldSuppressBlurAutoFloatPanel()) return;
    if (!options.fromBlur && shouldBlockFloatPanelActivateFromBlur()) return;
    if (global.AppState?.getState?.()?.flags?.enableParticipantsPanel === false) return;
    if (!shouldAllowActivate()) return;
    ensureDom();
    suppressDesktopPresenterUi();
    const wasActive = active;
    if (!active) {
      state = loadState() || defaultState();
      const c = clampBox(state.left, state.top, state.width, state.height);
      state = { ...state, ...c };
      // Al entrar en layout de share, expandir siempre (no restaurar minimizado de sesiones previas).
      state.minimized = false;
      userSizedPanel = false;
      active = true;
      dispatchPanelState("open");
    }
    const shell = getShellEl();
    const modClass = shareModularClass();
    shell?.classList.toggle(modClass, true);
    shell?.classList.remove("room-shell--web-layout");
    mountVideos();
    applyPanelVisibility();
    if (!wasActive) {
      global.requestAnimationFrame(() => {
        avoidStageOverlap();
        syncPanelVisibilityForTiles();
      });
    }
  }

  function deactivate(options = {}) {
    if (!active && !options.force) return;
    saveState();
    unmountVideos();
    rootEl?.classList.add("hidden");
    pillEl?.classList.add("hidden");
    const shell = getShellEl();
    shell?.classList.toggle(shareModularClass(), false);
    shell?.classList.remove("room-shell--web-layout");
    active = false;
    drag = null;
    resizeDrag = null;
    if (options.destroyDom) {
      try {
        rootEl?.remove();
        pillEl?.remove();
      } catch (_) {}
      rootEl = null;
      pillEl = null;
      headerEl = null;
      bodyEl = null;
      resizeEl = null;
      domReady = false;
    }
  }

  function init(options = {}) {
    deps = options;
  }

  function isActive() {
    return active;
  }

  function onShareLayoutChange() {
    if (!active) return;
    if (global.AppState?.getState?.()?.flags?.enableParticipantsPanel === false) {
      deactivate({ force: true, destroyDom: true });
      return;
    }
    suppressDesktopPresenterUi();
    global.RoomScreenShareLayout?.ensurePresenterMediaDock?.();
    if (state && !drag && !resizeDrag) {
      const c = clampBox(state.left, state.top, state.width, state.height);
      state.left = c.left;
      state.top = c.top;
      state.width = c.width;
      state.height = c.height;
      applyLayout();
      avoidStageOverlap();
      if (videosEl) filterScreenShareTilesInPanel(videosEl);
      global.requestAnimationFrame(shrinkPanelToFitContent);
    }
    syncPanelVisibilityForTiles();
  }

  global.FloatPanelModule = {
    init,
    activate,
    deactivate,
    onShareLayoutChange,
    isActive,
    countVisiblePeerTiles,
    syncPanelVisibilityForTiles,
    applyPanelVisibility,
    applyPanelStateFromStore,
    minimizePanel,
    restorePanel,
  };
})(typeof window !== "undefined" ? window : global);
