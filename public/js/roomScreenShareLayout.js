/**
 * roomScreenShareLayout.js — layout pantalla compartida (presentador vs invitado).
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let presenterFocusActive = false;
  /** @type {HTMLElement | null} */
  let presenterInkPeerWrap = null;
  let attachRemoteRetryRaf = 0;
  let attachRemoteRetryCount = 0;
  const ATTACH_REMOTE_MAX_RETRIES = 4;
  /** @type {HTMLVideoElement | null} */
  let attachRemoteVideoListener = null;
  let unsubOwnerId = null;
  let lastOwnerId = null;

  function init(options = {}) {
    deps = options;
    if (global.UiPresenterFloat?.init) global.UiPresenterFloat.init(options);
    if (global.UiFloatingDock?.init) global.UiFloatingDock.init(options);

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

  function teardownPresenterInkPeer() {
    if (presenterInkPeerWrap) {
      try {
        presenterInkPeerWrap.remove();
      } catch (_) {}
      presenterInkPeerWrap = null;
    }
  }

  function ensurePresenterInkPeer() {
    const stage = $("roomRemoteScreenStage");
    if (!stage) return null;
    if (presenterInkPeerWrap?.isConnected) return presenterInkPeerWrap;
    teardownPresenterInkPeer();
    const wrap = document.createElement("div");
    wrap.className = "remote-peer remote-peer--presenter-ink-source";
    wrap.setAttribute("aria-hidden", "true");
    const track = deps?.getScreenShareTrack?.();
    const stream = deps?.getScreenShareStream?.();
    if (track && stream) {
      const vid = document.createElement("video");
      vid.autoplay = true;
      vid.playsInline = true;
      vid.muted = true;
      vid.srcObject = stream;
      vid.play().catch(() => {});
      wrap.appendChild(vid);
    }
    stage.appendChild(wrap);
    presenterInkPeerWrap = wrap;
    return wrap;
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
    teardownPresenterInkPeer();
    deps?.teardownLocalScreenShareStageWrap?.();
  }

  function ensurePresenterMediaDock() {
    if (usePresenterMediaDock()) {
      global.UiFloatingDock?.activate?.();
    }
  }

  function syncLocalSharePreview() {
    if (!deps?.isLocallySharingScreen?.()) return;
    const stage = $("roomRemoteScreenStage");
    deps.mountLocalScreenSharePreviewToStage?.();
    deps.ScreenOverlay?.syncWithStage?.(stage);
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
    const shareWrap = deps?.ensureLocalScreenShareStageWrap?.();
    if (stage && shareWrap && !shareWrap.isConnected) {
      stage.insertBefore(shareWrap, stage.firstChild);
    }
    ensurePresenterInkPeer();
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

  function unbindSharerVideoMetadata() {
    if (attachRemoteVideoListener) {
      attachRemoteVideoListener.removeEventListener(
        "loadedmetadata",
        onSharerVideoMetadata
      );
      attachRemoteVideoListener.removeEventListener("loadeddata", onSharerVideoMetadata);
      attachRemoteVideoListener = null;
    }
  }

  function clearAttachRemoteRetry() {
    if (attachRemoteRetryRaf) {
      cancelAnimationFrame(attachRemoteRetryRaf);
      attachRemoteRetryRaf = 0;
    }
    attachRemoteRetryCount = 0;
    unbindSharerVideoMetadata();
  }

  function onSharerVideoMetadata() {
    const stage = $("roomRemoteScreenStage");
    if (!stage || stage.hidden) return;
    if (attachRemoteScreenToStage()) {
      deps?.ScreenOverlay?.syncWithStage?.(stage);
      clearAttachRemoteRetry();
    }
  }

  function bindSharerVideoMetadata(video) {
    if (!video || attachRemoteVideoListener === video) return;
    unbindSharerVideoMetadata();
    attachRemoteVideoListener = video;
    video.addEventListener("loadedmetadata", onSharerVideoMetadata);
    video.addEventListener("loadeddata", onSharerVideoMetadata);
  }

  function scheduleAttachRemoteRetry() {
    if (attachRemoteRetryRaf) return;
    const tick = () => {
      attachRemoteRetryRaf = 0;
      const stage = $("roomRemoteScreenStage");
      if (!stage || stage.hidden) {
        clearAttachRemoteRetry();
        return;
      }
      if (attachRemoteScreenToStage()) {
        deps?.ScreenOverlay?.syncWithStage?.(stage);
        clearAttachRemoteRetry();
        return;
      }
      attachRemoteRetryCount += 1;
      if (attachRemoteRetryCount < ATTACH_REMOTE_MAX_RETRIES) {
        attachRemoteRetryRaf = requestAnimationFrame(tick);
      }
    };
    attachRemoteRetryRaf = requestAnimationFrame(tick);
  }

  function resolveRemoteUid() {
    const fromDep = deps?.getShareOwnerId?.();
    if (fromDep != null && String(fromDep).trim()) {
      return String(fromDep).trim().toLowerCase();
    }
    const legacy = deps?.getRemoteScreenShareUserId?.();
    return legacy != null ? String(legacy).trim().toLowerCase() : "";
  }

  /** @returns {boolean} true si el peer del sharer quedó en el stage */
  function attachRemoteScreenToStage() {
    const stage = $("roomRemoteScreenStage");
    const rc = $("remotesContainer");
    if (!stage || !rc || !deps?.remoteVideos || !deps?.peerSocketToUserId) return false;
    const uid = resolveRemoteUid();
    if (!uid) return false;
    if (uid === String(deps?.getMyUserId?.() || "").trim().toLowerCase() && deps?.isLocallySharingScreen?.()) {
      return false;
    }
    let targetVideo = null;
    for (const [socketId, vid] of deps.remoteVideos.entries()) {
      const u = deps.peerSocketToUserId.get(socketId);
      if (u && String(u).trim().toLowerCase() === uid) {
        targetVideo = vid;
        break;
      }
    }
    if (!targetVideo) return false;
    const peerWrap = targetVideo.closest?.(".remote-peer");
    if (!peerWrap) return false;
    deps?.moveStageRemotePeersToContainer?.(stage, rc);
    if (peerWrap.parentElement !== stage) {
      stage.appendChild(peerWrap);
    }
    const vid = peerWrap.querySelector("video");
    if (vid) {
      vid.play?.().catch(() => {});
      bindSharerVideoMetadata(vid);
    }
    return peerWrap.parentElement === stage;
  }

  function updateRemoteScreenShareLayout() {
    if (!deps) return;
    const shell = $("roomShell");
    if (!shell || !deps.getActiveRoomId?.()) {
      exitPresenterFocusUi();
      shell?.classList.remove("room-shell--remote-screen-dominant");
      $("videos")?.classList.remove("room-videos--screen-dominant");
      return;
    }

    const localSharing = !!deps.isLocallySharingScreen?.();
    const remoteUid = resolveRemoteUid();
    const myId = String(deps?.getMyUserId?.() || "").trim().toLowerCase();
    const viewingRemote = !!remoteUid && !localSharing && remoteUid !== myId;

    global.MiniPlayerControls?.suppressForActiveSession?.();

    if (localSharing) {
      deps?.onForcedRemoteStop?.();
      enterPresenterFocusUi();
      deps.applyRoomVideoStripSizing?.();
      deps.syncRemotePlaybackVolumeForShare?.();
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
      const attached = attachRemoteScreenToStage();
      deps.applyRemoteScreenShareStripSizing?.();
      deps.ScreenOverlay?.syncWithStage?.($("roomRemoteScreenStage"));
      if (!attached) scheduleAttachRemoteRetry();
    } else {
      clearAttachRemoteRetry();
      shell.classList.remove("room-shell--remote-screen-dominant");
      $("videos")?.classList.remove("room-videos--screen-dominant");
      const wrap = $("roomScreenShareWrap");
      if (wrap) {
        wrap.hidden = true;
        wrap.setAttribute("hidden", "");
      }
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
    clearAttachRemoteRetry();
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
    onStopScreenShare,
    onLeaveRoom,
  };
})(typeof window !== "undefined" ? window : global);
