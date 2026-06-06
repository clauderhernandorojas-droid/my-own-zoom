/**
 * overlayTransform.js — shim: bounds/transform en Core; render de selección en AnnotationUI.
 */
(function (global) {
  const Core = global.AnnotationCore;
  const UI = global.AnnotationUI;
  if (!Core) return;

  global.OverlayTransform = {
    getElementNormBounds: Core.getElementNormBounds,
    getResizeHandleRects: (bounds, element, contentRect) =>
      Core.getResizeHandleRects(bounds, element, contentRect, UI?.HANDLE_HIT_PX ?? 28),
    hitTestResizeHandle: UI?.hitTestResizeHandle
      ? UI.hitTestResizeHandle.bind(UI)
      : (p, b, el, cr) => Core.hitTestResizeHandle(p, b, el, cr, 28),
    applyResizeTransform: Core.applyResizeTransform,
    applyTextBoxResize: Core.applyTextBoxResize,
    applyDragTransform: Core.applyDragTransform,
    getResizeTransform: Core.getResizeTransform,
    shouldUseUniformTextResize: Core.shouldUseUniformTextResize,
    drawSelectionOverlay: UI?.drawSelectionOverlay?.bind(UI),
    pointInRect: Core.pointInRect,
    MIN_NORM: Core.MIN_NORM,
  };
})(typeof window !== "undefined" ? window : global);
