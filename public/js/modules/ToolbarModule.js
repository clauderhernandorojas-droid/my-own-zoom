/**
 * ToolbarModule — política de capas del chrome (FAB + toolbar host) en web invitado.
 * No posee wrap-ink ni canvas (screenOverlay / PencilFabToolbar).
 */
(function (global) {
  const FAB_MARGIN = 12;

  function isElectron() {
    return global.ClientEnv?.isElectron?.() ?? !!global.__MOJ_ELECTRON;
  }

  function initWebLayerPolicy() {
    if (isElectron()) return;
  }

  function isPresenterFocusMode() {
    return !!document
      .getElementById("roomShell")
      ?.classList.contains("room-shell--presenter-focus");
  }

  /** Misma lógica que PencilFabToolbar.getGuestBottomUiReserve (no exportada allí). */
  function getBottomUiReserve() {
    if (isPresenterFocusMode()) return FAB_MARGIN;
    const layer = document.getElementById("screenOverlayUiLayer");
    if (!layer) return 88;
    const layerRect = layer.getBoundingClientRect();
    const bar =
      document.querySelector(
        ".room-shell--remote-screen-dominant .room-media-controls--presenter-float"
      ) || document.getElementById("roomMediaControls");
    if (!bar || bar.offsetParent === null) return 88;
    const barRect = bar.getBoundingClientRect();
    return Math.max(72, Math.ceil(layerRect.bottom - barRect.top + 14));
  }

  function onToolbarOpenChange(_isOpen) {
    /* Opcional: reclamp FAB vía PencilFabToolbar cuando se exponga callback. */
  }

  global.ToolbarModule = {
    initWebLayerPolicy,
    onToolbarOpenChange,
    getBottomUiReserve,
  };
})(typeof window !== "undefined" ? window : global);
