/**
 * clientEnv.js — detección de entorno (sin DOM / sin localStorage).
 */
(function (global) {
  function isElectron() {
    return !!(global.__MOJ_ELECTRON || global.mojElectron?.getDesktopSources);
  }

  function isWeb() {
    return !isElectron();
  }

  /** @deprecated Usar isModularShareLayoutEligible; no implica layout activo. */
  function isWebLayoutEnabled() {
    return isModularShareLayoutEligible();
  }

  function isModularShareLayoutEligible() {
    return true;
  }

  /**
   * @param {HTMLElement | null} [shell]
   */
  function isShareLayoutActive(shell) {
    const el =
      shell ||
      (typeof document !== "undefined" ? document.getElementById("roomShell") : null);
    if (!el) return false;
    return (
      el.classList.contains("room-shell--presenter-focus") ||
      el.classList.contains("room-shell--remote-screen-dominant")
    );
  }

  function isElectronClient() {
    return isElectron();
  }

  function isWebClient() {
    return isWeb();
  }

  function logBootOnce() {
    if (global.__mojEnvBootLogged) return;
    global.__mojEnvBootLogged = true;
    let webClient = "n/a";
    try {
      webClient = !!global.document?.documentElement?.classList?.contains("moj-web-client");
    } catch (_) {}
    if (typeof console !== "undefined" && console.log) {
      console.log(
        "[moj-env] electron=" +
          isElectron() +
          " webClient=" +
          webClient +
          " modularEligible=" +
          isModularShareLayoutEligible()
      );
    }
  }

  global.ClientEnv = {
    isElectron,
    isWeb,
    isWebLayoutEnabled,
    isModularShareLayoutEligible,
    isShareLayoutActive,
    isElectronClient,
    isWebClient,
    logBootOnce,
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", logBootOnce);
    } else {
      logBootOnce();
    }
  }
})(typeof window !== "undefined" ? window : global);
