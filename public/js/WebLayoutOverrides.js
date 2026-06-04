/**
 * WebLayoutOverrides.js — fachada temporal: Electron stubs; web → LayoutModule.
 */
(function (global) {
  if (global.__MOJ_ELECTRON) {
    global.WebLayoutOverrides = {
      init() {},
      isActive: () => false,
      onEnterRoom() {},
      onLeaveRoom() {},
      onShareLayoutChange() {},
    };
    return;
  }

  const lm = global.LayoutModule;
  global.WebLayoutOverrides = {
    init: (opts) => lm?.init?.(opts),
    isActive: () => lm?.isActive?.() ?? false,
    onEnterRoom: () => lm?.onEnterRoom?.(),
    onLeaveRoom: () => lm?.onLeaveRoom?.(),
    onShareLayoutChange: () => lm?.onShareLayoutChange?.(),
  };
})(typeof window !== "undefined" ? window : global);
