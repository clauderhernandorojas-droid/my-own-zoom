/**
 * annotationSync.js — clonado de estado, historial local y comunicación socket.
 */
(function (global) {
  /**
   * @param {object} opts
   * @param {function} opts.getSocket
   * @param {function} opts.getRoomId
   * @param {function} opts.cloneState
   * @param {number} [opts.historyLimit]
   */
  function createSyncManager(opts) {
    const historyLimit = opts.historyLimit ?? 80;
    const history = [];
    const future = [];

    function pushHistory(state) {
      history.push(opts.cloneState(state));
      if (history.length > historyLimit) history.shift();
    }

    function clearFuture() {
      future.length = 0;
    }

    function resetHistory() {
      history.length = 0;
      future.length = 0;
    }

    function emitOverlayUpdate(overlayState) {
      const socket = opts.getSocket?.();
      const roomId = opts.getRoomId?.();
      if (!socket?.connected || !roomId) return;
      socket.emit("screenshare-annotate:update", {
        roomId,
        contenido: opts.cloneState(overlayState),
      });
    }

    function canUndo() {
      return history.length > 0;
    }

    function canRedo() {
      return future.length > 0;
    }

    function prepareUndo(currentState) {
      if (!history.length) return null;
      future.push(opts.cloneState(currentState));
      return history.pop();
    }

    function prepareRedo(currentState) {
      if (!future.length) return null;
      history.push(opts.cloneState(currentState));
      return future.pop();
    }

    function isRemoteFromSelf(socket, optsFrom) {
      return optsFrom && socket?.id && String(optsFrom) === String(socket.id);
    }

    function shouldResetHistoryOnRemote(socket, optsFrom) {
      return !isRemoteFromSelf(socket, optsFrom);
    }

    return {
      pushHistory,
      clearFuture,
      resetHistory,
      emitOverlayUpdate,
      canUndo,
      canRedo,
      prepareUndo,
      prepareRedo,
      isRemoteFromSelf,
      shouldResetHistoryOnRemote,
    };
  }

  global.AnnotationSync = {
    createSyncManager,
  };
})(typeof window !== "undefined" ? window : global);
