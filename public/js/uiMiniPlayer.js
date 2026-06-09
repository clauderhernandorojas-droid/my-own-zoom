/**
 * uiMiniPlayer.js — mini-player flotante al ocultar la pestaña durante una reunión.
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let mounted = false;
  let active = false;
  let rootEl = null;
  let videoEl = null;
  let placeholderEl = null;
  let btnMic = null;
  let btnCam = null;

  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginLeft = 0;
  let dragOriginTop = 0;
  let dragging = false;
  let autoPipActive = false;

  function pipSupported() {
    return !!(document.pictureInPictureEnabled && typeof HTMLVideoElement !== "undefined");
  }

  function injectStyles() {
    if (document.getElementById("miniPlayerStyles")) return;
    const link = document.createElement("link");
    link.id = "miniPlayerStyles";
    link.rel = "stylesheet";
    link.href = "/css/uiMiniPlayer.css";
    document.head.appendChild(link);
  }

  function removeLegacyControls() {
    if (!rootEl) return;
    rootEl.querySelector("#pipBtn")?.remove();
    rootEl.querySelector('[data-action="pip"]')?.remove();
    rootEl.querySelector('[data-action="preview-mute"]')?.remove();
  }

  function clampPosition() {
    if (!rootEl) return;
    const rect = rootEl.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    let left = parseFloat(rootEl.style.left);
    let top = parseFloat(rootEl.style.top);
    if (!Number.isFinite(left)) left = window.innerWidth - rect.width - 20;
    if (!Number.isFinite(top)) top = window.innerHeight - rect.height - 20;
    rootEl.style.left = Math.min(maxLeft, Math.max(0, left)) + "px";
    rootEl.style.top = Math.min(maxTop, Math.max(0, top)) + "px";
    rootEl.style.right = "auto";
    rootEl.style.bottom = "auto";
  }

  function onDragMove(e) {
    if (!dragging || !rootEl) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    rootEl.style.left = dragOriginLeft + dx + "px";
    rootEl.style.top = dragOriginTop + dy + "px";
    rootEl.style.right = "auto";
    rootEl.style.bottom = "auto";
    clampPosition();
  }

  function onDragEnd() {
    dragging = false;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }

  function startDrag(e) {
    if (!rootEl || e.button !== 0) return;
    e.preventDefault();
    const rect = rootEl.getBoundingClientRect();
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragOriginLeft = rect.left;
    dragOriginTop = rect.top;
    rootEl.style.left = dragOriginLeft + "px";
    rootEl.style.top = dragOriginTop + "px";
    rootEl.style.right = "auto";
    rootEl.style.bottom = "auto";
    dragging = true;
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  }

  function hasLiveVideo(stream) {
    const vt = stream?.getVideoTracks?.()[0];
    return !!(vt && vt.readyState === "live" && vt.enabled);
  }

  function pickBestRemoteStream() {
    const map = deps?.getRemoteVideos?.();
    if (!map || typeof map[Symbol.iterator] !== "function") return null;
    const stage =
      typeof document !== "undefined" ? document.getElementById("roomRemoteScreenStage") : null;
    let screenStream = null;
    let cameraStream = null;
    for (const [, vid] of map) {
      if (!vid) continue;
      const stream = vid.srcObject;
      if (!hasLiveVideo(stream)) continue;
      const wrap = vid.closest?.(".remote-peer");
      if (stage && wrap && stage.contains(wrap)) continue;
      if (wrap?.classList?.contains("remote-peer--screen-share")) {
        screenStream = stream;
      } else if (!cameraStream) {
        cameraStream = stream;
      }
    }
    return screenStream || cameraStream || null;
  }

  function syncControlLabels() {
    if (!btnMic || !btnCam) return;
    const getLocalStream = deps?.getLocalStream;
    const local = typeof getLocalStream === "function" ? getLocalStream() : null;
    const mic = local?.getAudioTracks?.()[0];
    const cam = local?.getVideoTracks?.()[0];
    const micOn = !!(mic && mic.readyState === "live" && mic.enabled);
    const camOn = !!(cam && cam.readyState === "live" && cam.enabled);
    btnMic.textContent = micOn ? "Mic ON" : "Mic OFF";
    btnMic.dataset.off = micOn ? "false" : "true";
    btnCam.textContent = camOn ? "Vídeo ON" : "Vídeo OFF";
    btnCam.dataset.off = camOn ? "false" : "true";
  }

  async function exitPipIfNeeded() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      }
    } catch (_) {}
    autoPipActive = false;
  }

  function attachStreamToVideo(stream) {
    if (!videoEl) return;
    videoEl.srcObject = stream;
    videoEl.classList.remove("hidden");
    placeholderEl?.classList.add("hidden");
    return videoEl.play().catch(() => {});
  }

  function shouldSuppressMiniPlayer() {
    const appState = global.AppState?.getState?.();
    if (appState?.ui?.currentLayout === "share") return true;
    if (global.AppState?.isShareActive?.(appState)) return true;
    if (global.ClientEnv?.isShareLayoutActive?.()) return true;
    if (global.RoomScreenShareLayout?.isPresenterFocusActive?.()) return true;
    if (deps?.getActiveRoomId?.() && !document.hidden) return true;
    return false;
  }

  function suppressForActiveSession() {
    return hideMiniPlayer();
  }

  function onWindowFocusRestore() {
    if (deps?.getActiveRoomId?.() && !document.hidden) {
      void hideMiniPlayer();
    }
  }

  /** auto-PiP: ventana nativa del sistema sobre videoEl. */
  async function tryAutoPip(stream, opts = {}) {
    if (shouldSuppressMiniPlayer()) {
      return false;
    }
    if (!videoEl || !rootEl || !pipSupported() || !hasLiveVideo(stream)) {
      return false;
    }
    if (document.pictureInPictureElement === videoEl) {
      active = true;
      autoPipActive = !!opts.auto;
      return true;
    }
    await attachStreamToVideo(stream);
    rootEl.classList.add("hidden");
    try {
      await videoEl.requestPictureInPicture();
      active = true;
      autoPipActive = !!opts.auto;
      return true;
    } catch (e) {
      autoPipActive = false;
      deps?.log?.((opts.auto ? "auto-PiP" : "PiP") + ": " + (e?.message || e));
      // fallback: div flotante
      showMiniPlayer(stream);
      return false;
    }
  }

  function showMiniPlayer(stream) {
    if (shouldSuppressMiniPlayer()) {
      void hideMiniPlayer();
      return;
    }
    if (!rootEl || !videoEl || !placeholderEl) return;
    const live = hasLiveVideo(stream);
    if (live) {
      videoEl.srcObject = stream;
      videoEl.classList.remove("hidden");
      placeholderEl.classList.add("hidden");
      videoEl.play().catch(() => {});
    } else {
      videoEl.srcObject = null;
      videoEl.classList.add("hidden");
      placeholderEl.classList.remove("hidden");
    }
    rootEl.classList.remove("hidden");
    active = true;
    syncControlLabels();
  }

  async function hideMiniPlayer() {
    if (!rootEl) return;
    await exitPipIfNeeded();
    rootEl.classList.add("hidden");
    if (videoEl) {
      videoEl.pause?.();
      videoEl.srcObject = null;
      videoEl.classList.add("hidden");
    }
    placeholderEl?.classList.add("hidden");
    autoPipActive = false;
    active = false;
  }

  function isActive() {
    return active;
  }

  function onLeavePictureInPicture() {
    autoPipActive = false;
    if (shouldSuppressMiniPlayer()) {
      void hideMiniPlayer();
      return;
    }
    if (document.hidden && deps?.getActiveRoomId?.()) {
      // fallback: div flotante tras cerrar PiP con pestaña aún oculta
      rootEl?.classList.remove("hidden");
      active = true;
      if (videoEl?.srcObject) {
        videoEl.classList.remove("hidden");
        placeholderEl?.classList.add("hidden");
        videoEl.play?.().catch(() => {});
      } else {
        videoEl?.classList.add("hidden");
        placeholderEl?.classList.remove("hidden");
      }
      syncControlLabels();
    } else {
      void hideMiniPlayer();
    }
  }

  function onVisibilityChange() {
    if (!deps?.getActiveRoomId?.()) return;
    if (shouldSuppressMiniPlayer()) {
      void hideMiniPlayer();
      return;
    }
    if (document.hidden) {
      const stream = pickBestRemoteStream();
      if (hasLiveVideo(stream) && pipSupported()) {
        void tryAutoPip(stream, { auto: true });
      } else {
        // fallback: div flotante (sin vídeo → placeholder)
        showMiniPlayer(stream);
      }
    } else {
      void hideMiniPlayer();
    }
  }

  function mountDom() {
    if (document.getElementById("miniPlayer")) {
      rootEl = document.getElementById("miniPlayer");
      videoEl = rootEl.querySelector("video");
      placeholderEl = rootEl.querySelector(".mini-player__placeholder");
      btnMic = rootEl.querySelector('[data-action="mic"]');
      btnCam = rootEl.querySelector('[data-action="cam"]');
      injectStyles();
      removeLegacyControls();
      if (videoEl && videoEl.dataset.pipLeaveWired !== "1") {
        videoEl.dataset.pipLeaveWired = "1";
        videoEl.addEventListener("leavepictureinpicture", onLeavePictureInPicture);
      }
      return;
    }

    injectStyles();
    rootEl = document.createElement("div");
    rootEl.id = "miniPlayer";
    rootEl.className = "hidden";
    rootEl.setAttribute("role", "region");
    rootEl.setAttribute("aria-label", "Mini reproductor de reunión");

    const handle = document.createElement("div");
    handle.className = "mini-player__drag-handle";
    handle.innerHTML = '<span>My Own Zoom</span><span aria-hidden="true">⠿</span>';
    handle.addEventListener("mousedown", startDrag);

    const body = document.createElement("div");
    body.className = "mini-player__body";

    videoEl = document.createElement("video");
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    videoEl.setAttribute("playsinline", "");
    videoEl.muted = false;

    placeholderEl = document.createElement("div");
    placeholderEl.className = "mini-player__placeholder hidden";
    placeholderEl.textContent = "Sin vídeo remoto";

    body.appendChild(videoEl);
    body.appendChild(placeholderEl);

    const controls = document.createElement("div");
    controls.className = "mini-player__controls";

    btnMic = document.createElement("button");
    btnMic.type = "button";
    btnMic.dataset.action = "mic";
    btnMic.textContent = "Mic";
    btnMic.addEventListener("click", () => {
      const getLocalStream = deps?.getLocalStream;
      const local = typeof getLocalStream === "function" ? getLocalStream() : null;
      const t = local?.getAudioTracks?.()[0];
      if (!t) return;
      deps?.setMicEnabled?.(!t.enabled);
      deps?.syncMediaButtons?.();
      syncControlLabels();
    });

    btnCam = document.createElement("button");
    btnCam.type = "button";
    btnCam.dataset.action = "cam";
    btnCam.textContent = "Vídeo";
    btnCam.addEventListener("click", () => {
      const getLocalStream = deps?.getLocalStream;
      const local = typeof getLocalStream === "function" ? getLocalStream() : null;
      const t = local?.getVideoTracks?.()[0];
      if (!t) return;
      deps?.setCamEnabled?.(!t.enabled);
      deps?.syncMediaButtons?.();
      syncControlLabels();
    });

    const btnRestore = document.createElement("button");
    btnRestore.type = "button";
    btnRestore.dataset.action = "restore";
    btnRestore.textContent = "Restaurar";
    btnRestore.addEventListener("click", () => {
      void hideMiniPlayer();
      try {
        window.focus();
      } catch (_) {}
    });

    controls.appendChild(btnMic);
    controls.appendChild(btnCam);
    controls.appendChild(btnRestore);

    rootEl.appendChild(handle);
    rootEl.appendChild(body);
    rootEl.appendChild(controls);
    document.body.appendChild(rootEl);

    videoEl.addEventListener("leavepictureinpicture", onLeavePictureInPicture);
  }

  /**
   * @param {object} options
   */
  function initMiniPlayer(options) {
    deps = options || {};
    if (!mounted) {
      mountDom();
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("focus", onWindowFocusRestore);
      mounted = true;
    }
    if (deps?.getActiveRoomId?.()) {
      void suppressForActiveSession();
    }
  }

  global.MiniPlayerControls = {
    initMiniPlayer,
    showMiniPlayer,
    hideMiniPlayer,
    suppressForActiveSession,
    shouldSuppressMiniPlayer,
    isActive,
  };
})(typeof window !== "undefined" ? window : globalThis);
