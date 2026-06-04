/**
 * roomScreenShareLayout.js — layout pantalla compartida (presentador vs invitado).
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let presenterFocusActive = false;
  /** @type {HTMLElement | null} */
  let presenterInkPeerWrap = null;

  function init(options = {}) {
    deps = options;
    if (global.UiPresenterFloat?.init) global.UiPresenterFloat.init(options);
    if (global.UiFloatingDock?.init) global.UiFloatingDock.init(options);
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

  function usePresenterDesktopUi() {
    return deps?.enablePresenterDesktopUi !== false;
  }

  function exitPresenterFocusUi() {
    presenterFocusActive = false;
    const shell = $("roomShell");
    shell?.classList.remove("room-shell--presenter-focus");
    if (usePresenterDesktopUi()) {
      global.UiPresenterFloat?.deactivate?.();
      global.UiFloatingDock?.deactivate?.();
    }
    teardownPresenterInkPeer();
    deps?.teardownLocalScreenShareStageWrap?.();
  }

  function enterPresenterFocusUi() {
    const shell = $("roomShell");
    if (!shell) return;
    shell.classList.remove("room-shell--remote-screen-dominant");
    shell.classList.add("room-shell--presenter-focus");
    presenterFocusActive = true;
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
    if (usePresenterDesktopUi()) {
      global.UiPresenterFloat?.activate?.();
      global.UiFloatingDock?.activate?.();
    }
    const onResize = () => {
      if (!usePresenterDesktopUi()) return;
      global.UiPresenterFloat?.reclamp?.();
      global.UiFloatingDock?.reclamp?.();
    };
    if (!global.__mojPresenterFloatResizeBound) {
      global.__mojPresenterFloatResizeBound = true;
      global.addEventListener("resize", onResize);
    }
    deps?.setMeetView?.("gallery");
    deps?.ScreenOverlay?.syncWithStage?.(stage);
  }

  function attachRemoteScreenToStage() {
    const stage = $("roomRemoteScreenStage");
    const rc = $("remotesContainer");
    if (!stage || !rc || !deps?.remoteVideos || !deps?.peerSocketToUserId) return;
    const uid = String(deps.getRemoteScreenShareUserId?.() || "").trim().toLowerCase();
    if (!uid) return;
    let targetVideo = null;
    for (const [socketId, vid] of deps.remoteVideos.entries()) {
      const u = deps.peerSocketToUserId.get(socketId);
      if (u && String(u).trim().toLowerCase() === uid) {
        targetVideo = vid;
        break;
      }
    }
    if (!targetVideo) return;
    const peerWrap = targetVideo.closest?.(".remote-peer");
    if (!peerWrap) return;
    deps?.moveStageRemotePeersToContainer?.(stage, rc);
    if (peerWrap.parentElement !== stage) {
      stage.appendChild(peerWrap);
    }
    const vid = peerWrap.querySelector("video");
    if (vid) vid.play?.().catch(() => {});
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
    const remoteUid = String(deps.getRemoteScreenShareUserId?.() || "").trim();
    const viewingRemote = !!remoteUid && !localSharing;

    if (localSharing) {
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
      attachRemoteScreenToStage();
      deps.applyRemoteScreenShareStripSizing?.();
      deps.ScreenOverlay?.syncWithStage?.($("roomRemoteScreenStage"));
    } else {
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
    exitPresenterFocusUi();
    const shell = $("roomShell");
    shell?.classList.remove("room-shell--remote-screen-dominant");
    $("videos")?.classList.remove("room-videos--screen-dominant");
  }

  global.RoomScreenShareLayout = {
    init,
    isPresenterFocusActive,
    updateRemoteScreenShareLayout,
    onStopScreenShare,
    onLeaveRoom,
  };
})(typeof window !== "undefined" ? window : global);
