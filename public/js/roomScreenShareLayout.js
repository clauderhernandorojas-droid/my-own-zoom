/**
 * roomScreenShareLayout.js — layout pantalla compartida (presentador vs invitado).
 * Stage con vídeo estático (#roomRemoteScreenVideo); peers inmóviles en #remotesContainer.
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let presenterFocusActive = false;
  let shareChatCollapsedOnce = false;
  let unsubOwnerId = null;
  let lastOwnerId = null;
  let stageStreamRetryRaf = 0;
  let stageStreamRetryCount = 0;
  const STAGE_STREAM_MAX_RETRIES = 20;
  let stageVideoMetaBound = false;

  function init(options = {}) {
    deps = options;
    if (global.UiPresenterFloat?.init) global.UiPresenterFloat.init(options);
    if (global.UiFloatingDock?.init) global.UiFloatingDock.init(options);
    bindShareVisibilityGuard();

    const store = deps?.AppState;
    if (store?.subscribe && !unsubOwnerId) {
      lastOwnerId = deps?.getShareOwnerId?.() ?? store.getState?.()?.share?.ownerId ?? null;
      unsubOwnerId = store.subscribe((s) => s.share?.ownerId, (ownerId) => {
        const prev = lastOwnerId;
        if (prev !== ownerId) {
          if (prev && prev !== ownerId) {
            onOwnerIdChanged(prev, ownerId);
          }
          lastOwnerId = ownerId;
        }
        updateRemoteScreenShareLayout();
      });
    }
  }

  function onOwnerIdChanged(prev, next) {
    const myId = deps?.getMyUserId?.();
    const prevNorm = prev != null ? String(prev).trim().toLowerCase() : "";
    const myNorm = myId != null ? String(myId).trim().toLowerCase() : "";
    if (prevNorm && prevNorm !== myNorm && !deps?.isLocallySharingScreen?.()) {
      deps?.onForcedRemoteStop?.(prev);
    }
    if (next && myNorm && String(next).trim().toLowerCase() === myNorm && deps?.isLocallySharingScreen?.()) {
      syncLocalSharePreview();
    }
  }

  function isPresenterFocusActive() {
    return presenterFocusActive;
  }

  function $(id) {
    return deps?.$?.(id) ?? null;
  }

  function getStageVideo() {
    return $("roomRemoteScreenVideo");
  }

  function getStageTrack(vid) {
    return vid?.srcObject?.getVideoTracks?.()?.[0] || null;
  }

  function ensureStageVideoAutoplayCompat(vid) {
    if (!vid) return;
    vid.muted = true;
    vid.defaultMuted = true;
    vid.autoplay = true;
    vid.playsInline = true;
    try {
      vid.setAttribute("muted", "");
      vid.setAttribute("autoplay", "");
      vid.setAttribute("playsinline", "");
    } catch (_) {}
  }

  /** @returns {boolean} */
  function assignStageStream(trackOrStream) {
    const vid = getStageVideo();
    if (!vid || !trackOrStream) return false;
    const nextTrack =
      trackOrStream instanceof MediaStream
        ? trackOrStream.getVideoTracks?.()?.[0]
        : trackOrStream;
    if (!nextTrack || nextTrack.kind !== "video") return false;
    const curTrack = getStageTrack(vid);
    if (curTrack?.id === nextTrack.id) {
      ensureStageVideoAutoplayCompat(vid);
      if (vid.paused) vid.play?.().catch(() => {});
      return true;
    }
    ensureStageVideoAutoplayCompat(vid);
    const stream =
      trackOrStream instanceof MediaStream ? trackOrStream : new MediaStream([nextTrack]);
    vid.srcObject = stream;
    if (!nextTrack.__mojStagePlayBound) {
      nextTrack.__mojStagePlayBound = true;
      nextTrack.addEventListener("unmute", () => {
        ensureStageVideoAutoplayCompat(vid);
        vid.play?.().catch(() => {});
      });
    }
    vid.play?.().catch(() => {});
    return true;
  }

  function clearStageScreenStream() {
    clearStageStreamSyncRetry();
    stageVideoMetaBound = false;
    const vid = getStageVideo();
    if (!vid) return;
    vid.pause?.();
    vid.srcObject = null;
  }

  function bindStageVideoRetryListeners() {
    const vid = getStageVideo();
    if (!vid || stageVideoMetaBound) return;
    stageVideoMetaBound = true;
    const bump = () => scheduleStageStreamSync();
    vid.addEventListener("loadedmetadata", bump);
    vid.addEventListener("loadeddata", bump);
    vid.addEventListener("resize", bump);
  }

  function clearStageStreamSyncRetry() {
    if (stageStreamRetryRaf) {
      cancelAnimationFrame(stageStreamRetryRaf);
      stageStreamRetryRaf = 0;
    }
    stageStreamRetryCount = 0;
  }

  function scheduleStageStreamSync() {
    if (stageStreamRetryRaf) return;
    const tick = () => {
      stageStreamRetryRaf = 0;
      const vid = getStageVideo();
      const synced = syncStageScreenStream();
      if (synced && vid && vid.videoWidth > 0) {
        clearStageStreamSyncRetry();
        return;
      }
      stageStreamRetryCount += 1;
      if (stageStreamRetryCount < STAGE_STREAM_MAX_RETRIES) {
        stageStreamRetryRaf = requestAnimationFrame(tick);
      }
    };
    stageStreamRetryRaf = requestAnimationFrame(tick);
  }

  function usePresenterFloatUi() {
    return deps?.enablePresenterFloatUi === true;
  }

  function usePresenterMediaDock() {
    const v = deps?.enablePresenterMediaDock;
    if (typeof v === "function") return !!v();
    return v !== false;
  }

  function exitPresenterFocusUi() {
    presenterFocusActive = false;
    const shell = $("roomShell");
    shell?.classList.remove("room-shell--presenter-focus");
    if (usePresenterFloatUi()) {
      global.UiPresenterFloat?.deactivate?.();
    }
    if (usePresenterMediaDock()) {
      global.UiFloatingDock?.deactivate?.();
    }
    deps?.teardownLocalScreenShareStageWrap?.();
  }

  function ensurePresenterMediaDock() {
    if (usePresenterMediaDock()) {
      global.UiFloatingDock?.activate?.();
    }
  }

  function syncLocalSharePreview() {
    if (!deps?.isLocallySharingScreen?.()) return;
    syncStageScreenStream();
  }

  function bindShareVisibilityGuard() {
    if (global.__mojShareVisibilityBound) return;
    global.__mojShareVisibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      const store = global.AppState?.getState?.();
      const shareActive =
        global.AppState?.isShareActive?.(store) || !!deps?.isLocallySharingScreen?.();
      if (!shareActive) return;
      global.MiniPlayerControls?.suppressForActiveSession?.();
    });
  }

  function enterPresenterFocusUi() {
    const shell = $("roomShell");
    if (!shell) return;
    if (presenterFocusActive) {
      syncLocalSharePreview();
      ensurePresenterMediaDock();
      return;
    }
    shell.classList.remove("room-shell--remote-screen-dominant");
    shell.classList.add("room-shell--presenter-focus");
    presenterFocusActive = true;
    global.MiniPlayerControls?.hideMiniPlayer?.();
    const wrap = $("roomScreenShareWrap");
    const stage = $("roomRemoteScreenStage");
    if (wrap) {
      wrap.hidden = false;
      wrap.removeAttribute("hidden");
      wrap.setAttribute("aria-hidden", "false");
    }
    if (stage) {
      stage.hidden = false;
      stage.removeAttribute("hidden");
      stage.setAttribute("aria-hidden", "false");
    }
    if (usePresenterFloatUi()) {
      global.UiPresenterFloat?.activate?.();
    }
    ensurePresenterMediaDock();
    const onResize = () => {
      if (usePresenterFloatUi()) global.UiPresenterFloat?.reclamp?.();
      if (usePresenterMediaDock()) global.UiFloatingDock?.reclamp?.();
    };
    if (!global.__mojPresenterFloatResizeBound) {
      global.__mojPresenterFloatResizeBound = true;
      global.addEventListener("resize", onResize);
    }
    deps?.setMeetView?.("gallery");
    syncLocalSharePreview();
  }

  function resolveRemoteUid() {
    const fromDep = deps?.getShareOwnerId?.();
    if (fromDep != null && String(fromDep).trim()) {
      return String(fromDep).trim().toLowerCase();
    }
    const storeUid = deps?.AppState?.getState?.()?.share?.ownerId;
    if (storeUid != null && String(storeUid).trim()) {
      return String(storeUid).trim().toLowerCase();
    }
    const legacy = deps?.getRemoteScreenShareUserId?.();
    return legacy != null ? String(legacy).trim().toLowerCase() : "";
  }

  function resolveSharerSocketId(uid) {
    if (!uid || !deps?.remoteVideos || !deps?.peerSocketToUserId) return null;
    const preferred = deps.findPeerSocketForUserId?.(uid);
    if (preferred && deps.remoteVideos.has(preferred)) return preferred;
    let bestSocket = null;
    let bestScore = -1;
    for (const [socketId, vid] of deps.remoteVideos.entries()) {
      const u = deps.peerSocketToUserId.get(socketId);
      if (!u || String(u).trim().toLowerCase() !== uid) continue;
      const track = vid?.srcObject?.getVideoTracks?.()?.[0];
      let score = 0;
      if (deps.isDisplayCaptureVideoTrack?.(track)) score += 1e9;
      try {
        const s = track?.getSettings?.() || {};
        score += (s.width || 0) * (s.height || 0);
      } catch (_) {}
      if (score > bestScore) {
        bestScore = score;
        bestSocket = socketId;
      }
    }
    return bestSocket;
  }

  function resolveSharerTrackOrStream() {
    const uid = resolveRemoteUid();
    if (!uid) return null;
    const myNorm = String(deps?.getMyUserId?.() || "").trim().toLowerCase();
    if (uid === myNorm && deps?.isLocallySharingScreen?.()) {
      return deps?.getScreenShareStream?.() || null;
    }
    const socketId = resolveSharerSocketId(uid);
    if (!socketId) return null;
    const displayTrack = deps?.getSharerDisplayTrack?.(socketId);
    if (displayTrack) return displayTrack;
    const sourceVid = deps?.remoteVideos?.get(socketId);
    return sourceVid?.srcObject || null;
  }

  function syncStageScreenStream() {
    const vid = getStageVideo();
    const stage = $("roomRemoteScreenStage");
    if (!vid || !stage || stage.hidden) return false;
    const trackOrStream = resolveSharerTrackOrStream();
    if (!trackOrStream) return false;
    bindStageVideoRetryListeners();
    const assigned = assignStageStream(trackOrStream);
    if (assigned) {
      deps?.ScreenOverlay?.syncWithStage?.(stage);
    }
    return assigned;
  }

  function collapseChatForShareLayout() {
    if (shareChatCollapsedOnce) return;
    shareChatCollapsedOnce = true;
    if (typeof deps?.forceChatPanelClosedForShare === "function") {
      deps.forceChatPanelClosedForShare();
      return;
    }
    deps?.setChatPanelHidden?.(true);
  }

  function updateRemoteScreenShareLayout() {
    if (!deps) return;
    const shell = $("roomShell");
    if (!shell || !deps.getActiveRoomId?.()) {
      exitPresenterFocusUi();
      clearStageScreenStream();
      shell?.classList.remove("room-shell--remote-screen-dominant");
      $("videos")?.classList.remove("room-videos--screen-dominant");
      return;
    }

    const localSharing = !!deps.isLocallySharingScreen?.();
    const remoteUid = resolveRemoteUid();
    const myId = String(deps?.getMyUserId?.() || "").trim().toLowerCase();
    const viewingRemote = !!remoteUid && !localSharing && remoteUid !== myId;

    global.MiniPlayerControls?.suppressForActiveSession?.();

    if (localSharing || viewingRemote) {
      collapseChatForShareLayout();
    }

    if (localSharing) {
      deps?.onForcedRemoteStop?.();
      enterPresenterFocusUi();
      deps.applyRoomVideoStripSizing?.();
      deps.syncRemotePlaybackVolumeForShare?.();
      global.FloatPanelModule?.syncSharerTileVisibility?.();
      scheduleStageStreamSync();
      return;
    }

    exitPresenterFocusUi();

    if (viewingRemote) {
      shell.classList.add("room-shell--remote-screen-dominant");
      $("videos")?.classList.add("room-videos--screen-dominant");
      const wrap = $("roomScreenShareWrap");
      const stage = $("roomRemoteScreenStage");
      if (wrap) {
        wrap.hidden = false;
        wrap.removeAttribute("hidden");
        wrap.setAttribute("aria-hidden", "false");
      }
      if (stage) {
        stage.hidden = false;
        stage.removeAttribute("hidden");
        stage.setAttribute("aria-hidden", "false");
      }
      const socketId = resolveSharerSocketId(remoteUid);
      if (socketId) {
        deps?.refreshSharerVideoFromReceivers?.(socketId);
      }
      syncStageScreenStream();
      scheduleStageStreamSync();
      deps.applyRemoteScreenShareStripSizing?.();
      global.FloatPanelModule?.syncSharerTileVisibility?.();
    } else {
      const shareStillActive =
        global.AppState?.isShareActive?.(global.AppState?.getState?.()) ||
        !!deps?.isLocallySharingScreen?.();
      if (!shareStillActive) {
        clearStageScreenStream();
        shell.classList.remove("room-shell--remote-screen-dominant");
        $("videos")?.classList.remove("room-videos--screen-dominant");
        const wrap = $("roomScreenShareWrap");
        if (wrap) {
          wrap.hidden = true;
          wrap.setAttribute("hidden", "");
        }
      }
      global.FloatPanelModule?.syncSharerTileVisibility?.();
    }
    deps.applyRoomVideoStripSizing?.();
    deps.syncRemotePlaybackVolumeForShare?.();
  }

  function onStopScreenShare() {
    exitPresenterFocusUi();
    updateRemoteScreenShareLayout();
  }

  function onLeaveRoom() {
    if (unsubOwnerId) {
      unsubOwnerId();
      unsubOwnerId = null;
    }
    lastOwnerId = null;
    shareChatCollapsedOnce = false;
    clearStageScreenStream();
    exitPresenterFocusUi();
    const shell = $("roomShell");
    shell?.classList.remove("room-shell--remote-screen-dominant");
    $("videos")?.classList.remove("room-videos--screen-dominant");
  }

  global.RoomScreenShareLayout = {
    init,
    isPresenterFocusActive,
    ensurePresenterMediaDock,
    updateRemoteScreenShareLayout,
    syncLocalSharePreview,
    syncStageScreenStream,
    scheduleStageStreamSync,
    assignStageStream,
    ensureStageVideoAutoplayCompat,
    clearStageScreenStream,
    onStopScreenShare,
    onLeaveRoom,
  };
})(typeof window !== "undefined" ? window : global);
