/**
 * videoEffects.js — efectos en tiempo real sobre la cámara local (blur de fondo).
 * Requiere SelfieSegmentation global (CDN en index.html).
 */
(function (global) {
  const STORAGE_KEY = "moj_video_blur";
  const BLUR_PX = 12;
  const CAPTURE_FPS = 24;
  const MIN_FPS = 12;
  const LOW_FPS_WINDOW_MS = 3000;
  const MP_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1";

  const videoEffectsEnabled = { blur: false };

  let onPerformanceFallback = null;
  let segmentation = null;
  let segmentationReady = null;
  let rawStream = null;
  let outputStream = null;
  let outputVideoTrack = null;
  let running = false;
  let processing = false;
  let rafId = 0;

  let videoEl = null;
  let canvasEl = null;
  let canvasCtx = null;
  let personCanvas = null;
  let personCtx = null;

  let frameTimes = [];
  let lowFpsSince = 0;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "1") videoEffectsEnabled.blur = true;
  } catch (_) {}

  function persistBlurPref() {
    try {
      localStorage.setItem(STORAGE_KEY, videoEffectsEnabled.blur ? "1" : "0");
    } catch (_) {}
  }

  function ensureDom() {
    if (!videoEl) {
      videoEl = document.createElement("video");
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.setAttribute("playsinline", "");
      videoEl.style.cssText = "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;";
      document.body.appendChild(videoEl);
    }
    if (!canvasEl) {
      canvasEl = document.createElement("canvas");
      canvasEl.style.cssText = "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;";
      document.body.appendChild(canvasEl);
      canvasCtx = canvasEl.getContext("2d", { willReadFrequently: false });
    }
    if (!personCanvas) {
      personCanvas = document.createElement("canvas");
      personCtx = personCanvas.getContext("2d", { willReadFrequently: false });
    }
  }

  function loadSegmentation() {
    if (segmentationReady) return segmentationReady;
    if (typeof global.SelfieSegmentation !== "function") {
      return Promise.reject(new Error("SelfieSegmentation no disponible"));
    }
    segmentationReady = new Promise((resolve, reject) => {
      try {
        const seg = new global.SelfieSegmentation({
          locateFile: (file) => `${MP_BASE}/${file}`,
        });
        seg.setOptions({ modelSelection: 1 });
        seg.onResults(onSegmentationResults);
        segmentation = seg;
        resolve(seg);
      } catch (e) {
        reject(e);
      }
    });
    return segmentationReady;
  }

  function getRawVideoTrack() {
    return rawStream?.getVideoTracks?.()[0] ?? null;
  }

  function noteFrameTiming() {
    const now = performance.now();
    frameTimes.push(now);
    const cutoff = now - LOW_FPS_WINDOW_MS;
    frameTimes = frameTimes.filter((t) => t >= cutoff);
    if (frameTimes.length < 2) return;
    const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
    if (span <= 0) return;
    const fps = ((frameTimes.length - 1) * 1000) / span;
    if (fps < MIN_FPS) {
      if (!lowFpsSince) lowFpsSince = now;
      else if (now - lowFpsSince >= LOW_FPS_WINDOW_MS) {
        disableForPerformance();
      }
    } else {
      lowFpsSince = 0;
    }
  }

  function disableForPerformance() {
    if (!videoEffectsEnabled.blur) return;
    videoEffectsEnabled.blur = false;
    persistBlurPref();
    try {
      onPerformanceFallback?.();
    } catch (_) {}
    void stopProcessor(true);
  }

  function onSegmentationResults(results) {
    if (!running || !canvasCtx || !personCtx) return;
    const w = canvasEl.width;
    const h = canvasEl.height;
    if (!w || !h || !results?.image) return;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, w, h);
    canvasCtx.filter = `blur(${BLUR_PX}px)`;
    canvasCtx.drawImage(results.image, 0, 0, w, h);
    canvasCtx.filter = "none";

    personCtx.clearRect(0, 0, w, h);
    personCtx.drawImage(results.segmentationMask, 0, 0, w, h);
    personCtx.globalCompositeOperation = "source-in";
    personCtx.drawImage(results.image, 0, 0, w, h);
    personCtx.globalCompositeOperation = "source-over";

    canvasCtx.drawImage(personCanvas, 0, 0, w, h);
    canvasCtx.restore();

    noteFrameTiming();
  }

  function scheduleLoop() {
    cancelAnimationFrame(rafId);
    const tick = async () => {
      if (!running) return;
      const vt = getRawVideoTrack();
      if (!vt || vt.readyState === "ended") {
        rafId = requestAnimationFrame(tick);
        return;
      }
      if (!vt.enabled || videoEl.readyState < 2) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      if (!processing && segmentation) {
        processing = true;
        try {
          await segmentation.send({ image: videoEl });
        } catch (e) {
          console.warn("videoEffects send", e);
        }
        processing = false;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  async function startProcessor(stream) {
    const videoTrack = stream?.getVideoTracks?.()[0];
    if (!videoTrack) return stream;

    ensureDom();
    await loadSegmentation();

    rawStream = stream;
    running = true;
    frameTimes = [];
    lowFpsSince = 0;

    videoEl.srcObject = new MediaStream([videoTrack]);
    await videoEl.play().catch(() => {});

    const settings = videoTrack.getSettings?.() || {};
    const w = settings.width || videoEl.videoWidth || 640;
    const h = settings.height || videoEl.videoHeight || 480;
    canvasEl.width = w;
    canvasEl.height = h;
    personCanvas.width = w;
    personCanvas.height = h;

    if (outputVideoTrack) {
      try {
        outputVideoTrack.stop();
      } catch (_) {}
    }

    outputStream = canvasEl.captureStream(CAPTURE_FPS);
    outputVideoTrack = outputStream.getVideoTracks()[0] || null;

    stream.getAudioTracks().forEach((t) => {
      try {
        outputStream.addTrack(t);
      } catch (_) {}
    });

    scheduleLoop();
    return outputStream;
  }

  async function stopProcessor(stopOutputTrack) {
    running = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
    processing = false;
    frameTimes = [];
    lowFpsSince = 0;

    if (videoEl) {
      videoEl.pause?.();
      videoEl.srcObject = null;
    }

    if (stopOutputTrack !== false && outputVideoTrack) {
      try {
        outputVideoTrack.stop();
      } catch (_) {}
    }
    outputVideoTrack = null;
    outputStream = null;
  }

  function init(opts) {
    if (typeof opts?.onPerformanceFallback === "function") {
      onPerformanceFallback = opts.onPerformanceFallback;
    }
  }

  async function applyBackgroundBlur(stream) {
    if (!stream || !videoEffectsEnabled.blur) {
      await stopProcessor(false);
      return stream;
    }
    const videoTrack = stream.getVideoTracks?.()[0];
    if (!videoTrack) return stream;

    try {
      await stopProcessor(true);
      return await startProcessor(stream);
    } catch (e) {
      console.warn("applyBackgroundBlur fallback", e);
      videoEffectsEnabled.blur = false;
      persistBlurPref();
      await stopProcessor(false);
      return stream;
    }
  }

  function setBlurEnabled(on) {
    videoEffectsEnabled.blur = !!on;
    persistBlurPref();
  }

  function getRawStream() {
    return rawStream;
  }

  function isActive() {
    return running && !!outputStream;
  }

  async function dispose() {
    await stopProcessor(true);
    rawStream = null;
  }

  global.VideoEffects = {
    videoEffectsEnabled,
    init,
    applyBackgroundBlur,
    setBlurEnabled,
    getRawStream,
    isActive,
    dispose,
  };
})(typeof window !== "undefined" ? window : globalThis);
