/**

 * ScreenShareModule — sincronización AppState + coordinación layout share.

 */

(function (global) {

  const T = global.MojActionTypes || {};



  /** @type {object | null} */

  let deps = null;



  function dispatch(type, payload = {}) {

    global.AppState?.dispatch?.({ type, ...payload });

  }



  function notifyLocalShareStarted(myUserId) {

    dispatch(T.SHARE_LOCAL_STARTED, { myUserId });

  }



  function notifyLocalShareStopped() {

    dispatch(T.SHARE_LOCAL_STOPPED);

  }



  function notifyRemoteShare(active, userId) {

    dispatch(T.SHARE_REMOTE_SET, { active: !!active, userId });

  }



  function onShareAnnounceFromServer(active, userId) {

    notifyRemoteShare(active, userId);

    dispatch(T.SHARE_OWNER_SET, { active: !!active, userId });

  }



  function onShareRequestReceived(requesterUserId, currentSharerUserId) {

    dispatch(T.SHARE_REQUEST_ADD, { userId: requesterUserId, currentSharerUserId });

  }



  function onShareRequestRemoved(userId) {

    dispatch(T.SHARE_REQUEST_REMOVE, { userId });

  }



  function setMyRequestPending() {

    dispatch(T.SHARE_MY_REQUEST_SET, { status: "pending" });

  }



  function clearMyRequest() {

    dispatch(T.SHARE_MY_REQUEST_SET, { status: "none" });

  }



  function onShareGrantReceived(approved) {

    dispatch(T.SHARE_GRANT_SET, {

      granted: !!approved,

      rejected: !approved,

    });

    if (!approved) {

      dispatch(T.SHARE_MY_REQUEST_SET, { status: "rejected" });

    }

  }



  function resetShareAuth() {

    dispatch(T.SHARE_MY_REQUEST_SET, { status: "none" });

    dispatch(T.SHARE_GRANT_SET, { granted: false });

    dispatch(T.SHARE_REQUEST_REMOVE, { userId: "*" });

  }



  function clearGrant() {

    dispatch(T.SHARE_GRANT_SET, { granted: false });

  }



  function onForcedLocalStop() {

    notifyLocalShareStopped();

    clearGrant();

    dispatch(T.SHARE_MY_REQUEST_SET, { status: "none" });

  }



  function syncLayoutFromStore() {

    deps?.scheduleRemoteScreenLayoutUpdate?.();

    deps?.updateShareControlsForRole?.();

    deps?.renderShareMenu?.();

  }



  function init(options = {}) {

    deps = options;

    if (!global.AppState) return;

    global.AppState.subscribe((s) => s.share, () => syncLayoutFromStore());

    global.AppState.subscribe((s) => s.ui.currentLayout, () => syncLayoutFromStore());

  }



  function update() {

    syncLayoutFromStore();

  }



  function destroy() {

    notifyLocalShareStopped();

    notifyRemoteShare(false, "");

    resetShareAuth();

    deps = null;

  }



  function applyRemoteFromServer(active, userId) {

    onShareAnnounceFromServer(active, userId);

  }



  global.ScreenShareModule = {

    init,

    update,

    destroy,

    notifyLocalShareStarted,

    notifyLocalShareStopped,

    notifyRemoteShare,

    applyRemoteFromServer,

    onShareAnnounceFromServer,

    onShareRequestReceived,

    onShareRequestRemoved,

    setMyRequestPending,

    clearMyRequest,

    onShareGrantReceived,

    resetShareAuth,

    clearGrant,

    onForcedLocalStop,

  };

})(typeof window !== "undefined" ? window : global);


