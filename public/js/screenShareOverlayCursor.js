/**
 * screenShareOverlayCursor.js — flecha amarilla DOM sincronizada (Fase 4, todos los roles).
 */
(function (global) {
  const STORAGE_DISABLE_KEY = "MOJ_OVERLAY_SYNC_CURSOR";
  const HOTSPOT_X = 4;
  const HOTSPOT_Y = 3;
  const POINTER_SIZE = 24;
  const POINTER_SVG =
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M4 3l7.8 15 2.1-5.5 5.6-2.2z' fill='%23facc15' stroke='%23854d0e' stroke-width='1.2'/%3E%3C/svg%3E\")";

  /** @type {object | null} */
  let deps = null;
  let running = false;
  let rafId = 0;
  /** @type {HTMLElement | null} */
  let pointerEl = null;
  /** @type {HTMLElement | null} */
  let boundStack = null;
  /** @type {MutationObserver | null} */
  let stackObserver = null;
  let lastClientPos = null;
  let globalCursorPromise = null;
  let globalCursorCache = null;
  let globalCursorCacheFrame = 0;
  let frameCounter = 0;

  function isEnabled() {
    try {
      if (global.localStorage?.getItem(STORAGE_DISABLE_KEY) === "0") return false;
    } catch (_) {}
    return true;
  }

  function isSupported() {
    return typeof document !== "undefined" && isEnabled();
  }

  function getVideoContentRect(videoEl, containerSize) {
    const iw = Math.max(1, containerSize.width || 1);
    const ih = Math.max(1, containerSize.height || 1);
    const vw = videoEl?.videoWidth || 0;
    const vh = videoEl?.videoHeight || 0;
    if (!vw || !vh) return { x: 0, y: 0, w: iw, h: ih };
    const vr = vw / vh;
    const tr = iw / ih;
    let dw;
    let dh;
    let dx;
    let dy;
    if (vr > tr) {
      dw = iw;
      dh = iw / vr;
      dx = 0;
      dy = (ih - dh) / 2;
    } else {
      dh = ih;
      dw = ih * vr;
      dx = (iw - dw) / 2;
      dy = 0;
    }
    return { x: dx, y: dy, w: dw, h: dh };
  }

  function normToStackLocalPx(nx, ny, contentRect) {
    return {
      x: contentRect.x + nx * contentRect.w,
      y: contentRect.y + ny * contentRect.h,
    };
  }

  function getContentRectForElements(videoEl, canvasEl, stackEl) {
    const canvasRect = canvasEl?.getBoundingClientRect?.();
    const stackW = canvasRect?.width || stackEl?.clientWidth || 1;
    const stackH = canvasRect?.height || stackEl?.clientHeight || 1;
    return getVideoContentRect(videoEl, { width: stackW, height: stackH });
  }

  function clientToStackPointer(clientX, clientY, videoEl, canvasEl, stackEl) {
    if (clientX == null || clientY == null || !canvasEl) {
      return { stackX: 0, stackY: 0, visible: false };
    }
    const canvasRect = canvasEl.getBoundingClientRect();
    if (!canvasRect.width || !canvasRect.height) {
      return { stackX: 0, stackY: 0, visible: false };
    }
    const contentRect = getContentRectForElements(videoEl, canvasEl, stackEl);
    const scaleX = (canvasEl.width || canvasRect.width) / canvasRect.width;
    const scaleY = (canvasEl.height || canvasRect.height) / canvasRect.height;
    const cx = (clientX - canvasRect.left) * scaleX;
    const cy = (clientY - canvasRect.top) * scaleY;
    if (!contentRect.w || !contentRect.h) {
      return { stackX: 0, stackY: 0, visible: false };
    }
    const nx = (cx - contentRect.x) / contentRect.w;
    const ny = (cy - contentRect.y) / contentRect.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      return { stackX: 0, stackY: 0, visible: false };
    }
    const local = normToStackLocalPx(nx, ny, contentRect);
    return { stackX: local.x, stackY: local.y, visible: true };
  }

  function screenPointToNorm(screenX, screenY, displayBounds) {
    if (!displayBounds?.width || !displayBounds?.height) return null;
    const nx = (screenX - displayBounds.x) / displayBounds.width;
    const ny = (screenY - displayBounds.y) / displayBounds.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { nx, ny };
  }

  function normToStackPointer(nx, ny, videoEl, canvasEl, stackEl) {
    if (nx == null || ny == null) return { stackX: 0, stackY: 0, visible: false };
    const contentRect = getContentRectForElements(videoEl, canvasEl, stackEl);
    if (!contentRect.w || !contentRect.h) {
      return { stackX: 0, stackY: 0, visible: false };
    }
    const local = normToStackLocalPx(nx, ny, contentRect);
    return { stackX: local.x, stackY: local.y, visible: true };
  }

  function shouldShowSyncPointer(stackEl) {
    if (!stackEl) return false;
    return (
      stackEl.classList.contains("screen-overlay-stack--tool-pointer") &&
      stackEl.classList.contains("screen-overlay-stack--toolbar-open")
    );
  }

  function ensurePointerEl(stackEl) {
    if (pointerEl?.parentElement === stackEl) return pointerEl;
    removePointerEl();
    if (!stackEl) return null;
    const el = document.createElement("div");
    el.className = "screen-overlay-sync-pointer";
    el.setAttribute("aria-hidden", "true");
    stackEl.appendChild(el);
    pointerEl = el;
    boundStack = stackEl;
    return el;
  }

  function removePointerEl() {
    if (pointerEl) {
      try {
        pointerEl.remove();
      } catch (_) {}
    }
    pointerEl = null;
    boundStack = null;
  }

  function setShellSyncClass(on) {
    const shell = deps?.getShell?.();
    shell?.classList.toggle("room-shell--overlay-sync-cursor", !!on);
  }

  function useElectronGlobalCursor() {
    const mapping = deps?.getCaptureMapping?.();
    const isLocalCapture = !!deps?.isLocalScreenCapture?.();
    return (
      isLocalCapture &&
      !!global.__MOJ_ELECTRON &&
      typeof global.mojElectron?.getCursorScreenPoint === "function" &&
      mapping?.sourceType === "screen"
    );
  }

  function fetchGlobalCursorAsync() {
    if (!useElectronGlobalCursor()) return;
    if (globalCursorPromise) return;
    globalCursorPromise = (async () => {
      try {
        const pt = await global.mojElectron.getCursorScreenPoint();
        if (!pt || pt.x == null || pt.y == null) {
          globalCursorCache = null;
          return;
        }
        let display = null;
        if (typeof global.mojElectron.getDisplayForPoint === "function") {
          display = await global.mojElectron.getDisplayForPoint(pt);
        }
        globalCursorCache = { pt, display };
      } catch (_) {
        globalCursorCache = null;
      } finally {
        globalCursorPromise = null;
      }
    })();
  }

  function resolvePointerPosition(videoEl, canvasEl, stackEl) {
    if (lastClientPos && videoEl && canvasEl && stackEl) {
      const local = clientToStackPointer(
        lastClientPos.x,
        lastClientPos.y,
        videoEl,
        canvasEl,
        stackEl
      );
      if (local.visible) return local;
    }
    if (useElectronGlobalCursor() && globalCursorCache?.pt) {
      const mapping = deps?.getCaptureMapping?.();
      const { pt, display } = globalCursorCache;
      let bounds = display?.bounds;
      if (
        mapping?.displayId != null &&
        display?.id != null &&
        String(display.id) !== String(mapping.displayId)
      ) {
        bounds = null;
      }
      if (bounds) {
        const norm = screenPointToNorm(pt.x, pt.y, bounds);
        if (norm) return normToStackPointer(norm.nx, norm.ny, videoEl, canvasEl, stackEl);
      }
    }
    return { stackX: 0, stackY: 0, visible: false };
  }

  function tick() {
    rafId = 0;
    if (!running) return;

    frameCounter += 1;
    fetchGlobalCursorAsync();

    const stackEl = deps?.getStack?.();
    const videoEl = deps?.getVideoEl?.();
    const canvasEl = deps?.getCanvasEl?.() || stackEl?.querySelector(".screen-overlay-canvas");

    if (!shouldShowSyncPointer(stackEl)) {
      removePointerEl();
      setShellSyncClass(false);
      scheduleTick();
      return;
    }

    setShellSyncClass(true);
    const el = ensurePointerEl(stackEl);
    if (!el || !videoEl?.videoWidth) {
      scheduleTick();
      return;
    }

    const pos = resolvePointerPosition(videoEl, canvasEl, stackEl);
    if (pos.visible) {
      el.style.left = `${pos.stackX - HOTSPOT_X}px`;
      el.style.top = `${pos.stackY - HOTSPOT_Y}px`;
      el.classList.add("screen-overlay-sync-pointer--visible");
    } else {
      el.classList.remove("screen-overlay-sync-pointer--visible");
    }

    scheduleTick();
  }

  function scheduleTick() {
    if (!running || rafId) return;
    rafId = global.requestAnimationFrame(tick);
  }

  function onPointerMove(ev) {
    lastClientPos = { x: ev.clientX, y: ev.clientY };
  }

  function bindPointerListeners() {
    global.addEventListener("pointermove", onPointerMove, { passive: true });
    global.addEventListener("pointerrawupdate", onPointerMove, { passive: true });
    global.addEventListener("mousemove", onPointerMove, { passive: true });
  }

  function unbindPointerListeners() {
    global.removeEventListener("pointermove", onPointerMove);
    global.removeEventListener("pointerrawupdate", onPointerMove);
    global.removeEventListener("mousemove", onPointerMove);
  }

  function observeStack(stackEl) {
    if (stackObserver) {
      stackObserver.disconnect();
      stackObserver = null;
    }
    if (!stackEl) return;
    stackObserver = new MutationObserver(() => scheduleTick());
    stackObserver.observe(stackEl, { attributes: true, attributeFilter: ["class"] });
  }

  function start(options = {}) {
    stop();
    if (!isSupported()) return false;
    deps = options;
    running = true;
    lastClientPos = null;
    globalCursorCache = null;
    globalCursorPromise = null;
    frameCounter = 0;

    bindPointerListeners();

    const stackEl = deps.getStack?.();
    observeStack(stackEl);
    scheduleTick();
    return true;
  }

  function stop() {
    running = false;
    if (rafId) {
      global.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    unbindPointerListeners();
    if (stackObserver) {
      stackObserver.disconnect();
      stackObserver = null;
    }
    removePointerEl();
    setShellSyncClass(false);
    deps = null;
    lastClientPos = null;
    globalCursorCache = null;
    globalCursorPromise = null;
  }

  function refreshStackObserver() {
    if (!running || !deps) return;
    observeStack(deps.getStack?.());
    scheduleTick();
  }

  global.ScreenShareOverlayCursor = {
    isEnabled,
    isSupported,
    start,
    stop,
    refreshStackObserver,
    _internals: {
      getVideoContentRect,
      clientToStackPointer,
      normToStackPointer,
      screenPointToNorm,
      shouldShowSyncPointer,
      HOTSPOT_X,
      HOTSPOT_Y,
      POINTER_SIZE,
    },
  };
})(typeof window !== "undefined" ? window : global);
