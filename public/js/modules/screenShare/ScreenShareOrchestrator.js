/**
 * ScreenShareOrchestrator — cola meet:screenShare + apply desde servidor.
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let applyQueue = Promise.resolve();

  function enqueue(task) {
    applyQueue = applyQueue.then(task).catch((err) => {
      console.warn("[screen-share] apply queue error", err);
    });
    return applyQueue;
  }

  function onForcedRemoteStop(stoppedUserId) {
    deps?.onForcedRemoteStop?.(stoppedUserId);
  }

  async function teardownRemoteShareView(oid) {
    const d = deps;
    if (!d) return;
    d.clearShareVideoPoll?.();
    d.setPendingTrackRefresh?.(false);
    d.ScreenShareModule?.applyRemoteFromServer?.(false, oid);
    d.ensureGalleryLayoutAfterShareStop?.();
    d.ParticipantsModule?.teardownPanel?.();
    d.RoomScreenShareLayout?.onStopScreenShare?.();
    d.refreshGalleryVideoMosaic?.();
    global.WebLayoutOverrides?.syncShareLayout?.();
    d.scheduleRemoteScreenLayoutUpdate?.();
  }

  async function applyFromServerInner(roomId, active, uid) {
    const d = deps;
    if (!d) return;
    if (!d.getActiveRoomId?.() || !d.sameActiveRoom?.(roomId, d.getActiveRoomId())) return;

    const oid = uid != null ? String(uid).trim().toLowerCase() : "";
    const myId = d.normMyUserId?.() || "";

    if (active && oid && myId && oid !== myId && d.isLocallySharingScreen?.()) {
      await d.stopScreenShare?.({
        force: true,
        skipServerAnnounce: true,
        supersededByPresenter: true,
        restoreStatus: true,
      });
    }

    if (active) {
      if (oid && myId && oid === myId && !d.isLocallySharingScreen?.()) {
        d.setMediaStatus?.(
          "La sesión perdió la captura de pantalla. Vuelve a compartir si debes presentar."
        );
        d.ScreenShareModule?.applyRemoteFromServer?.(false, oid);
        d.scheduleRemoteScreenLayoutUpdate?.();
        return;
      }
      if (oid && myId && oid === myId && d.isLocallySharingScreen?.()) {
        d.RoomScreenShareLayout?.syncLocalSharePreview?.();
      } else if (!oid || !myId || oid !== myId) {
        onForcedRemoteStop(oid);
        const socketId = d.findPeerSocketForUserId?.(oid);
        if (socketId) {
          d.refreshSharerVideoFromReceivers?.(socketId);
          if (d.isScreenShareDebugEnabled?.()) {
            console.info("[screen-share] meet:screenShare active", d.inspectGuestShareProbe?.());
          }
        }
        d.startShareVideoPoll?.();
      }
      d.runDeferredSharerTrackRefresh?.();
      d.ScreenShareModule?.applyRemoteFromServer?.(active, oid);
      d.scheduleRemoteScreenLayoutUpdate?.();
      return;
    }

    if (oid && myId && oid === myId && !d.isLocallySharingScreen?.()) {
      return;
    }

    const currentOwner =
      global.MojShareState?.getShareOwnerId?.(
        d.AppState,
        d.isLocallySharingScreen,
        d.normMyUserId
      ) || "";
    const layoutShare = d.AppState?.getState?.()?.ui?.currentLayout === "share";
    const shareWasActive =
      !!d.AppState?.isShareActive?.() || !!currentOwner || layoutShare;

    if (currentOwner && oid && currentOwner !== oid && !shareWasActive) {
      return;
    }

    if (oid && myId && oid === myId) {
      if (d.isLocallySharingScreen?.()) {
        await d.stopScreenShare?.({
          force: true,
          skipServerAnnounce: true,
          supersededByPresenter: true,
          restoreStatus: true,
        });
        return;
      }
      d.teardownLocalScreenShareStageWrap?.();
      d.RoomScreenShareLayout?.onStopScreenShare?.();
      d.ScreenOverlay?.clear?.();
      await teardownRemoteShareView(oid);
      return;
    }

    if (!shareWasActive) {
      return;
    }

    if (oid) {
      onForcedRemoteStop(oid);
    }
    await teardownRemoteShareView(oid);
  }

  function applyFromServer(roomId, active, uid) {
    return enqueue(() => applyFromServerInner(roomId, active, uid));
  }

  function flushPendingAfterJoin(pending) {
    if (!pending || !deps?.getActiveRoomId?.()) return;
    applyFromServer(pending.roomId, pending.active, pending.userId);
  }

  function init(options = {}) {
    deps = options;
  }

  function resetQueue() {
    applyQueue = Promise.resolve();
  }

  global.ScreenShareOrchestrator = {
    init,
    applyFromServer,
    applyFromServerInner,
    flushPendingAfterJoin,
    onForcedRemoteStop,
    resetQueue,
    teardownRemoteShareView,
  };
})(typeof window !== "undefined" ? window : global);
