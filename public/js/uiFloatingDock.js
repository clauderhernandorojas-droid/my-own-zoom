/**
 * uiFloatingDock.js — barra de medios flotante arrastrable (modo presentador).
 */
(function (global) {
  const STORAGE_KEY = "moj_presenter_float_dock_v1";
  const MARGIN = 12;
  const DRAG_THRESHOLD = 6;

  /** @type {object | null} */
  let deps = null;
  let active = false;
  let dockEl = null;
  let dragHandleEl = null;
  let parentEl = null;
  let nextSibling = null;
  /** @type {{ left: number, top: number } | null} */
  let pos = null;
  /** @type {object | null} */
  let drag = null;
  let bound = false;

  function storageKey() {
    const rid = deps?.getActiveRoomId?.();
    return rid ? `${STORAGE_KEY}_${rid}` : STORAGE_KEY;
  }

  function loadPos() {
    try {
      const raw = global.localStorage?.getItem(storageKey());
      if (raw) {
        const p = JSON.parse(raw);
        if (Number.isFinite(p?.left) && Number.isFinite(p?.top)) return { left: p.left, top: p.top };
      }
    } catch (_) {}
    return null;
  }

  function savePos() {
    if (!pos) return;
    try {
      global.localStorage?.setItem(storageKey(), JSON.stringify(pos));
    } catch (_) {}
  }

  function defaultPos() {
    const h = dockEl?.offsetHeight || 56;
    return {
      left: MARGIN,
      top: Math.max(MARGIN, (global.innerHeight || 600) - h - MARGIN),
    };
  }

  function clampPos(left, top) {
    if (!dockEl) return { left, top };
    const w = dockEl.offsetWidth || 320;
    const h = dockEl.offsetHeight || 56;
    if (global.UiFloatClamp?.clampDockPosition) {
      return global.UiFloatClamp.clampDockPosition({
        left,
        top,
        width: w,
        height: h,
        margin: MARGIN,
      });
    }
    const vw = global.innerWidth || 800;
    const vh = global.innerHeight || 600;
    return {
      left: Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - w - MARGIN)),
      top: Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - h - MARGIN)),
    };
  }

  function applyPos() {
    if (!dockEl || !pos) return;
    dockEl.style.left = `${pos.left}px`;
    dockEl.style.top = `${pos.top}px`;
    dockEl.style.bottom = "";
    dockEl.style.right = "";
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.dragging) {
      drag.dragging = true;
      dockEl?.classList.add("presenter-dock--dragging");
    }
    e.preventDefault();
    const c = clampPos(drag.originLeft + dx, drag.originTop + dy);
    pos = c;
    applyPos();
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const wasDrag = drag.dragging;
    drag = null;
    dockEl?.classList.remove("presenter-dock--dragging");
    try {
      dragHandleEl?.releasePointerCapture(e.pointerId);
    } catch (_) {}
    global.removeEventListener("pointermove", onPointerMove);
    global.removeEventListener("pointerup", onPointerUp);
    global.removeEventListener("pointercancel", onPointerUp);
    if (wasDrag) savePos();
  }

  function bindDrag() {
    if (bound || !dragHandleEl) return;
    bound = true;
    dragHandleEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !pos) return;
      e.preventDefault();
      e.stopPropagation();
      drag = {
        dragging: false,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originLeft: pos.left,
        originTop: pos.top,
      };
      try {
        dragHandleEl.setPointerCapture(e.pointerId);
      } catch (_) {}
      global.addEventListener("pointermove", onPointerMove);
      global.addEventListener("pointerup", onPointerUp);
      global.addEventListener("pointercancel", onPointerUp);
    });
  }

  function init(options = {}) {
    deps = options;
  }

  function deactivate() {
    if (!active) return;
    savePos();
    drag = null;
    if (dockEl && parentEl) {
      try {
        dragHandleEl?.remove();
        dragHandleEl = null;
        if (nextSibling && nextSibling.parentNode === parentEl) {
          parentEl.insertBefore(dockEl, nextSibling);
        } else {
          parentEl.appendChild(dockEl);
        }
        dockEl.classList.remove("room-media-controls--presenter-float", "presenter-dock--dragging");
        dockEl.style.position = "";
        dockEl.style.left = "";
        dockEl.style.top = "";
        dockEl.style.bottom = "";
        dockEl.style.zIndex = "";
      } catch (_) {}
    }
    active = false;
    dockEl = null;
    parentEl = null;
    nextSibling = null;
    bound = false;
  }

  function activate() {
    const $ = deps?.$;
    const controls = $?.("roomMediaControls");
    if (!controls || active) return;
    parentEl = controls.parentElement;
    if (!parentEl) return;
    nextSibling = controls.nextSibling;
    dockEl = controls;
    document.body.appendChild(controls);
    controls.classList.add("room-media-controls--presenter-float");
    controls.style.position = "fixed";
    controls.style.zIndex = "1900";

    if (!controls.querySelector(".presenter-dock-drag-handle")) {
      dragHandleEl = document.createElement("div");
      dragHandleEl.className = "presenter-dock-drag-handle";
      dragHandleEl.title = "Arrastrar barra de controles";
      controls.insertBefore(dragHandleEl, controls.firstChild);
    } else {
      dragHandleEl = controls.querySelector(".presenter-dock-drag-handle");
    }

    pos = loadPos() || defaultPos();
    requestAnimationFrame(() => {
      const c = clampPos(pos.left, pos.top);
      pos = c;
      applyPos();
      bindDrag();
    });

    active = true;
  }

  function reclamp() {
    if (!active || !pos) return;
    pos = clampPos(pos.left, pos.top);
    applyPos();
  }

  global.UiFloatingDock = {
    init,
    activate,
    deactivate,
    reclamp,
    isActive: () => active,
  };
})(typeof window !== "undefined" ? window : global);
