/**
 * clientEnv.js — detección de entorno (sin DOM).
 * Fuente única: window.__MOJ_ELECTRON (preload Electron).
 */
(function (global) {
  function isElectron() {
    return !!global.__MOJ_ELECTRON;
  }

  function isWeb() {
    return !isElectron();
  }

  /** Layout modular web (panel flotante, shell web). */
  function isWebLayoutEnabled() {
    return isWeb();
  }

  global.ClientEnv = {
    isElectron,
    isWeb,
    isWebLayoutEnabled,
  };
})(typeof window !== "undefined" ? window : global);
