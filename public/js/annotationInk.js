/**
 * annotationInk.js — shim: re-exporta geometría y dibujo desde AnnotationCore.
 */
(function (global) {
  const Core = global.AnnotationCore;
  if (!Core) return;

  global.AnnotationInk = {
    getVideoContentRect: Core.getVideoContentRect,
    getVideoContentRectForOverlay: Core.getVideoContentRectForOverlay,
    clientToNorm: Core.clientToNorm,
    normToCanvas: Core.normToCanvas,
    cloneInkState: Core.cloneInkState,
    drawInkElementos: Core.drawInkElementos,
    hitTestStrokeNorm: Core.hitTestStrokeNorm,
    hitTestTextNorm: (point, el, contentRect, ctx) =>
      Core.hitTestTextNorm(point, el, contentRect, ctx),
    hitTestAnyElementAtNorm: (point, elementos, contentRect, ctx, thresholdNorm) =>
      Core.hitTestAnyElementAtNorm(point, elementos, contentRect, ctx, thresholdNorm),
    lineWidthToNorm: Core.lineWidthToNorm,
    textFontSizePx: Core.textFontSizePx,
    measureTextContentNorm: Core.measureTextContentNorm,
    isEmojiElement: Core.isEmojiElement,
  };
})(typeof window !== "undefined" ? window : global);
