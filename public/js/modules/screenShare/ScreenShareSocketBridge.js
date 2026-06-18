/**
 * ScreenShareSocketBridge — listeners meet:screenShare* y screenshare-annotate:*.
 */
(function (global) {
  /** @type {object | null} */
  let boundSocket = null;
  const handlers = {};

  function bind(socket, deps = {}) {
    if (!socket || typeof socket.on !== "function") return;
    unbind(socket);
    boundSocket = socket;

    handlers.screenShare = ({ roomId, active, userId: uid }) => {
      const normRoom =
        typeof deps.normRoomKey === "function"
          ? deps.normRoomKey(roomId)
          : roomId;
      const activeRoomId = deps.getActiveRoomId?.();
      if (!activeRoomId) {
        deps.setPendingMeetScreenShare?.({ roomId: normRoom, active, userId: uid });
        return;
      }
      deps.applyMeetScreenShareFromServer?.(normRoom, active, uid);
      if (!active) deps.ScreenOverlay?.clear?.();
    };

    handlers.trackRefresh = ({ roomId }) => {
      deps.onTrackRefresh?.({ roomId });
    };

    handlers.shareRequest = ({ roomId, requesterUserId, currentSharerUserId }) => {
      deps.onShareRequest?.({ roomId, requesterUserId, currentSharerUserId });
    };

    handlers.shareGrant = ({ roomId, approved, byUserId }) => {
      deps.onShareGrant?.({ roomId, approved, byUserId });
    };

    handlers.annotateUpdate = ({ roomId, contenido, from }) => {
      deps.onAnnotateUpdate?.({ roomId, contenido, from });
    };

    handlers.annotateState = ({ roomId, contenido, from }) => {
      deps.onAnnotateState?.({ roomId, contenido, from });
    };

    socket.on("meet:screenShare", handlers.screenShare);
    socket.on("meet:screenShare:trackRefresh", handlers.trackRefresh);
    socket.on("meet:screenShare:request", handlers.shareRequest);
    socket.on("meet:screenShare:grant", handlers.shareGrant);
    socket.on("screenshare-annotate:update", handlers.annotateUpdate);
    socket.on("screenshare-annotate:state", handlers.annotateState);
  }

  function unbind(socket) {
    const s = socket || boundSocket;
    if (!s || typeof s.off !== "function") return;
    if (handlers.screenShare) s.off("meet:screenShare", handlers.screenShare);
    if (handlers.trackRefresh) s.off("meet:screenShare:trackRefresh", handlers.trackRefresh);
    if (handlers.shareRequest) s.off("meet:screenShare:request", handlers.shareRequest);
    if (handlers.shareGrant) s.off("meet:screenShare:grant", handlers.shareGrant);
    if (handlers.annotateUpdate) s.off("screenshare-annotate:update", handlers.annotateUpdate);
    if (handlers.annotateState) s.off("screenshare-annotate:state", handlers.annotateState);
    boundSocket = null;
  }

  global.ScreenShareSocketBridge = {
    bind,
    unbind,
  };
})(typeof window !== "undefined" ? window : global);
