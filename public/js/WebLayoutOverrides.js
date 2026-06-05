/**
 * WebLayoutOverrides.js — fachada a LayoutModule (web + Electron).
 */
(function (global) {
  const lm = global.LayoutModule;
  global.WebLayoutOverrides = {
    init: (opts) => lm?.init?.(opts),
    isActive: () => lm?.isActive?.() ?? false,
    onEnterRoom: () => lm?.onEnterRoom?.(),
    onLeaveRoom: () => lm?.onLeaveRoom?.(),
    syncShareLayout: () => lm?.syncShareLayout?.(),
    onShareLayoutChange: () => lm?.onShareLayoutChange?.(),
  };
})(typeof window !== "undefined" ? window : global);
