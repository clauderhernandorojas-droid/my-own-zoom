/**
 * uiPresenterFloat.js — panel flotante de participantes (modo presentador).
 */
(function (global) {
  const STORAGE_KEY = "moj_presenter_float_peers_v1";
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
  let videosEl = null;
  let videosParent = null;
  let videosNext = null;
  /** @type {{ left: number, top: number, width: number, height: number, minimized: boolean } | null} */
  let state = null;
  /** @type {object | null} */
  let drag = null;
  let resizeDrag = null;
  let domReady = false;
  let resizeBound = false;

  function init(options = {}) {
    deps = options;
  }

  function storageKey() {
    const rid = deps?.getActiveRoomId?.();
    return rid ? `${STORAGE_KEY}_${rid}` : STORAGE_KEY;
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
    const w = DEFAULT_W;
    const h = DEFAULT_H;
    return {
      left: MARGIN,
      top: Math.max(MARGIN, (global.innerHeight || 600) - h - 80),
      width: w,
      height: h,
      minimized: false,
    };
  }

  function clampBox(left, top, width, height) {
    const limits = { minW: 200, minH: 160, maxW: 520, maxH: 480 };
    const w = Math.min(Math.max(limits.minW, width), limits.maxW);
    const h = Math.min(Math.max(limits.minH, height), limits.maxH);
    let out = { left, top, width: w, height: h };
    if (global.UiFloatClamp?.clampDockPosition) {
      const c = global.UiFloatClamp.clampDockPosition({
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

  function applyLayout() {
    if (!rootEl || !state) return;
    if (state.minimized) {
      rootEl.classList.add("presenter-float-root--minimized");
      rootEl.style.display = "none";
      if (pillEl) {
        pillEl.classList.remove("hidden");
        pillEl.style.left = `${state.left}px`;
        pillEl.style.top = `${state.top}px`;
      }
      return;
    }
    rootEl.classList.remove("presenter-float-root--minimized");
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
  }

  function onPanelPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.dragging) {
      drag.dragging = true;
      rootEl?.classList.add("presenter-float-root--dragging");
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
    rootEl?.classList.remove("presenter-float-root--dragging");
    pillEl?.classList.remove("presenter-float-pill--dragging");
    try {
      (headerEl || pillEl)?.releasePointerCapture(e.pointerId);
    } catch (_) {}
    global.removeEventListener("pointermove", onPanelPointerMove);
    global.removeEventListener("pointerup", onPanelPointerUp);
    global.removeEventListener("pointercancel", onPanelPointerUp);
    if (wasDrag) saveState();
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
      target: targetEl === pillEl ? "pill" : "header",
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
    if (was) saveState();
  }

  function ensureDom() {
    if (domReady) return;
    domReady = true;
    rootEl = document.createElement("div");
    rootEl.id = "presenterFloatRoot";
    rootEl.className = "presenter-float-root hidden";
    rootEl.innerHTML =
      '<div class="presenter-float-header"><span class="presenter-float-title">Participantes</span>' +
      '<button type="button" class="presenter-float-btn-min" aria-label="Minimizar">−</button></div>' +
      '<div class="presenter-float-body"></div>';
    resizeEl = document.createElement("div");
    resizeEl.className = "presenter-float-resize-handle";
    resizeEl.title = "Redimensionar";
    rootEl.appendChild(resizeEl);
    document.body.appendChild(rootEl);

    headerEl = rootEl.querySelector(".presenter-float-header");
    pillEl = document.createElement("button");
    pillEl.type = "button";
    pillEl.id = "presenterFloatPill";
    pillEl.className = "presenter-float-pill hidden";
    pillEl.textContent = "Participantes";
    document.body.appendChild(pillEl);

    headerEl?.addEventListener("pointerdown", (e) => {
      if (!state || state.minimized) return;
      startPanelDrag(e, headerEl, state.left, state.top);
    });
    pillEl.addEventListener("pointerdown", (e) => {
      if (!state || !state.minimized) return;
      startPanelDrag(e, pillEl, state.left, state.top);
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

    rootEl.querySelector(".presenter-float-btn-min")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state) {
        state.minimized = true;
        applyLayout();
        saveState();
      }
    });
    pillEl.addEventListener("click", (e) => {
      if (drag?.dragging) return;
      if (state) {
        state.minimized = false;
        applyLayout();
        saveState();
      }
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
  }

  function mountVideos() {
    const body = rootEl?.querySelector(".presenter-float-body");
    const src = document.getElementById("videos");
    if (!body || !src) return;
    if (src.parentElement === body) {
      videosEl = src;
      return;
    }
    videosParent = src.parentElement;
    videosNext = src.nextSibling;
    videosEl = src;
    src.classList.add("presenter-float-videos");
    body.appendChild(src);
  }

  function unmountVideos() {
    if (!videosEl || !videosParent) return;
    try {
      videosEl.classList.remove("presenter-float-videos");
      if (videosNext && videosNext.parentNode === videosParent) {
        videosParent.insertBefore(videosEl, videosNext);
      } else {
        videosParent.appendChild(videosEl);
      }
    } catch (_) {}
    videosEl = null;
    videosParent = null;
    videosNext = null;
  }

  function activate() {
    ensureDom();
    if (!active) {
      state = loadState() || defaultState();
      const c = clampBox(state.left, state.top, state.width, state.height);
      state = { ...state, ...c };
      active = true;
    }
    mountVideos();
    rootEl?.classList.remove("hidden");
    applyLayout();
  }

  function deactivate() {
    if (!active) return;
    saveState();
    unmountVideos();
    rootEl?.classList.add("hidden");
    pillEl?.classList.add("hidden");
    active = false;
    drag = null;
    resizeDrag = null;
  }

  function reclamp() {
    if (!active || !state) return;
    const c = clampBox(state.left, state.top, state.width, state.height);
    state = { ...state, ...c };
    applyLayout();
    saveState();
  }

  global.UiPresenterFloat = {
    init,
    activate,
    deactivate,
    reclamp,
    isActive: () => active,
  };
})(typeof window !== "undefined" ? window : global);
