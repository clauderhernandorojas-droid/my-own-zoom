/**
 * screenOverlay.js — anotaciones sobre pantalla compartida (canal screenshare-annotate:*).
 * Aislado del tablero colaborativo; reutiliza UiAnnotationToolbar y AnnotationInk.
 */
(function (global) {
  const Ink = global.AnnotationInk;
  const Toolbar = global.UiAnnotationToolbar;
  const OverlaySel = global.OverlaySeleccion;
  const Transform = global.OverlayTransform;

  const HISTORY_LIMIT = 80;
  const ERASER_THRESHOLD_NORM = 0.025;
  const POINTER_HIT_NORM = 0.05;
  const FAB_SIZE = 44;
  const FAB_MARGIN = 16;
  const FAB_DRAG_THRESHOLD_PX = 6;
  const TOOLBAR_GAP = 6;
  const TOOLBAR_ATTACH_MAX_PX = 14;
  const FAB_STORAGE_KEY = "moj_screen_overlay_fab_pos_v2";
  const FAB_STORAGE_KEY_LEGACY = "moj_screen_overlay_fab_pos";

  /** @type {{ getSocket?: function, getActiveRoomId?: function, normRoomKey?: function, log?: function } | null} */
  let deps = null;

  let overlayState = { elementos: [] };
  const overlayHistory = [];
  const overlayFuture = [];

  let overlayTool = "pointer";
  let overlayColor = "#111111";
  let overlayLineWidth = 4;
  let overlayTextSize = 24;
  let annotateActive = false;
  let toolbarOpen = false;

  let stageEl = null;
  let wrapEl = null;
  let uiLayerEl = null;
  let stackEl = null;
  let videoEl = null;
  let canvasEl = null;
  let badgeEl = null;
  let toolbarHostEl = null;
  let toolbarApi = null;
  let fabHostEl = null;
  let fabEl = null;

  /** @type {{ left: number, top: number } | null} */
  let fabPos = null;

  /** @type {{ anchor: string, orientation: string, left: number, top: number } | null} */
  let lastToolbarPlacement = null;

  let resizeObserver = null;
  let stageResizeObserver = null;
  let drawing = false;
  let currentStroke = null;
  let activeTextInput = null;
  let drawRaf = 0;
  let resizeTimer = 0;
  let resizeCanvasRaf = 0;
  let lastObservedStageHeight = 0;
  let boundPeerWrap = null;
  /** @type {HTMLVideoElement | null} */
  let boundVideoForLayout = null;

  const videoLayoutHandlers = {
    loadedmetadata: () => resizeCanvas(),
    loadeddata: () => resizeCanvas(),
    resize: () => resizeCanvas(),
  };

  /** @type {{ dragging: boolean, startX: number, startY: number, originLeft: number, originTop: number, pointerId: number } | null} */
  let fabDrag = null;

  /** @type {object | null} */
  let selectionPointerAction = null;

  const pointerHandlers = {
    down: onPointerDown,
    move: onPointerMove,
    up: onPointerUp,
    cancel: onPointerUp,
  };

  function onFabPointerMove(e) {
    if (!fabDrag || e.pointerId !== fabDrag.pointerId) return;
    const dx = e.clientX - fabDrag.startX;
    const dy = e.clientY - fabDrag.startY;
    if (!fabDrag.dragging && Math.hypot(dx, dy) >= FAB_DRAG_THRESHOLD_PX) {
      fabDrag.dragging = true;
      fabEl?.classList.add("screen-overlay-fab--dragging");
    }
    if (!fabDrag.dragging) return;
    e.preventDefault();
    const clamped = clampFabPosition(fabDrag.originLeft + dx, fabDrag.originTop + dy);
    fabPos = clamped;
    applyFabPosition();
    if (toolbarOpen) positionToolbarNearFab();
  }

  function onFabPointerUp(e) {
    if (!fabDrag || e.pointerId !== fabDrag.pointerId) return;
    const wasDrag = fabDrag.dragging;
    fabDrag = null;
    fabEl?.classList.remove("screen-overlay-fab--dragging");
    try {
      fabEl?.releasePointerCapture(e.pointerId);
    } catch (_) {}
    global.removeEventListener("pointermove", onFabPointerMove);
    global.removeEventListener("pointerup", onFabPointerUp);
    global.removeEventListener("pointercancel", onFabPointerUp);
    if (wasDrag) {
      saveFabPosition();
    } else {
      setToolbarOpen(!toolbarOpen);
    }
  }

  function onFabPointerDown(e) {
    if (!fabEl || !fabHostEl || !stageEl) return;
    e.preventDefault();
    e.stopPropagation();
    if (fabPos == null) fabPos = defaultFabPosition();
    fabDrag = {
      dragging: false,
      startX: e.clientX,
      startY: e.clientY,
      originLeft: fabPos.left,
      originTop: fabPos.top,
      pointerId: e.pointerId,
    };
    try {
      fabEl.setPointerCapture(e.pointerId);
    } catch (_) {}
    global.addEventListener("pointermove", onFabPointerMove);
    global.addEventListener("pointerup", onFabPointerUp);
    global.addEventListener("pointercancel", onFabPointerUp);
  }

  function onEscapeKey(e) {
    if (e.key !== "Escape" || !toolbarOpen) return;
    if (activeTextInput) return;
    e.preventDefault();
    setToolbarOpen(false);
  }

  function log(...args) {
    deps?.log?.(...args);
  }

  function getSocket() {
    return deps?.getSocket?.() || null;
  }

  function getRoomId() {
    const raw = deps?.getActiveRoomId?.();
    return raw ? deps?.normRoomKey?.(raw) || String(raw).trim().toLowerCase() : "";
  }

  function cloneState(state) {
    return Ink?.cloneInkState ? Ink.cloneInkState(state) : { elementos: [] };
  }

  function getFabSize() {
    if (!fabEl) return FAB_SIZE;
    const r = fabEl.getBoundingClientRect();
    return r.width || FAB_SIZE;
  }

  function getStageMetrics() {
    const w = wrapEl?.clientWidth || stageEl?.clientWidth || 0;
    const h = wrapEl?.clientHeight || stageEl?.clientHeight || 0;
    return { w, h };
  }

  function resolveStageContainers(stage) {
    stageEl = stage || null;
    wrapEl =
      stageEl?.closest?.(".room-screen-share-wrap") ||
      document.getElementById("roomScreenShareWrap") ||
      null;
    uiLayerEl =
      wrapEl?.querySelector?.("#screenOverlayUiLayer") ||
      document.getElementById("screenOverlayUiLayer") ||
      null;
    if (wrapEl && !uiLayerEl) {
      uiLayerEl = document.createElement("div");
      uiLayerEl.id = "screenOverlayUiLayer";
      uiLayerEl.className = "screen-overlay-ui-layer";
      uiLayerEl.setAttribute("aria-hidden", "true");
      wrapEl.appendChild(uiLayerEl);
    }
  }

  function ensureOverlayUiLayer() {
    if (!wrapEl && stageEl) {
      wrapEl = stageEl.parentElement;
    }
    if (wrapEl && !uiLayerEl) {
      uiLayerEl = document.createElement("div");
      uiLayerEl.id = "screenOverlayUiLayer";
      uiLayerEl.className = "screen-overlay-ui-layer";
      uiLayerEl.setAttribute("aria-hidden", "true");
      wrapEl.appendChild(uiLayerEl);
    }
    return uiLayerEl;
  }

  function isStageActive() {
    if (!stageEl || stageEl.hidden || !Ink) return false;
    if (wrapEl?.hidden) return false;
    return true;
  }

  function defaultFabPosition() {
    const { w: stageW, h: stageH } = getStageMetrics();
    const sw = stageW || 400;
    const sh = stageH || 300;
    const size = getFabSize();
    return {
      left: FAB_MARGIN,
      top: Math.max(FAB_MARGIN, sh - size - FAB_MARGIN),
    };
  }

  function fabStorageKey() {
    const rid = getRoomId();
    return rid ? `${FAB_STORAGE_KEY}_${rid}` : FAB_STORAGE_KEY;
  }

  function loadFabPositionRaw() {
    try {
      let raw = global.localStorage?.getItem(fabStorageKey());
      if (!raw) raw = global.localStorage?.getItem(FAB_STORAGE_KEY);
      if (!raw) raw = global.localStorage?.getItem(FAB_STORAGE_KEY_LEGACY);
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
    if (!pos || opts.fromLegacy || isLegacyFabQuadrant(pos, stageW, stageH, size)) {
      const def = defaultFabPosition();
      return clampFabPosition(def.left, def.top);
    }
    return clampFabPosition(pos.left, pos.top);
  }

  function revalidateFabPosition() {
    if (!fabPos || !stageEl) return;
    fabPos = normalizeFabPosition(fabPos);
    applyFabPosition();
    if (toolbarOpen) schedulePositionToolbarNearFab();
  }

  function saveFabPosition() {
    if (!fabPos) return;
    try {
      global.localStorage?.setItem(
        fabStorageKey(),
        JSON.stringify({ v: 2, left: fabPos.left, top: fabPos.top })
      );
    } catch (_) {}
  }

  function removeOrphanOverlayUiFromStage() {
    if (!stageEl) return;
    stageEl
      .querySelectorAll(
        ":scope > .screen-overlay-fab-host, :scope > .screen-overlay-toolbar-host"
      )
      .forEach((el) => el.remove());
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
    const maxLeft = Math.max(FAB_MARGIN, sw - size - FAB_MARGIN);
    const maxTop = Math.max(FAB_MARGIN, sh - size - FAB_MARGIN);
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

  function positionToolbarNearFab() {
    if (!toolbarHostEl || !fabHostEl || !stageEl || !fabPos) return;
    const { w: stageW, h: stageH } = getStageMetrics();
    if (stageW < 2 || stageH < 2) return;
    const fabSize = getFabSize();
    const gap = TOOLBAR_GAP;

    toolbarHostEl.classList.add("screen-overlay-toolbar-host--v");
    toolbarHostEl.classList.remove("screen-overlay-toolbar-host--h");
    let { w: toolbarW, h: toolbarH } = measureToolbarSize("vertical");
    if (!toolbarW || !toolbarH) {
      const fb = measureToolbarSizeFallback("vertical", stageH, fabSize);
      toolbarW = fb.w;
      toolbarH = fb.h;
    }

    let placement = computeToolbarPlacement(stageW, stageH, fabSize, toolbarW, toolbarH, gap);
    if (!placement) {
      log("screenOverlay: sin placement válido, intentando compact horizontal");
      placement = buildCompactHorizontalPlacement(stageW, stageH, fabSize, gap);
    }
    if (!placement) return;

    if (placement.toolbarW && placement.toolbarH) {
      toolbarW = placement.toolbarW;
      toolbarH = placement.toolbarH;
    } else {
      toolbarHostEl.classList.toggle(
        "screen-overlay-toolbar-host--v",
        placement.orientation === "vertical"
      );
      toolbarHostEl.classList.toggle(
        "screen-overlay-toolbar-host--h",
        placement.orientation === "horizontal"
      );
      const remeasured = measureToolbarSize(placement.orientation);
      if (remeasured.w && remeasured.h) {
        toolbarW = remeasured.w;
        toolbarH = remeasured.h;
        const refined = computeToolbarPlacement(
          stageW,
          stageH,
          fabSize,
          toolbarW,
          toolbarH,
          gap
        );
        if (refined) placement = refined;
      }
    }

    placement = resolveToolbarOverlap(
      placement,
      stageW,
      stageH,
      fabSize,
      toolbarW,
      toolbarH,
      gap
    );
    if (placement.toolbarW) toolbarW = placement.toolbarW;
    if (placement.toolbarH) toolbarH = placement.toolbarH;
    applyToolbarPlacementStyles(placement, toolbarW, toolbarH);
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

  function syncAnnotateCapture() {
    const drawingTool =
      overlayTool === "pencil" || overlayTool === "eraser" || overlayTool === "text";
    const selectTool = overlayTool === "pointer";
    annotateActive = toolbarOpen && (drawingTool || selectTool);
    syncStackClasses();
  }

  function schedulePositionToolbarNearFab() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        positionToolbarNearFab();
        requestAnimationFrame(() => positionToolbarNearFab());
      });
    });
  }

  function updatePointerHoverCursor(clientX, clientY) {
    if (!stackEl || !toolbarOpen || overlayTool !== "pointer" || selectionPointerAction) return;
    const ctx = canvasEl?.getContext("2d");
    const p = normFromEvent({ clientX, clientY });
    const hit = OverlaySel?.hitTestEditable?.(
      p,
      overlayState.elementos,
      ctx,
      getContentRect(),
      POINTER_HIT_NORM
    );
    stackEl.classList.toggle(
      "screen-overlay-stack--selection-hit",
      !!(hit || OverlaySel?.size?.() > 0)
    );
  }

  function setToolbarOpen(open) {
    toolbarOpen = !!open;
    if (uiLayerEl) {
      uiLayerEl.setAttribute("aria-hidden", toolbarOpen ? "false" : "true");
    }
    if (toolbarHostEl) {
      toolbarHostEl.classList.toggle("hidden", !toolbarOpen);
      toolbarHostEl.setAttribute("aria-hidden", toolbarOpen ? "false" : "true");
    }
    fabEl?.classList.toggle("screen-overlay-fab--active", toolbarOpen);
    fabEl?.setAttribute("aria-expanded", toolbarOpen ? "true" : "false");
    if (!toolbarOpen) {
      toolbarApi?.closeMenus?.();
      closeInlineTextInput(false);
      drawing = false;
      currentStroke = null;
    } else {
      schedulePositionToolbarNearFab();
      overlayTool = "pointer";
      toolbarApi?.setTool?.("pointer");
    }
    syncAnnotateCapture();
  }

  function updateHistoryButtons() {
    toolbarApi?.setHistoryButtons?.(overlayHistory.length > 0, overlayFuture.length > 0);
  }

  function syncStackClasses() {
    if (!stackEl) return;
    stackEl.classList.toggle("screen-overlay-stack--annotate-active", annotateActive);
    stackEl.classList.toggle("screen-overlay-stack--active", toolbarOpen && annotateActive);
    stackEl.classList.toggle("screen-overlay-stack--toolbar-open", toolbarOpen);
    stackEl.classList.remove(
      "screen-overlay-stack--tool-pointer",
      "screen-overlay-stack--tool-pencil",
      "screen-overlay-stack--tool-eraser",
      "screen-overlay-stack--tool-text"
    );
    stackEl.classList.add(`screen-overlay-stack--tool-${overlayTool}`);
    if (badgeEl) badgeEl.classList.toggle("hidden", !toolbarOpen);
  }

  function getContentRect() {
    if (!Ink || !canvasEl) {
      const w = stackEl?.clientWidth || 1;
      const h = stackEl?.clientHeight || 1;
      return { x: 0, y: 0, w, h };
    }
    if (Ink.getVideoContentRectForOverlay) {
      return Ink.getVideoContentRectForOverlay(videoEl, canvasEl);
    }
    const sz = { width: stackEl?.clientWidth || 1, height: stackEl?.clientHeight || 1 };
    return Ink.getVideoContentRect(videoEl, sz);
  }

  function scheduleDeferredResizeCanvas() {
    if (resizeCanvasRaf) return;
    resizeCanvasRaf = requestAnimationFrame(() => {
      resizeCanvasRaf = requestAnimationFrame(() => {
        resizeCanvasRaf = 0;
        resizeCanvas();
      });
    });
  }

  function resizeCanvas() {
    if (!canvasEl || !stackEl) return;
    const cssW = stackEl.clientWidth;
    const cssH = stackEl.clientHeight;
    if (cssW < 2 || cssH < 2) {
      scheduleDeferredResizeCanvas();
      return;
    }
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvasEl.width !== w || canvasEl.height !== h) {
      canvasEl.width = w;
      canvasEl.height = h;
    }
    if (fabPos) {
      fabPos = clampFabPosition(fabPos.left, fabPos.top);
      applyFabPosition();
      if (toolbarOpen) positionToolbarNearFab();
    }
    scheduleDraw();
  }

  function scheduleDraw() {
    if (drawRaf) return;
    drawRaf = requestAnimationFrame(() => {
      drawRaf = 0;
      drawOverlay();
    });
  }

  function drawOverlay() {
    if (!canvasEl || !Ink || !stackEl) return;
    if (stackEl.clientWidth < 2 || stackEl.clientHeight < 2) return;
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;
    const dpr = canvasEl.width / Math.max(1, stackEl?.clientWidth || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    const contentRect = getContentRect();
    const scaled = {
      x: contentRect.x * dpr,
      y: contentRect.y * dpr,
      w: contentRect.w * dpr,
      h: contentRect.h * dpr,
    };
    Ink.drawInkElementos(ctx, overlayState.elementos, scaled, {
      previewStroke: currentStroke,
    });
    if (toolbarOpen && overlayTool === "pointer" && Transform?.drawSelectionOverlay && OverlaySel) {
      Transform.drawSelectionOverlay(
        ctx,
        scaled,
        getContentRect(),
        overlayState.elementos,
        OverlaySel
      );
    }
  }

  function emitOverlayUpdate() {
    const socket = getSocket();
    const roomId = getRoomId();
    if (!socket?.connected || !roomId) return;
    socket.emit("screenshare-annotate:update", {
      roomId,
      contenido: cloneState(overlayState),
    });
  }

  function applyOverlayState(nextState, opts = {}) {
    const { recordHistory = false, clearFuture = false, emit = false, resetHistory = false } = opts;
    if (resetHistory) {
      overlayHistory.length = 0;
      overlayFuture.length = 0;
    }
    if (recordHistory) {
      overlayHistory.push(cloneState(overlayState));
      if (overlayHistory.length > HISTORY_LIMIT) overlayHistory.shift();
    }
    if (clearFuture) overlayFuture.length = 0;
    overlayState = cloneState(nextState || { elementos: [] });
    closeInlineTextInput(false);
    scheduleDraw();
    updateHistoryButtons();
    if (emit) emitOverlayUpdate();
  }

  function applyRemoteState(contenido, opts = {}) {
    if (!contenido || !Array.isArray(contenido.elementos)) return;
    const socket = getSocket();
    const fromSelf = opts?.from && socket?.id && String(opts.from) === String(socket.id);
    applyOverlayState(contenido, { resetHistory: !fromSelf });
    OverlaySel?.reconcileAfterStateChange?.(overlayState.elementos.length);
  }

  function performUndo() {
    if (!overlayHistory.length) return;
    overlayFuture.push(cloneState(overlayState));
    const prev = overlayHistory.pop();
    applyOverlayState(prev, { emit: true });
  }

  function performRedo() {
    if (!overlayFuture.length) return;
    overlayHistory.push(cloneState(overlayState));
    const next = overlayFuture.pop();
    applyOverlayState(next, { emit: true });
  }

  function insertEmojiOnOverlay(emoji) {
    if (!emoji || !toolbarOpen) return;
    const next = cloneState(overlayState);
    next.elementos.push({
      type: "text",
      text: emoji,
      x: 0.4,
      y: 0.4,
      w: 0.08,
      h: 0.08,
      color: overlayColor,
      fontSize: 42,
    });
    applyOverlayState(next, { recordHistory: true, clearFuture: true, emit: true });
    toolbarApi?.setTool?.("pointer");
    overlayTool = "pointer";
    syncAnnotateCapture();
  }

  function finishSelectionGesture(snapshotBefore) {
    const next = cloneState(overlayState);
    if (snapshotBefore) {
      overlayHistory.push(snapshotBefore);
      if (overlayHistory.length > HISTORY_LIMIT) overlayHistory.shift();
      overlayFuture.length = 0;
      overlayState = next;
      closeInlineTextInput(false);
      scheduleDraw();
      updateHistoryButtons();
      emitOverlayUpdate();
    }
  }

  function onSelectionPointerDown(e) {
    if (!canvasEl || !OverlaySel || !Transform) return;
    e.preventDefault();
    try {
      canvasEl.setPointerCapture(e.pointerId);
    } catch (_) {}
    const p = normFromEvent(e);
    const ctx = canvasEl.getContext("2d");
    const cr = getContentRect();

    const selIds = OverlaySel.getSelectedIndices();
    if (selIds.length === 1) {
      const i = selIds[0];
      const el = overlayState.elementos[i];
      const b = OverlaySel.getElementBounds(el, ctx, cr);
      if (b) {
        const h = Transform.hitTestResizeHandle(p, b, el, cr);
        if (h) {
          selectionPointerAction = {
            mode: "resize",
            index: i,
            resizeHandle: h,
            startPoint: p,
            snapshotBefore: cloneState(overlayState),
            originalElement: JSON.parse(JSON.stringify(el)),
            originalBounds: { ...b },
          };
          scheduleDraw();
          return;
        }
      }
    }

    if (selIds.length > 1) {
      const gb = OverlaySel.getSelectionBounds(overlayState.elementos, ctx, cr);
      if (gb) {
        const gh = Transform.hitTestResizeHandle(p, gb, null, cr);
        if (gh) {
          const originals = new Map();
          for (const i of selIds) {
            const el = overlayState.elementos[i];
            if (el) originals.set(i, JSON.parse(JSON.stringify(el)));
          }
          selectionPointerAction = {
            mode: "resizeGroup",
            indices: selIds,
            resizeHandle: gh,
            startPoint: p,
            snapshotBefore: cloneState(overlayState),
            originalElements: originals,
            originalBounds: { ...gb },
          };
          scheduleDraw();
          return;
        }
      }
    }

    const hit = OverlaySel.hitTestEditable(
      p,
      overlayState.elementos,
      ctx,
      cr,
      POINTER_HIT_NORM
    );
    if (!hit) {
      OverlaySel.startMarquee(p, !!e.shiftKey);
      selectionPointerAction = { mode: "marquee", startPoint: p };
      scheduleDraw();
      return;
    }

    if (e.shiftKey) {
      OverlaySel.toggleInSelection(hit.index);
      selectionPointerAction = null;
      scheduleDraw();
      return;
    }

    if (!OverlaySel.isSelected(hit.index)) {
      OverlaySel.selectOne(hit.index);
    }

    const dragIndices = OverlaySel.getSelectedIndices();
    const originals = new Map();
    for (const i of dragIndices) {
      const el = overlayState.elementos[i];
      if (el) originals.set(i, JSON.parse(JSON.stringify(el)));
    }
    selectionPointerAction = {
      mode: dragIndices.length > 1 ? "dragGroup" : "drag",
      index: hit.index,
      indices: dragIndices,
      startPoint: p,
      snapshotBefore: cloneState(overlayState),
      originalElements: originals,
    };
    scheduleDraw();
  }

  function onSelectionPointerMove(e) {
    if (!selectionPointerAction || !canvasEl) return;
    e.preventDefault();
    const p = normFromEvent(e);
    const ctx = canvasEl.getContext("2d");
    const cr = getContentRect();
    const act = selectionPointerAction;

    if (act.mode === "marquee") {
      OverlaySel.updateMarquee(p);
      scheduleDraw();
      return;
    }

    const dx = p.x - act.startPoint.x;
    const dy = p.y - act.startPoint.y;

    if (act.mode === "resizeGroup" && Transform.getResizeTransform) {
      const tr = Transform.getResizeTransform(
        act.resizeHandle,
        act.originalBounds,
        dx,
        dy,
        !!e.shiftKey
      );
      if (!tr) return;
      for (const i of act.indices) {
        const orig = act.originalElements.get(i);
        if (!orig) continue;
        overlayState.elementos[i] = Transform.applyResizeTransform(orig, tr.anchor, tr.sx, tr.sy);
      }
      scheduleDraw();
      return;
    }

    if (act.mode === "resize") {
      const orig = act.originalElement;
      let next = { ...orig };
      if (orig.type === "text") {
        next = Transform.applyTextBoxResize(act.resizeHandle, orig, act.originalBounds, dx, dy);
      } else {
        const tr = Transform.getResizeTransform(
          act.resizeHandle,
          act.originalBounds,
          dx,
          dy,
          !!e.shiftKey
        );
        if (tr) next = Transform.applyResizeTransform(orig, tr.anchor, tr.sx, tr.sy);
      }
      overlayState.elementos[act.index] = next;
      scheduleDraw();
      return;
    }

    if (act.mode === "drag" || act.mode === "dragGroup") {
      for (const i of act.indices) {
        const orig = act.originalElements.get(i);
        if (!orig) continue;
        if (orig.type === "stroke" && orig.points) {
          overlayState.elementos[i] = {
            ...orig,
            points: orig.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
          };
        } else if (orig.type === "text") {
          overlayState.elementos[i] = {
            ...orig,
            x: (orig.x || 0) + dx,
            y: (orig.y || 0) + dy,
          };
        }
      }
      scheduleDraw();
    }
  }

  function onSelectionPointerUp(e) {
    if (!selectionPointerAction) return;
    e.preventDefault();
    try {
      canvasEl?.releasePointerCapture(e.pointerId);
    } catch (_) {}

    const act = selectionPointerAction;
    selectionPointerAction = null;
    const ctx = canvasEl?.getContext("2d");
    const cr = getContentRect();

    if (act.mode === "marquee") {
      const before = OverlaySel.getSelectedIndices().length;
      OverlaySel.finishMarquee(overlayState.elementos, ctx, cr);
      if (!OverlaySel.getSelectedIndices().length && !before) {
        OverlaySel.clearSelection();
      }
      scheduleDraw();
      return;
    }

    if (act.mode === "resize" || act.mode === "resizeGroup" || act.mode === "drag" || act.mode === "dragGroup") {
      finishSelectionGesture(act.snapshotBefore);
    }
  }

  function normFromEvent(e) {
    if (!canvasEl) return { x: 0, y: 0, inBounds: false };
    const dpr = canvasEl.width / Math.max(1, stackEl?.clientWidth || 1);
    const cr = getContentRect();
    const scaled = { x: cr.x * dpr, y: cr.y * dpr, w: cr.w * dpr, h: cr.h * dpr };
    return Ink.clientToNorm(e.clientX, e.clientY, canvasEl, scaled);
  }

  function eraseAtPoints(points) {
    if (!points?.length) return false;
    const toRemove = new Set();
    for (const p of points) {
      if (!p.inBounds && !Number.isFinite(p.x)) continue;
      const idx = Ink.hitTestAnyElementAtNorm({ x: p.x, y: p.y }, overlayState.elementos, ERASER_THRESHOLD_NORM);
      if (idx >= 0) toRemove.add(idx);
    }
    if (!toRemove.size) return false;
    const next = cloneState(overlayState);
    next.elementos = next.elementos.filter((_el, i) => !toRemove.has(i));
    applyOverlayState(next, { recordHistory: true, clearFuture: true, emit: true });
    return true;
  }

  function onPointerDown(e) {
    if (toolbarOpen && overlayTool === "pointer" && canvasEl && !activeTextInput) {
      onSelectionPointerDown(e);
      return;
    }
    if (!annotateActive || !canvasEl || activeTextInput) return;
    if (overlayTool === "pointer") return;
    e.preventDefault();
    try {
      canvasEl.setPointerCapture(e.pointerId);
    } catch (_) {}
    const p = normFromEvent(e);
    if (!p.inBounds && overlayTool !== "eraser") return;
    if (overlayTool === "text") return;

    drawing = true;
    if (overlayTool === "eraser") {
      currentStroke = {
        type: "stroke",
        color: "#ef4444",
        lw: Ink.lineWidthToNorm(Math.max(8, overlayLineWidth + 2), getContentRect()),
        points: [{ x: p.x, y: p.y }],
      };
    } else {
      currentStroke = {
        type: "stroke",
        color: overlayColor,
        lw: Ink.lineWidthToNorm(overlayLineWidth, getContentRect()),
        points: [{ x: p.x, y: p.y }],
      };
    }
    scheduleDraw();
  }

  function onPointerMove(e) {
    if (selectionPointerAction) {
      onSelectionPointerMove(e);
      return;
    }
    if (toolbarOpen && overlayTool === "pointer" && canvasEl) {
      updatePointerHoverCursor(e.clientX, e.clientY);
      return;
    }
    if (!drawing || !currentStroke) return;
    e.preventDefault();
    const p = normFromEvent(e);
    const pts = currentStroke.points;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.002) return;
    pts.push({ x: p.x, y: p.y });
    scheduleDraw();
  }

  function onPointerUp(e) {
    if (selectionPointerAction) {
      onSelectionPointerUp(e);
      return;
    }
    if (!drawing) return;
    drawing = false;
    try {
      canvasEl?.releasePointerCapture(e.pointerId);
    } catch (_) {}
    if (!currentStroke) return;

    const pts = currentStroke.points.filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
    currentStroke = null;

    if (overlayTool === "eraser") {
      const normPts = pts.map((pt) => ({ x: pt.x, y: pt.y, inBounds: true }));
      if (!eraseAtPoints(normPts)) scheduleDraw();
      return;
    }

    if (pts.length === 0) {
      scheduleDraw();
      return;
    }
    if (pts.length === 1) pts.push({ x: pts[0].x, y: pts[0].y });

    const next = cloneState(overlayState);
    next.elementos.push({
      type: "stroke",
      color: overlayColor,
      lw: Ink.lineWidthToNorm(overlayLineWidth, getContentRect()),
      points: pts,
    });
    applyOverlayState(next, { recordHistory: true, clearFuture: true, emit: true });
  }

  function onCanvasClick(e) {
    if (!annotateActive || overlayTool !== "text" || activeTextInput) return;
    const p = normFromEvent(e);
    if (!p.inBounds) return;
    openInlineTextInput(p);
  }

  function closeInlineTextInput(commit) {
    if (!activeTextInput || !stackEl) return;
    const input = activeTextInput;
    const nx = Number(input.dataset.normX);
    const ny = Number(input.dataset.normY);
    const nw = Number(input.dataset.normW);
    const nh = Number(input.dataset.normH);
    activeTextInput = null;
    if (commit) {
      const text = String(input.value || "").trim();
      if (text) {
        const next = cloneState(overlayState);
        next.elementos.push({
          type: "text",
          text,
          x: nx,
          y: ny,
          w: nw,
          h: nh,
          color: overlayColor,
          fontSize: overlayTextSize,
        });
        applyOverlayState(next, { recordHistory: true, clearFuture: true, emit: true });
      } else {
        scheduleDraw();
      }
    } else {
      scheduleDraw();
    }
    input.remove();
  }

  function openInlineTextInput(normPoint) {
    closeInlineTextInput(false);
    if (!stackEl) return;
    const cr = getContentRect();
    const tl = Ink.normToCanvas(normPoint.x, normPoint.y, cr);
    const w = cr.w * 0.25;
    const h = cr.h * 0.1;

    const input = document.createElement("textarea");
    input.className = "screen-overlay-text-input";
    input.dataset.normX = String(normPoint.x);
    input.dataset.normY = String(normPoint.y);
    input.dataset.normW = String(0.25);
    input.dataset.normH = String(0.1);
    input.style.left = `${tl.x}px`;
    input.style.top = `${tl.y}px`;
    input.style.width = `${Math.max(120, w)}px`;
    input.style.minHeight = `${Math.max(28, h)}px`;
    input.style.fontSize = `${overlayTextSize}px`;
    input.style.color = overlayColor;

    stackEl.appendChild(input);
    activeTextInput = input;
    input.focus();

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeInlineTextInput(false);
      } else if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        closeInlineTextInput(true);
      }
    });
    input.addEventListener("blur", () => closeInlineTextInput(true));
  }

  function bindCanvasEvents() {
    if (!canvasEl) return;
    canvasEl.addEventListener("pointerdown", pointerHandlers.down);
    canvasEl.addEventListener("pointermove", pointerHandlers.move);
    canvasEl.addEventListener("pointerup", pointerHandlers.up);
    canvasEl.addEventListener("pointercancel", pointerHandlers.cancel);
    canvasEl.addEventListener("click", onCanvasClick);
  }

  function unbindCanvasEvents() {
    if (!canvasEl) return;
    canvasEl.removeEventListener("pointerdown", pointerHandlers.down);
    canvasEl.removeEventListener("pointermove", pointerHandlers.move);
    canvasEl.removeEventListener("pointerup", pointerHandlers.up);
    canvasEl.removeEventListener("pointercancel", pointerHandlers.cancel);
    canvasEl.removeEventListener("click", onCanvasClick);
  }

  function ensureFab() {
    if (!stageEl) return;
    removeOrphanOverlayUiFromStage();
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
    global.addEventListener("keydown", onEscapeKey);
  }

  function removeFab() {
    global.removeEventListener("keydown", onEscapeKey);
    global.removeEventListener("pointermove", onFabPointerMove);
    global.removeEventListener("pointerup", onFabPointerUp);
    global.removeEventListener("pointercancel", onFabPointerUp);
    fabDrag = null;
    if (fabEl) {
      fabEl.removeEventListener("pointerdown", onFabPointerDown);
    }
    if (fabHostEl?.parentElement) fabHostEl.remove();
    fabHostEl = null;
    fabEl = null;
    fabPos = null;
  }

  function removeToolbar() {
    toolbarApi?.destroy?.();
    toolbarApi = null;
    if (toolbarHostEl?.parentElement) toolbarHostEl.remove();
    toolbarHostEl = null;
  }

  function ensureToolbar() {
    if (!stageEl) return;
    removeOrphanOverlayUiFromStage();
    const layer = ensureOverlayUiLayer();
    if (!layer) return;
    if (toolbarApi && toolbarHostEl && toolbarHostEl.parentElement === layer) return;
    removeToolbar();

    toolbarHostEl = document.createElement("div");
    toolbarHostEl.className = "screen-overlay-toolbar-host screen-overlay-toolbar-host--v hidden";
    toolbarHostEl.setAttribute("aria-hidden", "true");
    layer.appendChild(toolbarHostEl);

    if (!Toolbar?.create) {
      log("UiAnnotationToolbar no disponible");
      return;
    }

    toolbarApi = Toolbar.create({
      idPrefix: "screenOverlay",
      hostEl: toolbarHostEl,
      onClose: () => setToolbarOpen(false),
      onToolChange(tool) {
        overlayTool = tool;
        syncAnnotateCapture();
      },
      onColorChange(c) {
        overlayColor = c;
      },
      onLineWidthChange(w) {
        overlayLineWidth = w;
      },
      onTextSizeChange(s) {
        overlayTextSize = s;
      },
      onEmojiInsert: insertEmojiOnOverlay,
      onUndo: performUndo,
      onRedo: performRedo,
    });
    updateHistoryButtons();
  }

  function unbindVideoLayoutEvents() {
    if (!boundVideoForLayout) return;
    boundVideoForLayout.removeEventListener("loadedmetadata", videoLayoutHandlers.loadedmetadata);
    boundVideoForLayout.removeEventListener("loadeddata", videoLayoutHandlers.loadeddata);
    boundVideoForLayout.removeEventListener("resize", videoLayoutHandlers.resize);
    boundVideoForLayout = null;
  }

  function bindVideoLayoutEvents(video) {
    if (!video) return;
    if (boundVideoForLayout === video) return;
    unbindVideoLayoutEvents();
    boundVideoForLayout = video;
    video.addEventListener("loadedmetadata", videoLayoutHandlers.loadedmetadata);
    video.addEventListener("loadeddata", videoLayoutHandlers.loadeddata);
    video.addEventListener("resize", videoLayoutHandlers.resize);
  }

  /**
   * Garantiza que el <video> vive dentro del stack (reparent idempotente).
   * @returns {HTMLVideoElement | null}
   */
  function ensureVideoInStack(peerWrap, stack) {
    if (!peerWrap || !stack) return null;
    let video = stack.querySelector("video");
    if (!video) {
      video = peerWrap.querySelector(":scope > video");
      if (video) {
        const canvas = stack.querySelector(".screen-overlay-canvas");
        if (canvas && canvas.parentElement === stack) {
          stack.insertBefore(video, canvas);
        } else {
          stack.prepend(video);
        }
        if (video.srcObject) video.play().catch(() => {});
      }
    }
    return video;
  }

  function inspectInteractionState() {
    const fabHost =
      fabHostEl || uiLayerEl?.querySelector(".screen-overlay-fab-host");
    const toolbarHost =
      toolbarHostEl || uiLayerEl?.querySelector(".screen-overlay-toolbar-host");
    const panel = toolbarHost?.querySelector(".screen-overlay-toolbar-panel");
    let overlap = null;
    let overlapPanel = null;
    if (
      fabHost &&
      toolbarHost &&
      !toolbarHost.classList.contains("hidden")
    ) {
      const a = fabHost.getBoundingClientRect();
      const b = toolbarHost.getBoundingClientRect();
      overlap = !(
        a.right < b.left ||
        a.left > b.right ||
        a.bottom < b.top ||
        a.top > b.bottom
      );
      if (panel) {
        const p = panel.getBoundingClientRect();
        overlapPanel = !(
          a.right < p.left ||
          a.left > p.right ||
          a.bottom < p.top ||
          a.top > p.bottom
        );
      }
    }

    let overlapLogical = null;
    const fabSize = getFabSize();
    const metrics = getStageMetrics();
    if (toolbarOpen && fabPos && toolbarHost && !toolbarHost.classList.contains("hidden")) {
      const left = parseFloat(toolbarHost.style.left) || 0;
      const top = parseFloat(toolbarHost.style.top) || 0;
      const orient = toolbarHost.classList.contains("screen-overlay-toolbar-host--h")
        ? "horizontal"
        : "vertical";
      const sz = measureToolbarSize(orient);
      const tw = lastToolbarPlacement?.toolbarW || sz.w || 40;
      const th = lastToolbarPlacement?.toolbarH || sz.h || 48;
      overlapLogical = placementOverlapsFab(left, top, tw, th, fabSize);
    }

    const canvas =
      canvasEl || stackEl?.querySelector(".screen-overlay-canvas");
    return {
      overlayTool,
      annotateActive,
      toolbarOpen,
      fabPos: fabPos ? { left: fabPos.left, top: fabPos.top } : null,
      overlap,
      overlapPanel,
      overlapLogical,
      placementAnchor: lastToolbarPlacement?.anchor ?? null,
      toolbarSize: lastToolbarPlacement
        ? { w: lastToolbarPlacement.toolbarW, h: lastToolbarPlacement.toolbarH }
        : null,
      stageMetrics: metrics,
      canvasPointerEvents: canvas
        ? getComputedStyle(canvas).pointerEvents
        : null,
      peerInStage: !!resolveSharePeerWrap(stageEl),
      canvasBound: !!canvasEl,
      stackClasses: stackEl ? [...stackEl.classList] : [],
      fabParent: fabHost?.parentElement?.id || null,
      toolbarParent: toolbarHost?.parentElement?.id || null,
    };
  }

  function inspectLayout() {
    const stage = stageEl || document.getElementById("roomRemoteScreenStage");
    const wrap =
      wrapEl || document.getElementById("roomScreenShareWrap") || stage?.parentElement;
    const uiLayer =
      uiLayerEl || document.getElementById("screenOverlayUiLayer");
    const shell = document.getElementById("roomShell");
    const primary = document.querySelector(".room-primary");
    const strip = document.getElementById("roomVideoStrip");
    const peer = resolveSharePeerWrap(stage);
    const stack = stackEl || peer?.querySelector(".screen-overlay-stack");
    const video =
      videoEl || stack?.querySelector("video") || peer?.querySelector("video");
    const canvas = canvasEl || stack?.querySelector(".screen-overlay-canvas");
    const fabHost = fabHostEl || uiLayer?.querySelector(".screen-overlay-fab-host");
    const toolbarHost =
      toolbarHostEl || uiLayer?.querySelector(".screen-overlay-toolbar-host");

    const elInfo = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        rect: { width: r.width, height: r.height },
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        flex: cs.flex,
        display: cs.display,
        position: cs.position,
        zIndex: cs.zIndex,
      };
    };

    const stageCs = stage ? getComputedStyle(stage) : null;
    const metrics = getStageMetrics();

    return {
      toolbarOpen,
      shellClasses: shell ? [...shell.classList] : [],
      stageHidden: !!stage?.hidden,
      wrapHidden: !!wrap?.hidden,
      stageDisplay: stageCs?.display ?? null,
      stageMetrics: metrics,
      primary: primary
        ? { clientWidth: primary.clientWidth, clientHeight: primary.clientHeight }
        : null,
      stripInline: strip
        ? {
            height: strip.style.height,
            maxHeight: strip.style.maxHeight,
            width: strip.style.width,
          }
        : null,
      parentHeights: {
        roomBody: document.querySelector(".room-body")?.clientHeight ?? null,
        roomPrimary: primary?.clientHeight ?? null,
        wrap: wrap?.clientHeight ?? null,
        stage: stage?.clientHeight ?? null,
      },
      wrap: elInfo(wrap),
      uiLayer: elInfo(uiLayer),
      fabHost: elInfo(fabHost),
      toolbarHost: elInfo(toolbarHost),
      stage: elInfo(stage),
      peer: elInfo(peer),
      stack: elInfo(stack),
      video: elInfo(video),
      canvas: elInfo(canvas),
      stream: video
        ? {
            parentClass: video.parentElement?.className,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            readyState: video.readyState,
            paused: video.paused,
            hasSrcObject: !!video.srcObject,
            trackState: video.srcObject?.getVideoTracks?.()?.[0]?.readyState,
          }
        : null,
      canvasBitmap: canvas
        ? {
            width: canvas.width,
            height: canvas.height,
            backgroundColor: getComputedStyle(canvas).backgroundColor,
          }
        : null,
    };
  }

  function ensureOverlayDom(peerWrap) {
    if (!peerWrap || !Ink) return null;

    let stack = peerWrap.querySelector(".screen-overlay-stack");
    if (!stack) {
      peerWrap.classList.add("screen-overlay-peer");
      stack = document.createElement("div");
      stack.className = "screen-overlay-stack";
      stack.dataset.screenOverlayId = "1";

      badgeEl = document.createElement("span");
      badgeEl.className = "screen-overlay-active-badge hidden";
      badgeEl.textContent = "Anotando";

      const canvas = document.createElement("canvas");
      canvas.className = "screen-overlay-canvas";
      canvas.setAttribute("aria-hidden", "true");

      const video = peerWrap.querySelector("video");
      if (video) {
        peerWrap.insertBefore(stack, video);
        stack.appendChild(video);
      } else {
        peerWrap.appendChild(stack);
      }
      stack.appendChild(canvas);
      stack.appendChild(badgeEl);
    } else {
      badgeEl = stack.querySelector(".screen-overlay-active-badge");
      peerWrap.classList.add("screen-overlay-peer");
    }

    ensureVideoInStack(peerWrap, stack);

    peerWrap.querySelectorAll(":scope > .peer-cap, :scope > .peer-conn-status").forEach((el) => {
      el.classList.add("screen-overlay-peer-sibling-hidden");
      stack.appendChild(el);
    });

    stackEl = stack;
    videoEl = stack.querySelector("video");
    canvasEl = stack.querySelector(".screen-overlay-canvas");

    if (canvasEl && canvasEl !== boundPeerWrap?.canvas) {
      unbindCanvasEvents();
      bindCanvasEvents();
    }

    bindVideoLayoutEvents(videoEl);
    if (videoEl?.srcObject) videoEl.play().catch(() => {});

    boundPeerWrap = { wrap: peerWrap, canvas: canvasEl };
    syncStackClasses();
    if (videoEl && videoEl.readyState >= 1 && videoEl.videoWidth > 0) {
      resizeCanvas();
    } else {
      scheduleDeferredResizeCanvas();
    }
    return stack;
  }

  function observeResize() {
    if (resizeObserver) resizeObserver.disconnect();
    if (stageResizeObserver) stageResizeObserver.disconnect();

    if (stackEl) {
      resizeObserver = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resizeCanvas, 50);
      });
      resizeObserver.observe(stackEl);
      if (videoEl) resizeObserver.observe(videoEl);
    }

    const layoutRoot = wrapEl || stageEl;
    if (layoutRoot) {
      lastObservedStageHeight = layoutRoot.clientHeight || 0;
      stageResizeObserver = new ResizeObserver(() => {
        const h = layoutRoot?.clientHeight ?? 0;
        if (h >= 2 && (lastObservedStageHeight < 2 || h !== lastObservedStageHeight)) {
          resizeCanvas();
        }
        lastObservedStageHeight = h;
        if (fabPos) revalidateFabPosition();
      });
      stageResizeObserver.observe(layoutRoot);
    }
  }

  function detachOverlay() {
    unbindCanvasEvents();
    unbindVideoLayoutEvents();
    if (resizeCanvasRaf) {
      cancelAnimationFrame(resizeCanvasRaf);
      resizeCanvasRaf = 0;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (stageResizeObserver) {
      stageResizeObserver.disconnect();
      stageResizeObserver = null;
    }
    closeInlineTextInput(false);
    drawing = false;
    currentStroke = null;
    stackEl = null;
    videoEl = null;
    canvasEl = null;
    badgeEl = null;
    boundPeerWrap = null;
    lastObservedStageHeight = 0;
  }

  /** Peer visible para overlay (no usar presenter-ink-source 1×1). */
  function resolveSharePeerWrap(container) {
    if (!container) return null;
    return (
      container.querySelector(".remote-peer--local-screen-share") ||
      container.querySelector(".remote-peer:not(.remote-peer--presenter-ink-source)") ||
      container.querySelector(".remote-peer")
    );
  }

  function syncWithStage(stage) {
    resolveStageContainers(stage);
    if (!isStageActive()) {
      setToolbarOpen(false);
      detachOverlay();
      removeFab();
      removeToolbar();
      stageEl = null;
      wrapEl = null;
      uiLayerEl = null;
      return;
    }

    ensureFab();
    ensureToolbar();

    const peerWrap = resolveSharePeerWrap(stageEl);
    if (!peerWrap) {
      setToolbarOpen(false);
      detachOverlay();
      return;
    }

    ensureOverlayDom(peerWrap);
    observeResize();
    revalidateFabPosition();
    scheduleDeferredResizeCanvas();
  }

  function clear() {
    applyOverlayState({ elementos: [] }, { resetHistory: true });
    OverlaySel?.clearSelection?.();
    setToolbarOpen(false);
  }

  function destroy() {
    setToolbarOpen(false);
    applyOverlayState({ elementos: [] }, { resetHistory: true });
    removeToolbar();
    removeFab();
    detachOverlay();
    stageEl = null;
    wrapEl = null;
    uiLayerEl = null;
  }

  function getElementos() {
    return overlayState.elementos || [];
  }

  function init(options = {}) {
    deps = options;
  }

  const ScreenOverlay = {
    init,
    syncWithStage,
    applyRemoteState,
    clear,
    destroy,
    getElementos,
    inspectLayout,
    inspectInteractionState,
    getStageMetrics,
  };

  global.ScreenOverlay = ScreenOverlay;
})(typeof window !== "undefined" ? window : global);
