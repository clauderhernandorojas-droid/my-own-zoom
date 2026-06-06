/**
 * overlaySeleccion.js — shim: selección local desde AnnotationCore.
 */
(function (global) {
  const Core = global.AnnotationCore;
  if (!Core?.selection) return;

  global.OverlaySeleccion = Core.selection;
})(typeof window !== "undefined" ? window : global);
