/**
 * uiFloatClamp.js — límites de viewport para paneles flotantes.
 */
(function (global) {
  function clampDockPosition(opts = {}) {
    const left = Number(opts.left) || 0;
    const top = Number(opts.top) || 0;
    const width = Math.max(1, Number(opts.width) || 1);
    const height = Math.max(1, Number(opts.height) || 1);
    const margin = Number(opts.margin) >= 0 ? Number(opts.margin) : 12;
    const vw = global.innerWidth || document.documentElement?.clientWidth || 800;
    const vh = global.innerHeight || document.documentElement?.clientHeight || 600;
    const maxLeft = Math.max(margin, vw - width - margin);
    const maxTop = Math.max(margin, vh - height - margin);
    return {
      left: Math.min(maxLeft, Math.max(margin, left)),
      top: Math.min(maxTop, Math.max(margin, top)),
    };
  }

  global.UiFloatClamp = { clampDockPosition };
})(typeof window !== "undefined" ? window : global);
