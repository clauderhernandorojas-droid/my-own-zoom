/**
 * PencilFabToolbar.js — FAB, barra de herramientas y dock de anotación (screen overlay).
 * @version 20250603c
 */
(function (global) {
  const FAB_SIZE = 44;
  const FAB_MARGIN = 16;
  const FAB_DRAG_THRESHOLD_PX = 6;
  const TOOLBAR_GAP = 6;
  const TOOLBAR_ATTACH_MAX_PX = 14;
  const FAB_STORAGE_KEY = "moj_screen_overlay_fab_pos_v2";
  const FAB_STORAGE_KEY_LEGACY = "moj_screen_overlay_fab_pos";
  const TOOLBAR_STORAGE_KEY = "moj_screen_overlay_toolbar_pos_v1";
  const ANNOTATE_DOCK_STORAGE_KEY = "moj_screen_overlay_annotate_dock_v1";
  const SNAP_THRESHOLD_PX = 24;

  function create(options = {}) {
    const {
      getStageEl,
      getUiLayerEl,
      getIsPresenterFocus,
      getRoomId = () => "",
      getStageMetrics = () => ({ w: 400, h: 300 }),
      ensureOverlayUiLayer = () => null,
      removeOrphanOverlayUiFromStage = () => {},
      buildToolbar,
      onToolbarBuilt,
      onToolbarOpenChange,
      onGuestLayoutSync = () => {},
      isEditingText = () => false,
      log = () => {},
    } = options;

    const g = options.global || global;
    const UiFloatClamp = options.UiFloatClamp || global.UiFloatClamp;

    let fabHostEl = null;
    let fabEl = null;
    let annotateDockHostEl = null;
    let toolbarHostEl = null;
    let toolbarApi = null;
    let fabPos = null;
    let toolbarPos = null;
    let annotateDockPos = null;
    let toolbarDrag = null;
    let lastToolbarPlacement = null;
    let fabDrag = null;
    let lastFabClickAt = 0;
    let windowResizeHandler = null;
    let toolbarOpen = false;

  function onFabPointerMove(e) {
    if (!fabDrag || e.pointerId !== fabDrag.pointerId) return;
    const dx = e.clientX - fabDrag.startX;
    const dy = e.clientY - fabDrag.startY;
    if (!fabDrag.dragging && Math.hypot(dx, dy) >= FAB_DRAG_THRESHOLD_PX) {
      fabDrag.dragging = true;
      fabEl?.classList.add("screen-overlay-fab--dragging");
      annotateDockHostEl?.classList.add("screen-overlay-annotate-dock--dragging");
      if (isPresenterFocusMode() && annotateDockPos?.edge) {
        annotateDockPos.edge = null;
        annotateDockHostEl?.classList.remove(
          "screen-overlay-annotate-dock--edge-top",
          "screen-overlay-annotate-dock--edge-bottom",
          "screen-overlay-annotate-dock--edge-left",
          "screen-overlay-annotate-dock--edge-right"
        );
      }
    }
    if (!fabDrag.dragging) return;
    e.preventDefault();
    if (isPresenterFocusMode() && annotateDockHostEl) {
      annotateDockPos = clampAnnotateDockPosition(
        fabDrag.originLeft + dx,
        fabDrag.originTop + dy
      );
      applyAnnotateDockPosition();
      return;
    }
    const clamped = clampFabPosition(fabDrag.originLeft + dx, fabDrag.originTop + dy);
    fabPos = clamped;
    applyFabPosition();
    if (toolbarOpen) scheduleToolbarPlacement();
  }

  function onFabPointerUp(e) {
    if (!fabDrag || e.pointerId !== fabDrag.pointerId) return;
    const wasDrag = fabDrag.dragging;
    fabDrag = null;
    fabEl?.classList.remove("screen-overlay-fab--dragging");
    annotateDockHostEl?.classList.remove("screen-overlay-annotate-dock--dragging");
    try {
      fabEl?.releasePointerCapture(e.pointerId);
    } catch (_) {}
    g.removeEventListener("pointermove", onFabPointerMove);
    g.removeEventListener("pointerup", onFabPointerUp);
    g.removeEventListener("pointercancel", onFabPointerUp);
    if (wasDrag) {
      if (isPresenterFocusMode() && annotateDockHostEl) {
        snapAnnotateDockToNearestEdge();
        saveAnnotateDockPosition();
      } else {
        saveFabPosition();
        if (!isPresenterFocusMode()) {
          onGuestLayoutSync("fab-release");
        }
      }
    } else {
      const now = Date.now();
      if (isPresenterFocusMode() && annotateDockPos?.edge) {
        if (lastFabClickAt && now - lastFabClickAt < 450) {
          annotateDockPos.edge = null;
          annotateDockPos.orientation = annotateDockPos.orientation || "horizontal";
          lastFabClickAt = 0;
          saveAnnotateDockPosition();
          applyAnnotateDockPosition();
        } else {
          lastFabClickAt = now;
          setToolbarOpen(!toolbarOpen);
        }
        return;
      }
      lastFabClickAt = now;
      setToolbarOpen(!toolbarOpen);
    }
  }

  function onFabPointerDown(e) {
    if (!fabEl || !getStageEl()) return;
    if (!isPresenterFocusMode() && !fabHostEl) return;
    if (isPresenterFocusMode() && !annotateDockHostEl) return;
    e.preventDefault();
    e.stopPropagation();
    if (isPresenterFocusMode() && annotateDockHostEl) {
      if (!annotateDockPos) annotateDockPos = defaultAnnotateDockPosition();
      fabDrag = {
        dragging: false,
        startX: e.clientX,
        startY: e.clientY,
        originLeft: annotateDockPos.left,
        originTop: annotateDockPos.top,
        pointerId: e.pointerId,
      };
    } else {
      if (fabPos == null) fabPos = defaultFabPosition();
      fabDrag = {
        dragging: false,
        startX: e.clientX,
        startY: e.clientY,
        originLeft: fabPos.left,
        originTop: fabPos.top,
        pointerId: e.pointerId,
      };
    }
    try {
      fabEl.setPointerCapture(e.pointerId);
    } catch (_) {}
    g.addEventListener("pointermove", onFabPointerMove);
    g.addEventListener("pointerup", onFabPointerUp);
    g.addEventListener("pointercancel", onFabPointerUp);
  }
  function onEscapeKey(e) {
    if (e.key !== "Escape" || !toolbarOpen) return;
    if (isEditingText?.()) return;
    e.preventDefault();
    setToolbarOpen(false);
  }
  function getFabSize() {
    if (!fabEl) return FAB_SIZE;
    const r = fabEl.getBoundingClientRect();
    return r.width || FAB_SIZE;
  }

  function isPresenterFocusMode() {
    return !!getIsPresenterFocus?.();
  }

  /** Reserva inferior en coords del ui layer (barra de medios flotante de la sala). */
  function getGuestBottomUiReserve() {
    if (isPresenterFocusMode()) return FAB_MARGIN;
    const layer = getUiLayerEl?.();
    if (!layer) return 88;
    const layerRect = layer.getBoundingClientRect();
    const bar =
      document.querySelector(
        ".room-shell--remote-screen-dominant .room-media-controls--presenter-float"
      ) || document.getElementById("roomMediaControls");
    if (!bar || bar.offsetParent === null) return 88;
    const barRect = bar.getBoundingClientRect();
    return Math.max(72, Math.ceil(layerRect.bottom - barRect.top + 14));
  }
  function annotateDockStorageKey() {
    const rid = getRoomId();
    return rid ? `${ANNOTATE_DOCK_STORAGE_KEY}_${rid}` : ANNOTATE_DOCK_STORAGE_KEY;
  }

  function measureAnnotateDockSize() {
    if (!annotateDockHostEl) return { w: FAB_SIZE, h: FAB_SIZE };
    const r = annotateDockHostEl.getBoundingClientRect();
    return { w: r.width || FAB_SIZE, h: r.height || FAB_SIZE };
  }

  function defaultAnnotateDockPosition() {
    const { w: stageW, h: stageH } = getStageMetrics();
    const { w: dockW, h: dockH } = measureAnnotateDockSize();
    return {
      left: FAB_MARGIN,
      top: Math.max(FAB_MARGIN, stageH - dockH - FAB_MARGIN),
      edge: "bottom",
      orientation: "horizontal",
    };
  }

  function loadAnnotateDockRaw() {
    try {
      const raw = g.localStorage?.getItem(annotateDockStorageKey());
      if (raw) {
        const p = JSON.parse(raw);
        if (Number.isFinite(p?.left) && Number.isFinite(p?.top)) {
          return {
            left: p.left,
            top: p.top,
            edge: p.edge || null,
            orientation: p.orientation || "horizontal",
            collapsed: !!p.collapsed,
          };
        }
      }
      const fab = loadFabPositionRaw();
      if (fab) {
        return {
          left: fab.left,
          top: fab.top,
          edge: null,
          orientation: "horizontal",
          collapsed: true,
        };
      }
    } catch (_) {}
    return null;
  }

  function saveAnnotateDockPosition() {
    if (!annotateDockPos) return;
    try {
      g.localStorage?.setItem(
        annotateDockStorageKey(),
        JSON.stringify({
          v: 1,
          left: annotateDockPos.left,
          top: annotateDockPos.top,
          edge: annotateDockPos.edge || null,
          orientation: annotateDockPos.orientation || "horizontal",
          collapsed: !toolbarOpen,
        })
      );
    } catch (_) {}
  }

  function clampAnnotateDockPosition(left, top) {
    const { w: dockW, h: dockH } = measureAnnotateDockSize();
    const edge = annotateDockPos?.edge ?? null;
    const orientation = annotateDockPos?.orientation ?? "horizontal";
    let nextLeft = left;
    let nextTop = top;
    if (g.UiFloatClamp?.clampDockPosition) {
      const c = g.UiFloatClamp.clampDockPosition({
        left,
        top,
        width: dockW,
        height: dockH,
        margin: FAB_MARGIN,
      });
      nextLeft = c.left;
      nextTop = c.top;
    } else {
      const { w: stageW, h: stageH } = getStageMetrics();
      const maxLeft = Math.max(FAB_MARGIN, stageW - dockW - FAB_MARGIN);
      const maxTop = Math.max(FAB_MARGIN, stageH - dockH - FAB_MARGIN);
      nextLeft = Math.min(maxLeft, Math.max(FAB_MARGIN, left));
      nextTop = Math.min(maxTop, Math.max(FAB_MARGIN, top));
    }
    if (edge === "bottom" || edge === "top") {
      const { w: stageW } = getStageMetrics();
      nextLeft = Math.min(
        Math.max(FAB_MARGIN, nextLeft),
        Math.max(FAB_MARGIN, stageW - dockW - FAB_MARGIN)
      );
      if (edge === "bottom") {
        const { h: stageH } = getStageMetrics();
        nextTop = Math.max(FAB_MARGIN, stageH - dockH - FAB_MARGIN);
      } else if (edge === "top") {
        nextTop = FAB_MARGIN;
      }
    }
    return {
      left: nextLeft,
      top: nextTop,
      edge,
      orientation,
    };
  }

  function applyAnnotateDockEdgeClasses() {
    if (!annotateDockHostEl || !annotateDockPos) return;
    annotateDockHostEl.classList.remove(
      "screen-overlay-annotate-dock--edge-top",
      "screen-overlay-annotate-dock--edge-bottom",
      "screen-overlay-annotate-dock--edge-left",
      "screen-overlay-annotate-dock--edge-right"
    );
    const edge = annotateDockPos.edge;
    if (edge) {
      annotateDockHostEl.classList.add(`screen-overlay-annotate-dock--edge-${edge}`);
    }
    const orient = annotateDockPos.orientation === "vertical" ? "vertical" : "horizontal";
    annotateDockHostEl.classList.toggle(
      "screen-overlay-annotate-dock--orient-vertical",
      orient === "vertical"
    );
    annotateDockHostEl.classList.toggle(
      "screen-overlay-annotate-dock--orient-horizontal",
      orient === "horizontal"
    );
    if (toolbarHostEl) {
      toolbarHostEl.classList.toggle("screen-overlay-toolbar-host--v", orient === "vertical");
      toolbarHostEl.classList.toggle("screen-overlay-toolbar-host--h", orient === "horizontal");
    }
  }

  function applyAnnotateDockPosition() {
    if (!annotateDockHostEl || !annotateDockPos) return;
    annotateDockHostEl.style.left = `${annotateDockPos.left}px`;
    annotateDockHostEl.style.top = `${annotateDockPos.top}px`;
    applyAnnotateDockEdgeClasses();
  }

  function snapAnnotateDockToNearestEdge() {
    if (!annotateDockPos || !annotateDockHostEl) return;
    const { w: stageW, h: stageH } = getStageMetrics();
    const { w: dockW, h: dockH } = measureAnnotateDockSize();
    const left = annotateDockPos.left;
    const top = annotateDockPos.top;
    const distTop = top;
    const distBottom = stageH - (top + dockH);
    const distLeft = left;
    const distRight = stageW - (left + dockW);
    const within = (d) => d <= SNAP_THRESHOLD_PX;
    if (!within(distTop) && !within(distBottom) && !within(distLeft) && !within(distRight)) {
      return;
    }

    let edge = "bottom";
    let orientation = "horizontal";
    if (within(distTop) && within(distRight)) {
      edge = "right";
      orientation = "vertical";
      annotateDockPos.left = Math.max(FAB_MARGIN, stageW - dockW - FAB_MARGIN);
      annotateDockPos.top = Math.min(
        Math.max(FAB_MARGIN, top),
        Math.max(FAB_MARGIN, stageH - dockH - FAB_MARGIN)
      );
    } else {
      const candidates = [
        { edge: "top", dist: distTop, orientation: "horizontal" },
        { edge: "bottom", dist: distBottom, orientation: "horizontal" },
        { edge: "left", dist: distLeft, orientation: "vertical" },
        { edge: "right", dist: distRight, orientation: "vertical" },
      ].filter((c) => within(c.dist));
      const chosen = candidates.reduce((a, b) => (a.dist <= b.dist ? a : b));
      edge = chosen.edge;
      orientation = chosen.orientation;
      if (edge === "top") {
        annotateDockPos.top = FAB_MARGIN;
        annotateDockPos.left = Math.min(
          Math.max(FAB_MARGIN, left),
          Math.max(FAB_MARGIN, stageW - dockW - FAB_MARGIN)
        );
      } else if (edge === "bottom") {
        annotateDockPos.top = Math.max(FAB_MARGIN, stageH - dockH - FAB_MARGIN);
        annotateDockPos.left = Math.min(
          Math.max(FAB_MARGIN, left),
          Math.max(FAB_MARGIN, stageW - dockW - FAB_MARGIN)
        );
      } else if (edge === "left") {
        annotateDockPos.left = FAB_MARGIN;
        annotateDockPos.top = Math.min(
          Math.max(FAB_MARGIN, top),
          Math.max(FAB_MARGIN, stageH - dockH - FAB_MARGIN)
        );
      } else {
        annotateDockPos.left = Math.max(FAB_MARGIN, stageW - dockW - FAB_MARGIN);
        annotateDockPos.top = Math.min(
          Math.max(FAB_MARGIN, top),
          Math.max(FAB_MARGIN, stageH - dockH - FAB_MARGIN)
        );
      }
    }
    annotateDockPos.edge = edge;
    annotateDockPos.orientation = orientation;
    applyAnnotateDockPosition();
  }

  function revalidateAnnotateDockPosition() {
    if (!annotateDockHostEl || !annotateDockPos) return;
    annotateDockPos = clampAnnotateDockPosition(annotateDockPos.left, annotateDockPos.top);
    applyAnnotateDockPosition();
  }

  function onWindowResizeForOverlay() {
    if (isPresenterFocusMode()) {
      revalidateAnnotateDockPosition();
    } else if (fabPos) {
      revalidateFabPosition();
    }
    onGuestLayoutSync("window-resize");
  }

  function bindWindowResize() {
    if (windowResizeHandler) return;
    windowResizeHandler = onWindowResizeForOverlay;
    g.addEventListener("resize", windowResizeHandler);
  }

  function unbindWindowResize() {
    if (!windowResizeHandler) return;
    g.removeEventListener("resize", windowResizeHandler);
    windowResizeHandler = null;
  }

  function createToolbarInHost(host) {
    const api = buildToolbar?.(host);
    if (!api) {
      log("UiAnnotationToolbar no disponible");
      return;
    }
    toolbarApi = api;
    onToolbarBuilt?.();
  }

  function ensureAnnotateDock() {
    if (!getStageEl() || !isPresenterFocusMode()) return;
    removeOrphanOverlayUiFromStage();
    if (annotateDockHostEl) return;

    if (fabHostEl) removeFab();
    if (toolbarHostEl && !annotateDockHostEl) removeToolbar();

    const layer = ensureOverlayUiLayer();
    if (!layer) return;

    const raw = loadAnnotateDockRaw();
    annotateDockPos = raw
      ? clampAnnotateDockPosition(raw.left, raw.top)
      : defaultAnnotateDockPosition();
    if (raw) {
      annotateDockPos.edge = raw.edge;
      annotateDockPos.orientation = raw.orientation || "horizontal";
    }

    annotateDockHostEl = document.createElement("div");
    annotateDockHostEl.className = "screen-overlay-annotate-dock";

    const inner = document.createElement("div");
    inner.className = "screen-overlay-annotate-dock-inner";

    fabEl = document.createElement("button");
    fabEl.type = "button";
    fabEl.className = "screen-overlay-fab screen-overlay-fab--in-dock";
    fabEl.title = "Anotaciones (arrastrar para mover)";
    fabEl.setAttribute("aria-label", "Anotaciones sobre pantalla compartida");
    fabEl.setAttribute("aria-expanded", "false");
    fabEl.textContent = "✏️";

    toolbarHostEl = document.createElement("div");
    toolbarHostEl.className = "screen-overlay-toolbar-host screen-overlay-toolbar-host--h hidden";
    toolbarHostEl.setAttribute("aria-hidden", "true");

    inner.appendChild(fabEl);
    inner.appendChild(toolbarHostEl);
    annotateDockHostEl.appendChild(inner);
    layer.appendChild(annotateDockHostEl);
    layer.setAttribute("aria-hidden", toolbarOpen ? "false" : "true");

    fabEl.addEventListener("pointerdown", onFabPointerDown);
    g.addEventListener("keydown", onEscapeKey);

    createToolbarInHost(toolbarHostEl);
    applyAnnotateDockPosition();

    const startOpen = raw ? !raw.collapsed : false;
    setToolbarOpen(startOpen);
    bindWindowResize();
  }

  function removeAnnotateDock() {
    g.removeEventListener("keydown", onEscapeKey);
    g.removeEventListener("pointermove", onFabPointerMove);
    g.removeEventListener("pointerup", onFabPointerUp);
    g.removeEventListener("pointercancel", onFabPointerUp);
    fabDrag = null;
    if (fabEl) {
      fabEl.removeEventListener("pointerdown", onFabPointerDown);
    }
    toolbarApi?.destroy?.();
    toolbarApi = null;
    if (annotateDockHostEl?.parentElement) annotateDockHostEl.remove();
    annotateDockHostEl = null;
    toolbarHostEl = null;
    fabEl = null;
    annotateDockPos = null;
    if (!fabHostEl) unbindWindowResize();
  }

  function defaultFabPosition() {
    const { w: stageW, h: stageH } = getStageMetrics();
    const sh = stageH || 300;
    const size = getFabSize();
    const bottomPad = isPresenterFocusMode() ? FAB_MARGIN : getGuestBottomUiReserve();
    return {
      left: FAB_MARGIN,
      top: Math.max(FAB_MARGIN, sh - size - bottomPad),
    };
  }

  function fabStorageKey() {
    const rid = getRoomId();
    return rid ? `${FAB_STORAGE_KEY}_${rid}` : FAB_STORAGE_KEY;
  }

  function loadFabPositionRaw() {
    try {
      let raw = g.localStorage?.getItem(fabStorageKey());
      if (!raw) raw = g.localStorage?.getItem(FAB_STORAGE_KEY);
      if (!raw) raw = g.localStorage?.getItem(FAB_STORAGE_KEY_LEGACY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Number.isFinite(parsed?.left) && Number.isFinite(parsed?.top)) {
        return { left: parsed.left, top: parsed.top, fromLegacy: !parsed.v };
      }
    } catch (_) {}
    return null;
  }

  function isLegacyFabQuadrant(pos, stageW, stageH, fabSize) {
    if (!pos || !stageW || !stageH) return true;
    const topRatio = pos.top / Math.max(1, stageH - fabSize);
    const leftRatio = pos.left / Math.max(1, stageW - fabSize);
    return topRatio < 0.28 && leftRatio > 0.52;
  }

  function normalizeFabPosition(pos, opts = {}) {
    const { w: stageW, h: stageH } = getStageMetrics();
    const size = getFabSize();
    if (!stageW || !stageH) return defaultFabPosition();
    if (!pos) return clampFabPosition(defaultFabPosition().left, defaultFabPosition().top);
    if (opts.fromLegacy || isLegacyFabQuadrant(pos, stageW, stageH, size)) {
      const def = defaultFabPosition();
      return clampFabPosition(def.left, def.top);
    }
    return clampFabPosition(pos.left, pos.top);
  }

  function revalidateFabPosition() {
    if (!getStageEl()) return;
    if (isPresenterFocusMode()) {
      revalidateAnnotateDockPosition();
      return;
    }
    if (!fabPos) return;
    if (!Number.isFinite(fabPos.left) || !Number.isFinite(fabPos.top)) {
      fabPos = defaultFabPosition();
    } else {
      fabPos = clampFabPosition(fabPos.left, fabPos.top);
    }
    applyFabPosition();
    if (toolbarOpen) scheduleToolbarPlacement();
    onGuestLayoutSync("fab-revalidate");
  }

  function saveFabPosition() {
    if (!fabPos) return;
    try {
      g.localStorage?.setItem(
        fabStorageKey(),
        JSON.stringify({ v: 2, left: fabPos.left, top: fabPos.top })
      );
    } catch (_) {}
  }

  function rectsOverlapFabToolbar(left, top, toolbarW, toolbarH, fabSize) {
    if (!fabPos) return false;
    const fabRight = fabPos.left + fabSize;
    const fabBottom = fabPos.top + fabSize;
    const tbRight = left + toolbarW;
    const tbBottom = top + toolbarH;
    return !(
      fabRight <= left ||
      fabPos.left >= tbRight ||
      fabBottom <= top ||
      fabPos.top >= tbBottom
    );
  }

  function placementOverlapsFab(left, top, toolbarW, toolbarH, fabSize) {
    return rectsOverlapFabToolbar(left, top, toolbarW, toolbarH, fabSize);
  }

  function isCompactStage(stageH, fabSize, _toolbarW, toolbarH) {
    return toolbarH + fabSize + 3 * FAB_MARGIN > stageH;
  }

  function alignToolbarTopBesideFab(fabTop, fabSize, toolbarH, stageH) {
    const maxTop = Math.max(FAB_MARGIN, stageH - toolbarH - FAB_MARGIN);
    if (fabTop + toolbarH <= stageH - FAB_MARGIN) {
      return {
        top: Math.min(maxTop, Math.max(FAB_MARGIN, fabTop)),
        needsHorizontal: false,
      };
    }
    const bottomAlign = fabTop + fabSize - toolbarH;
    if (
      bottomAlign >= FAB_MARGIN &&
      bottomAlign + toolbarH <= stageH - FAB_MARGIN
    ) {
      return { top: bottomAlign, needsHorizontal: false };
    }
    return { top: FAB_MARGIN, needsHorizontal: true };
  }

  function toolbarPlacementValid(left, top, toolbarW, toolbarH, stageW, stageH, fabSize) {
    return (
      toolbarFitsInStage(left, top, toolbarW, toolbarH, stageW, stageH) &&
      !placementOverlapsFab(left, top, toolbarW, toolbarH, fabSize)
    );
  }

  function clampFabPosition(left, top) {
    const { w: stageW, h: stageH } = getStageMetrics();
    const sw = stageW || 400;
    const sh = stageH || 300;
    const size = getFabSize();
    const bottomPad = isPresenterFocusMode() ? FAB_MARGIN : getGuestBottomUiReserve();
    const maxLeft = Math.max(FAB_MARGIN, sw - size - FAB_MARGIN);
    const maxTop = Math.max(FAB_MARGIN, sh - size - bottomPad);
    return {
      left: Math.min(maxLeft, Math.max(FAB_MARGIN, left)),
      top: Math.min(maxTop, Math.max(FAB_MARGIN, top)),
    };
  }

  function applyFabPosition() {
    if (!fabHostEl || !fabPos) return;
    fabHostEl.style.left = `${fabPos.left}px`;
    fabHostEl.style.top = `${fabPos.top}px`;
  }

  function toolbarStorageKey() {
    const rid = getRoomId();
    return rid ? `${TOOLBAR_STORAGE_KEY}_${rid}` : TOOLBAR_STORAGE_KEY;
  }

  function loadToolbarPositionRaw() {
    try {
      const raw = g.localStorage?.getItem(toolbarStorageKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Number.isFinite(parsed?.left) && Number.isFinite(parsed?.top)) {
        return { left: parsed.left, top: parsed.top };
      }
    } catch (_) {}
    return null;
  }

  function saveToolbarPosition() {
    if (!toolbarPos) return;
    try {
      g.localStorage?.setItem(
        toolbarStorageKey(),
        JSON.stringify({ v: 1, left: toolbarPos.left, top: toolbarPos.top })
      );
    } catch (_) {}
  }

  function defaultToolbarPosition() {
    const { w: stageW, h: stageH } = getStageMetrics();
    const sz = measureToolbarSize("vertical");
    const tw = sz.w || 48;
    const th = sz.h || 200;
    return clampToolbarPos(
      (fabPos?.left ?? FAB_MARGIN) + getFabSize() + TOOLBAR_GAP,
      Math.max(FAB_MARGIN, (fabPos?.top ?? stageH - th - FAB_MARGIN) - th - TOOLBAR_GAP),
      tw,
      th,
      stageW,
      stageH
    );
  }

  function applyToolbarFreePosition() {
    if (!toolbarHostEl || !toolbarPos) return;
    toolbarHostEl.classList.add("screen-overlay-toolbar-host--free-drag");
    toolbarHostEl.style.left = `${toolbarPos.left}px`;
    toolbarHostEl.style.top = `${toolbarPos.top}px`;
  }

  function onToolbarPointerMove(e) {
    if (!toolbarDrag || e.pointerId !== toolbarDrag.pointerId) return;
    const dx = e.clientX - toolbarDrag.startX;
    const dy = e.clientY - toolbarDrag.startY;
    if (!toolbarDrag.dragging && Math.hypot(dx, dy) < FAB_DRAG_THRESHOLD_PX) {
      return;
    }
    if (!toolbarDrag.dragging) {
      toolbarDrag.dragging = true;
      toolbarHostEl?.classList.add("screen-overlay-toolbar-host--dragging");
    }
    e.preventDefault();
    const { w: stageW, h: stageH } = getStageMetrics();
    const sz = measureToolbarSize(
      toolbarHostEl?.classList.contains("screen-overlay-toolbar-host--h") ? "horizontal" : "vertical"
    );
    const tw = lastToolbarPlacement?.toolbarW || sz.w || 48;
    const th = lastToolbarPlacement?.toolbarH || sz.h || 200;
    toolbarPos = clampToolbarPos(
      toolbarDrag.originLeft + dx,
      toolbarDrag.originTop + dy,
      tw,
      th,
      stageW,
      stageH
    );
    applyToolbarFreePosition();
  }

  function onToolbarPointerUp(e) {
    if (!toolbarDrag || e.pointerId !== toolbarDrag.pointerId) return;
    const wasDrag = toolbarDrag.dragging;
    toolbarDrag = null;
    toolbarHostEl?.classList.remove("screen-overlay-toolbar-host--dragging");
    try {
      toolbarHostEl?.releasePointerCapture(e.pointerId);
    } catch (_) {}
    g.removeEventListener("pointermove", onToolbarPointerMove);
    g.removeEventListener("pointerup", onToolbarPointerUp);
    g.removeEventListener("pointercancel", onToolbarPointerUp);
    if (wasDrag) saveToolbarPosition();
  }

  function onToolbarPointerDown(e) {
    if (!toolbarHostEl || !isPresenterFocusMode()) return;
    if (e.target.closest?.("button, input, select, textarea, .screen-overlay-side-menu")) return;
    e.preventDefault();
    e.stopPropagation();
    if (!toolbarPos) {
      const raw = loadToolbarPositionRaw();
      toolbarPos = raw || defaultToolbarPosition();
    }
    toolbarDrag = {
      dragging: false,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: toolbarPos.left,
      originTop: toolbarPos.top,
      pointerId: e.pointerId,
    };
    try {
      toolbarHostEl.setPointerCapture(e.pointerId);
    } catch (_) {}
    g.addEventListener("pointermove", onToolbarPointerMove);
    g.addEventListener("pointerup", onToolbarPointerUp);
    g.addEventListener("pointercancel", onToolbarPointerUp);
  }

  function scheduleToolbarPlacement() {
    if (isPresenterFocusMode()) return;
    schedulePositionToolbarNearFab();
  }

  function toolbarFitsInStage(left, top, toolbarW, toolbarH, stageW, stageH) {
    return (
      left >= FAB_MARGIN &&
      top >= FAB_MARGIN &&
      left + toolbarW <= stageW - FAB_MARGIN &&
      top + toolbarH <= stageH - FAB_MARGIN
    );
  }

  function clampToolbarPos(left, top, toolbarW, toolbarH, stageW, stageH) {
    const maxLeft = Math.max(FAB_MARGIN, stageW - toolbarW - FAB_MARGIN);
    const maxTop = Math.max(FAB_MARGIN, stageH - toolbarH - FAB_MARGIN);
    return {
      left: Math.min(maxLeft, Math.max(FAB_MARGIN, left)),
      top: Math.min(maxTop, Math.max(FAB_MARGIN, top)),
    };
  }

  function toolbarAttachedToFab(left, top, toolbarW, toolbarH, fabSize, gap) {
    const fabBottom = fabPos.top + fabSize;
    const fabRight = fabPos.left + fabSize;
    const toolbarBottom = top + toolbarH;
    const toolbarRight = left + toolbarW;
    const above =
      Math.abs(toolbarBottom + gap - fabPos.top) <= TOOLBAR_ATTACH_MAX_PX &&
      toolbarRight > fabPos.left - TOOLBAR_ATTACH_MAX_PX &&
      left < fabRight + TOOLBAR_ATTACH_MAX_PX;
    const below =
      Math.abs(top - gap - fabBottom) <= TOOLBAR_ATTACH_MAX_PX &&
      toolbarRight > fabPos.left - TOOLBAR_ATTACH_MAX_PX &&
      left < fabRight + TOOLBAR_ATTACH_MAX_PX;
    const rightOf =
      Math.abs(left - gap - fabRight) <= TOOLBAR_ATTACH_MAX_PX &&
      toolbarBottom > fabPos.top - TOOLBAR_ATTACH_MAX_PX &&
      top < fabBottom + TOOLBAR_ATTACH_MAX_PX;
    const leftOf =
      Math.abs(toolbarRight + gap - fabPos.left) <= TOOLBAR_ATTACH_MAX_PX &&
      toolbarBottom > fabPos.top - TOOLBAR_ATTACH_MAX_PX &&
      top < fabBottom + TOOLBAR_ATTACH_MAX_PX;
    return above || below || rightOf || leftOf;
  }

  function buildToolbarCandidates(stageW, stageH, fabSize, toolbarW, toolbarH, gap, preferVertical) {
    const alignLeft = Math.max(
      FAB_MARGIN,
      Math.min(fabPos.left, stageW - toolbarW - FAB_MARGIN)
    );
    const beside = alignToolbarTopBesideFab(fabPos.top, fabSize, toolbarH, stageH);
    const above = {
      anchor: "above",
      orientation: "vertical",
      left: alignLeft,
      top: fabPos.top - toolbarH - gap,
    };
    const below = {
      anchor: "below",
      orientation: "vertical",
      left: alignLeft,
      top: fabPos.top + fabSize + gap,
    };
    const rightH = {
      anchor: "right",
      orientation: "horizontal",
      left: fabPos.left + fabSize + gap,
      top: Math.max(
        FAB_MARGIN,
        Math.min(fabPos.top, stageH - toolbarH - FAB_MARGIN)
      ),
    };
    const leftH = {
      anchor: "left",
      orientation: "horizontal",
      left: fabPos.left - toolbarW - gap,
      top: Math.max(
        FAB_MARGIN,
        Math.min(fabPos.top, stageH - toolbarH - FAB_MARGIN)
      ),
    };
    const rightVertical = {
      anchor: "rightVertical",
      orientation: "vertical",
      left: fabPos.left + fabSize + gap,
      top: beside.top,
    };

    const compact = isCompactStage(stageH, fabSize, toolbarW, toolbarH);
    const aboveFitsWithoutClamp = fabPos.top - toolbarH - gap >= FAB_MARGIN;

    if (compact) {
      return [rightH, leftH, rightVertical, below, above];
    }
    if (!aboveFitsWithoutClamp) {
      return [rightVertical, rightH, leftH, below, above];
    }
    if (preferVertical) {
      return [above, below, rightVertical, rightH, leftH];
    }
    return [rightH, leftH, above, below, rightVertical];
  }

  function alignLeftFallback(fabLeft, toolbarW, stageW) {
    return Math.max(FAB_MARGIN, Math.min(fabLeft, stageW - toolbarW - FAB_MARGIN));
  }

  function pickValidPlacement(candidates, toolbarW, toolbarH, stageW, stageH, fabSize, gap, requireAttach) {
    for (const c of candidates) {
      const clamped = clampToolbarPos(c.left, c.top, toolbarW, toolbarH, stageW, stageH);
      if (!toolbarPlacementValid(clamped.left, clamped.top, toolbarW, toolbarH, stageW, stageH, fabSize)) {
        continue;
      }
      if (
        requireAttach &&
        !toolbarAttachedToFab(clamped.left, clamped.top, toolbarW, toolbarH, fabSize, gap)
      ) {
        continue;
      }
      return { ...c, ...clamped };
    }
    return null;
  }

  function buildCompactHorizontalPlacement(stageW, stageH, fabSize, gap) {
    if (!toolbarHostEl) return null;
    toolbarHostEl.classList.remove("screen-overlay-toolbar-host--v");
    toolbarHostEl.classList.add("screen-overlay-toolbar-host--h");
    const m = measureToolbarSize("horizontal");
    const toolbarW = m.w || 320;
    const toolbarH = m.h || 48;
    const left = fabPos.left + fabSize + gap;
    const top = Math.max(
      FAB_MARGIN,
      Math.min(fabPos.top, stageH - toolbarH - FAB_MARGIN)
    );
    const clamped = clampToolbarPos(left, top, toolbarW, toolbarH, stageW, stageH);
    if (placementOverlapsFab(clamped.left, clamped.top, toolbarW, toolbarH, fabSize)) {
      return null;
    }
    return {
      anchor: "compactHorizontal",
      orientation: "horizontal",
      left: clamped.left,
      top: clamped.top,
      toolbarW,
      toolbarH,
    };
  }

  function computeToolbarPlacement(stageW, stageH, fabSize, toolbarW, toolbarH, gap) {
    const preferVertical = fabPos.top > stageH * 0.42;
    const candidates = buildToolbarCandidates(
      stageW,
      stageH,
      fabSize,
      toolbarW,
      toolbarH,
      gap,
      preferVertical
    );

    let chosen = pickValidPlacement(
      candidates,
      toolbarW,
      toolbarH,
      stageW,
      stageH,
      fabSize,
      gap,
      true
    );

    if (!chosen) {
      chosen = pickValidPlacement(
        candidates,
        toolbarW,
        toolbarH,
        stageW,
        stageH,
        fabSize,
        gap,
        false
      );
    }

    if (!chosen) {
      const compact = buildCompactHorizontalPlacement(stageW, stageH, fabSize, gap);
      if (compact) {
        chosen = compact;
      }
    }

    return chosen;
  }

  function measureToolbarSizeFromClone(orientation) {
    if (!toolbarHostEl) return { w: 0, h: 0 };
    const panel = toolbarHostEl.querySelector(".screen-overlay-toolbar-panel");
    if (!panel) return { w: 0, h: 0 };

    const probe = document.createElement("div");
    probe.className = "screen-overlay-toolbar-host";
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;width:auto;height:auto;";
    probe.classList.toggle("screen-overlay-toolbar-host--v", orientation === "vertical");
    probe.classList.toggle("screen-overlay-toolbar-host--h", orientation === "horizontal");
    const clone = panel.cloneNode(true);
    probe.appendChild(clone);
    document.body.appendChild(probe);
    const rect = clone.getBoundingClientRect();
    probe.remove();
    return {
      w: Math.ceil(rect.width || clone.offsetWidth || 0),
      h: Math.ceil(rect.height || clone.offsetHeight || 0),
    };
  }

  function measureToolbarSizeFallback(orientation, stageH, fabSize) {
    const probe = measureToolbarSizeFromClone(orientation);
    const defaultH = orientation === "vertical" ? 280 : 48;
    const defaultW = orientation === "vertical" ? 40 : 320;
    let h = probe.h || defaultH;
    if (orientation === "vertical" && stageH > 0) {
      h = Math.min(h, Math.max(120, stageH - fabSize - 2 * FAB_MARGIN));
    }
    return {
      w: probe.w || defaultW,
      h,
    };
  }

  function measureToolbarSize(orientation) {
    if (!toolbarHostEl) return { w: 0, h: 0 };
    const panel = toolbarHostEl.querySelector(".screen-overlay-toolbar-panel");
    if (!panel) return { w: 0, h: 0 };

    if (!toolbarHostEl.classList.contains("hidden")) {
      toolbarHostEl.classList.toggle(
        "screen-overlay-toolbar-host--v",
        orientation === "vertical"
      );
      toolbarHostEl.classList.toggle(
        "screen-overlay-toolbar-host--h",
        orientation === "horizontal"
      );
      const liveRect = panel.getBoundingClientRect();
      if (liveRect.width > 0 && liveRect.height > 0) {
        return {
          w: Math.ceil(liveRect.width),
          h: Math.ceil(liveRect.height),
        };
      }
    }

    return measureToolbarSizeFromClone(orientation);
  }

  function applyToolbarPlacementStyles(placement, toolbarW, toolbarH) {
    if (!toolbarHostEl || !placement) return;
    toolbarHostEl.classList.toggle(
      "screen-overlay-toolbar-host--v",
      placement.orientation === "vertical"
    );
    toolbarHostEl.classList.toggle(
      "screen-overlay-toolbar-host--h",
      placement.orientation === "horizontal"
    );
    toolbarHostEl.style.left = `${placement.left}px`;
    toolbarHostEl.style.top = `${placement.top}px`;
    lastToolbarPlacement = {
      anchor: placement.anchor,
      orientation: placement.orientation,
      left: placement.left,
      top: placement.top,
      toolbarW,
      toolbarH,
    };
  }

  function positionGuestToolbarBesideFab() {
    if (!toolbarHostEl || !fabHostEl || !fabPos) return;
    const { w: stageW, h: stageH } = getStageMetrics();
    if (stageW < 2 || stageH < 2) return;
    const fabSize = getFabSize();
    const gap = TOOLBAR_GAP;
    const bottomSafe = getGuestBottomUiReserve();

    toolbarHostEl.classList.add("screen-overlay-toolbar-host--v");
    toolbarHostEl.classList.remove("screen-overlay-toolbar-host--h");
    let { w: toolbarW, h: toolbarH } = measureToolbarSize("vertical");
    if (!toolbarW || !toolbarH) {
      const fb = measureToolbarSizeFallback("vertical", stageH, fabSize);
      toolbarW = fb.w;
      toolbarH = fb.h;
    }

    let left = fabPos.left + fabSize + gap;
    let top = fabPos.top;
    const maxLeft = Math.max(FAB_MARGIN, stageW - toolbarW - FAB_MARGIN);
    const maxTop = Math.max(FAB_MARGIN, stageH - toolbarH - bottomSafe);
    left = Math.min(maxLeft, Math.max(FAB_MARGIN, left));
    top = Math.min(maxTop, Math.max(FAB_MARGIN, top));

    if (top + toolbarH > fabPos.top && top < fabPos.top + fabSize) {
      top = Math.min(maxTop, fabPos.top + fabSize + gap);
      if (top + toolbarH > stageH - bottomSafe) {
        top = Math.max(FAB_MARGIN, fabPos.top - toolbarH - gap);
      }
    }

    applyToolbarPlacementStyles(
      {
        anchor: "guestBesideFab",
        orientation: "vertical",
        left,
        top,
        toolbarW,
        toolbarH,
      },
      toolbarW,
      toolbarH
    );
  }

  function positionToolbarNearFab() {
    if (isPresenterFocusMode()) {
      scheduleToolbarPlacement();
      return;
    }
    positionGuestToolbarBesideFab();
  }

  function resolveToolbarOverlap(placement, stageW, stageH, fabSize, toolbarW, toolbarH, gap) {
    if (!placement) return placement;

    const sizesFor = (orientation) => {
      if (orientation === placement.orientation) {
        return { w: toolbarW, h: toolbarH };
      }
      if (!toolbarHostEl) return { w: toolbarW, h: toolbarH };
      toolbarHostEl.classList.toggle(
        "screen-overlay-toolbar-host--v",
        orientation === "vertical"
      );
      toolbarHostEl.classList.toggle(
        "screen-overlay-toolbar-host--h",
        orientation === "horizontal"
      );
      const m = measureToolbarSize(orientation);
      if (m.w && m.h) return m;
      return measureToolbarSizeFallback(orientation, stageH, fabSize);
    };

    if (
      !placementOverlapsFab(
        placement.left,
        placement.top,
        toolbarW,
        toolbarH,
        fabSize
      )
    ) {
      return placement;
    }

    const beside = alignToolbarTopBesideFab(fabPos.top, fabSize, toolbarH, stageH);
    const tries = [
      {
        anchor: "rightVertical",
        orientation: "vertical",
        left: fabPos.left + fabSize + gap,
        top: beside.top,
      },
      {
        anchor: "rightVerticalBottom",
        orientation: "vertical",
        left: fabPos.left + fabSize + gap,
        top: fabPos.top + fabSize - toolbarH,
      },
      {
        anchor: "below",
        orientation: "vertical",
        left: alignLeftFallback(fabPos.left, toolbarW, stageW),
        top: fabPos.top + fabSize + gap,
      },
      {
        anchor: "right",
        orientation: "horizontal",
        left: fabPos.left + fabSize + gap,
        top: Math.max(
          FAB_MARGIN,
          Math.min(fabPos.top, stageH - toolbarH - FAB_MARGIN)
        ),
      },
    ];

    for (const t of tries) {
      const { w: tw, h: th } = sizesFor(t.orientation);
      const clamped = clampToolbarPos(t.left, t.top, tw, th, stageW, stageH);
      if (toolbarPlacementValid(clamped.left, clamped.top, tw, th, stageW, stageH, fabSize)) {
        return { ...t, ...clamped, toolbarW: tw, toolbarH: th };
      }
    }

    const compact = buildCompactHorizontalPlacement(stageW, stageH, fabSize, gap);
    if (compact) {
      return compact;
    }

    const hSizes = sizesFor("horizontal");
    const lastLeft = fabPos.left + fabSize + gap;
    const lastTop = Math.max(
      FAB_MARGIN,
      Math.min(fabPos.top, stageH - hSizes.h - FAB_MARGIN)
    );
    const clamped = clampToolbarPos(
      lastLeft,
      lastTop,
      hSizes.w,
      hSizes.h,
      stageW,
      stageH
    );
    if (
      !placementOverlapsFab(clamped.left, clamped.top, hSizes.w, hSizes.h, fabSize)
    ) {
      log("screenOverlay: placement horizontal de último recurso");
      return {
        anchor: "lastResortHorizontal",
        orientation: "horizontal",
        left: clamped.left,
        top: clamped.top,
        toolbarW: hSizes.w,
        toolbarH: hSizes.h,
      };
    }

    log("screenOverlay: no se pudo resolver solape toolbar/FAB");
    return placement;
  }
  
  function setToolbarOpen(open) {
    toolbarOpen = !!open;
    const uiLayerEl = getUiLayerEl?.();
    if (uiLayerEl) {
      uiLayerEl.setAttribute("aria-hidden", toolbarOpen ? "false" : "true");
    }
    if (toolbarHostEl) {
      toolbarHostEl.classList.toggle("hidden", !toolbarOpen);
      toolbarHostEl.setAttribute("aria-hidden", toolbarOpen ? "false" : "true");
    }
    fabEl?.classList.toggle("screen-overlay-fab--active", toolbarOpen);
    fabEl?.setAttribute("aria-expanded", toolbarOpen ? "true" : "false");
    if (annotateDockHostEl) {
      annotateDockHostEl.classList.toggle("screen-overlay-annotate-dock--collapsed", !toolbarOpen);
    }
    if (!toolbarOpen) {
      toolbarApi?.closeMenus?.();
      if (isPresenterFocusMode()) saveAnnotateDockPosition();
    } else {
      if (!isPresenterFocusMode()) scheduleToolbarPlacement();
      if (isPresenterFocusMode()) saveAnnotateDockPosition();
      onGuestLayoutSync("toolbar-open");
    }
    onToolbarOpenChange?.(toolbarOpen);
  }

  function schedulePositionToolbarNearFab() {
    if (isPresenterFocusMode()) {
      scheduleToolbarPlacement();
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        positionToolbarNearFab();
        requestAnimationFrame(() => positionToolbarNearFab());
      });
    });
  }
  function ensureFab() {
    if (!getStageEl()) return;
    removeOrphanOverlayUiFromStage();
    if (isPresenterFocusMode()) {
      ensureAnnotateDock();
      return;
    }
    if (annotateDockHostEl) removeAnnotateDock();
    if (fabHostEl) return;
    const layer = ensureOverlayUiLayer();
    if (!layer) return;

    const raw = loadFabPositionRaw();
    fabPos = normalizeFabPosition(raw, { fromLegacy: !!raw?.fromLegacy });

    fabHostEl = document.createElement("div");
    fabHostEl.className = "screen-overlay-fab-host";

    fabEl = document.createElement("button");
    fabEl.type = "button";
    fabEl.className = "screen-overlay-fab";
    fabEl.title = "Anotaciones (arrastrar para mover)";
    fabEl.setAttribute("aria-label", "Anotaciones sobre pantalla compartida");
    fabEl.setAttribute("aria-expanded", "false");
    fabEl.textContent = "✏️";

    fabHostEl.appendChild(fabEl);
    layer.appendChild(fabHostEl);
    layer.setAttribute("aria-hidden", toolbarOpen ? "false" : "true");
    applyFabPosition();

    fabEl.addEventListener("pointerdown", onFabPointerDown);
    g.addEventListener("keydown", onEscapeKey);
    bindWindowResize();
  }

  function removeFab() {
    if (annotateDockHostEl) {
      removeAnnotateDock();
      return;
    }
    g.removeEventListener("keydown", onEscapeKey);
    g.removeEventListener("pointermove", onFabPointerMove);
    g.removeEventListener("pointerup", onFabPointerUp);
    g.removeEventListener("pointercancel", onFabPointerUp);
    fabDrag = null;
    if (fabEl) {
      fabEl.removeEventListener("pointerdown", onFabPointerDown);
    }
    if (fabHostEl?.parentElement) fabHostEl.remove();
    fabHostEl = null;
    fabEl = null;
    fabPos = null;
    unbindWindowResize();
  }

  function removeToolbar() {
    if (annotateDockHostEl) return;
    g.removeEventListener("pointermove", onToolbarPointerMove);
    g.removeEventListener("pointerup", onToolbarPointerUp);
    g.removeEventListener("pointercancel", onToolbarPointerUp);
    toolbarDrag = null;
    if (toolbarHostEl) {
      toolbarHostEl.removeEventListener("pointerdown", onToolbarPointerDown);
    }
    toolbarApi?.destroy?.();
    toolbarApi = null;
    if (toolbarHostEl?.parentElement) toolbarHostEl.remove();
    toolbarHostEl = null;
    toolbarPos = null;
  }

  function ensureToolbar() {
    if (!getStageEl()) return;
    if (isPresenterFocusMode()) {
      ensureAnnotateDock();
      return;
    }
    removeOrphanOverlayUiFromStage();
    const layer = ensureOverlayUiLayer();
    if (!layer) return;
    if (toolbarApi && toolbarHostEl && toolbarHostEl.parentElement === layer) return;
    removeToolbar();

    toolbarHostEl = document.createElement("div");
    toolbarHostEl.className = "screen-overlay-toolbar-host screen-overlay-toolbar-host--v hidden";
    toolbarHostEl.setAttribute("aria-hidden", "true");
    layer.appendChild(toolbarHostEl);
    toolbarHostEl.addEventListener("pointerdown", onToolbarPointerDown);

    createToolbarInHost(toolbarHostEl);
  }
    function getRefs() {
      return {
        fabHostEl,
        fabEl,
        toolbarHostEl,
        toolbarApi,
        fabPos: fabPos ? { left: fabPos.left, top: fabPos.top } : null,
        annotateDockHostEl,
        toolbarOpen,
      };
    }

    function revalidate() {
      revalidateFabPosition();
    }

    function ensure() {
      ensureFab();
      ensureToolbar();
    }

    function remove() {
      removeFab();
      removeToolbar();
    }

    function destroy() {
      remove();
      unbindWindowResize();
    }

    return {
      ensure,
      ensureFab,
      ensureToolbar,
      remove,
      removeFab,
      removeToolbar,
      setToolbarOpen,
      getRefs,
      revalidate,
      onWindowResize: onWindowResizeForOverlay,
      scheduleToolbarPlacement,
      destroy,
      getFabSize,
      measureToolbarSize,
      placementOverlapsFab,
      getLastToolbarPlacement: () => lastToolbarPlacement,
      isToolbarOpen: () => toolbarOpen,
    };
  }

  global.PencilFabToolbar = { create };
})(typeof window !== "undefined" ? window : global);
