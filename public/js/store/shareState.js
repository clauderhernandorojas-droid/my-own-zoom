/**
 * MojShareState — ownerId de pantalla compartida (AppState + captura local).
 */
(function (global) {
  function normUid(uid) {
    return uid != null ? String(uid).trim().toLowerCase() : "";
  }

  /**
   * @param {object} appState store AppState
   * @param {() => boolean} isLocallySharingScreen
   * @param {() => string} normMyUserId
   * @returns {string}
   */
  function getShareOwnerId(appState, isLocallySharingScreen, normMyUserId) {
    if (typeof isLocallySharingScreen === "function" && isLocallySharingScreen()) {
      const me = typeof normMyUserId === "function" ? normUid(normMyUserId()) : "";
      if (me) return me;
    }
    const share = appState?.getState?.()?.share;
    if (!share) return "";
    const fromOwner = normUid(share.ownerId);
    if (fromOwner) return fromOwner;
    if (share.isRemoteShareActive) {
      const remote = normUid(share.remoteSharerUserId);
      if (remote) return remote;
    }
    if (share.isLocalShareActive) {
      const local = normUid(share.localOwnerId);
      if (local) return local;
    }
    return "";
  }

  global.MojShareState = {
    getShareOwnerId,
  };
})(typeof window !== "undefined" ? window : global);
