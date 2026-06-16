/**
 * screenSharePreviewSanitizer.js — preview local sin cursor quemado (solo presentador).
 * WebRTC sigue usando el track raw; este módulo genera previewStream para <video> local.
 */
(function (global) {
  const DEFAULT_FPS = 30;
  const PATCH_SIZE = 28;
  const CURSOR_HOTSPOT_X = 4;
  const CURSOR_HOTSPOT_Y = 3;
  const STORAGE_DISABLE_KEY = "MOJ_PREVIEW_SANITIZER";

  /** @type {{ x: number, y: number } | null} */
  let pointerClientPos = null;

  function isEnabled() {
    try {
      if (global.localStorage?.getItem(STORAGE_DISABLE_KEY) === "0") return false;
    } catch (_) {}
    return true;
  }

  function hasInsertableStreams() {
    return (
      typeof global.MediaStreamTrackProcessor === "function" &&
      typeof global.MediaStreamTrackGenerator === "function" &&
      typeof global.VideoFrame === "function"
    );
  }

  function isSupported() {
    if (typeof document === "undefined") return false;
    if (!isEnabled()) return false;
    if (hasInsertableStreams()) return true;
    try {
      const c = document.createElement("canvas");
      return typeof c.captureStream === "function";
    } catch (_) {
      return false;
    }
  }

  function getVideoContentRect(videoEl, containerSize) {
    const iw = Math.max(1, containerSize.width || 1);
    const ih = Math.max(1, containerSize.height || 1);
    const vw = videoEl?.videoWidth || 0;
    const vh = videoEl?.videoHeight || 0;
    if (!vw || !vh) return { x: 0, y: 0, w: iw, h: ih };
    const vr = vw / vh;
    const tr = iw / ih;
    let dw;
    let dh;
    let dx;
    let dy;
    if (vr > tr) {
      dw = iw;
      dh = iw / vr;
      dx = 0;
      dy = (ih - dh) / 2;
    } else {
      dh = ih;
      dw = ih * vr;
      dx = (iw - dw) / 2;
      dy = 0;
    }
    return { x: dx, y: dy, w: dw, h: dh };
  }

  function clientToFramePixels(clientX, clientY, videoEl) {
    if (!videoEl || clientX == null || clientY == null) return null;
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return null;
    const rect = videoEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const cr = getVideoContentRect(videoEl, { width: rect.width, height: rect.height });
    const cx = clientX - rect.left - cr.x;
    const cy = clientY - rect.top - cr.y;
    if (cx < 0 || cy < 0 || cx > cr.w || cy > cr.h) return null;
    const fx = (cx / cr.w) * vw;
    const fy = (cy / cr.h) * vh;
    return {
      x: Math.round(fx) - CURSOR_HOTSPOT_X,
      y: Math.round(fy) - CURSOR_HOTSPOT_Y,
    };
  }


  function clientToFramePixelsWithContainer(clientX, clientY, videoWidth, videoHeight, containerRect) {
    if (clientX == null || clientY == null || !videoWidth || !videoHeight) return null;
    if (!containerRect?.width || !containerRect?.height) return null;
    const cr = getVideoContentRect(
      { videoWidth, videoHeight },
      { width: containerRect.width, height: containerRect.height }
    );
    const cx = clientX - containerRect.left - cr.x;
    const cy = clientY - containerRect.top - cr.y;
    if (cx < 0 || cy < 0 || cx > cr.w || cy > cr.h) return null;
    const fx = (cx / cr.w) * videoWidth;
    const fy = (cy / cr.h) * videoHeight;
    return {
      x: Math.round(fx) - CURSOR_HOTSPOT_X,
      y: Math.round(fy) - CURSOR_HOTSPOT_Y,
    };
  }

  function resolveFramePointer(options, videoEl) {
    const pos = options?.getPointerClientPos?.();
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      const containerEl = options?.getMappingContainerElement?.();
      const vw = videoEl?.videoWidth;
      const vh = videoEl?.videoHeight;
      if (containerEl && vw && vh) {
        const mapped = clientToFramePixelsWithContainer(
          pos.x,
          pos.y,
          vw,
          vh,
          containerEl.getBoundingClientRect()
        );
        if (mapped) return mapped;
      }
      const mapped = clientToFramePixels(pos.x, pos.y, videoEl);
      if (mapped) return mapped;
    }
    const direct = options?.getFramePointerCoords?.();
    if (direct && Number.isFinite(direct.x) && Number.isFinite(direct.y)) {
      return { x: Math.round(direct.x), y: Math.round(direct.y) };
    }
    return null;
  }

  function clampPatchRect(x, y, w, h, pw, ph) {
    const px = Math.max(0, Math.min(w - pw, x - Math.floor(pw / 2)));
    const py = Math.max(0, Math.min(h - ph, y - Math.floor(ph / 2)));
    return { x: px, y: py, w: pw, h: ph };
  }

  function applyCursorPatch(ctx, width, height, framePointer, prevCanvas) {
    if (!framePointer) return;
    const { x, y, w, h } = clampPatchRect(
      framePointer.x,
      framePointer.y,
      width,
      height,
      PATCH_SIZE,
      PATCH_SIZE
    );
    if (prevCanvas && prevCanvas.width === width && prevCanvas.height === height) {
      try {
        ctx.drawImage(prevCanvas, x, y, w, h, x, y, w, h);
        return;
      } catch (_) {}
    }
    try {
      const img = ctx.getImageData(x, y, w, h);
      const data = img.data;
      const ring = 3;
      for (let py = ring; py < h - ring; py++) {
        for (let px = ring; px < w - ring; px++) {
          let r = 0;
          let g = 0;
          let b = 0;
          let n = 0;
          for (let oy = -ring; oy <= ring; oy++) {
            for (let ox = -ring; ox <= ring; ox++) {
              if (Math.abs(ox) !== ring && Math.abs(oy) !== ring) continue;
              const sx = px + ox;
              const sy = py + oy;
              if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
              const si = (sy * w + sx) * 4;
              r += data[si];
              g += data[si + 1];
              b += data[si + 2];
              n++;
            }
          }
          if (!n) continue;
          const di = (py * w + px) * 4;
          data[di] = (r / n) | 0;
          data[di + 1] = (g / n) | 0;
          data[di + 2] = (b / n) | 0;
        }
      }
      ctx.putImageData(img, x, y);
    } catch (_) {}
  }

  function bindPointerTracking() {
    const onMove = (ev) => {
      pointerClientPos = { x: ev.clientX, y: ev.clientY };
    };
    global.addEventListener("pointermove", onMove, { passive: true });
    global.addEventListener("pointerrawupdate", onMove, { passive: true });
    return () => {
      global.removeEventListener("pointermove", onMove);
      global.removeEventListener("pointerrawupdate", onMove);
      pointerClientPos = null;
    };
  }

  function ensureHiddenVideo() {
    const videoEl = document.createElement("video");
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute("playsinline", "");
    videoEl.style.cssText =
      "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;left:-9999px;top:0;";
    document.body.appendChild(videoEl);
    return videoEl;
  }

  function isRemovableDomCanvas(canvas) {
    return !!(canvas && typeof canvas.remove === "function");
  }

  function ensureProcessCanvas(width, height) {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(width, height)
        : document.createElement("canvas");
    if (typeof OffscreenCanvas === "undefined" || !(canvas instanceof OffscreenCanvas)) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.cssText =
        "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;left:-9999px;top:0;";
      document.body.appendChild(canvas);
    } else {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    return { canvas, ctx };
  }

  function create(rawVideoTrack, options = {}) {
    if (!rawVideoTrack || rawVideoTrack.kind !== "video" || rawVideoTrack.readyState !== "live") {
      return null;
    }
    if (!isSupported()) {
      options.onFallback?.();
      return null;
    }

    const fps = Math.max(12, Math.min(60, options.fps || DEFAULT_FPS));
    let stopped = false;
    let mode = "canvas";
    let prevFrameCanvas = null;
    let prevFrameCtx = null;
    let processor = null;
    let generator = null;
    let generatorWriter = null;
    let rafId = 0;
    let hiddenVideo = null;
    let processCanvas = null;
    let processCtx = null;
    let previewStream = null;
    let previewTrack = null;

    const unbindPointer = bindPointerTracking();

    hiddenVideo = ensureHiddenVideo();
    hiddenVideo.srcObject = new MediaStream([rawVideoTrack]);
    hiddenVideo.play().catch(() => {});

    const getMappingVideoEl = () => {
      const external = options.getMappingVideoEl?.();
      if (external?.videoWidth) return external;
      return hiddenVideo;
    };

    const getPointerPos = () => {
      const pos = options.getPointerClientPos?.();
      if (pos && Number.isFinite(pos.x)) return pos;
      return pointerClientPos;
    };

    function savePrevFrame(sourceCanvas, width, height) {
      if (!prevFrameCanvas || prevFrameCanvas.width !== width || prevFrameCanvas.height !== height) {
        const prev = ensureProcessCanvas(width, height);
        prevFrameCanvas = prev.canvas;
        prevFrameCtx = prev.ctx;
      }
      if (prevFrameCtx) {
        prevFrameCtx.drawImage(sourceCanvas, 0, 0, width, height);
      }
    }

    async function startProcessorPipeline() {
      processor = new global.MediaStreamTrackProcessor({ track: rawVideoTrack });
      generator = new global.MediaStreamTrackGenerator({ kind: "video" });
      previewTrack = generator.track;
      previewStream = new MediaStream([previewTrack]);
      generatorWriter = generator.writable.getWriter();
      mode = "processor";

      const reader = processor.readable.getReader();
      try {
        while (!stopped) {
          const { done, value: frame } = await reader.read();
          if (done || stopped || !frame) break;
          const w = frame.displayWidth;
          const h = frame.displayHeight;
          if (!processCanvas || processCanvas.width !== w || processCanvas.height !== h) {
            const built = ensureProcessCanvas(w, h);
            processCanvas = built.canvas;
            processCtx = built.ctx;
          }
          processCtx.drawImage(frame, 0, 0, w, h);
          const mappingVideo = getMappingVideoEl();
          const framePointer = resolveFramePointer(
            { ...options, getPointerClientPos: getPointerPos },
            mappingVideo
          );
          applyCursorPatch(processCtx, w, h, framePointer, prevFrameCanvas);
          savePrevFrame(processCanvas, w, h);
          const outFrame = new global.VideoFrame(processCanvas, { timestamp: frame.timestamp });
          frame.close();
          if (stopped) {
            outFrame.close();
            break;
          }
          await generatorWriter.write(outFrame);
          outFrame.close();
        }
      } catch (e) {
        if (!stopped) {
          console.warn("[preview-sanitizer] processor loop", e);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch (_) {}
      }
    }

    function startCanvasPipeline() {
      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = 640;
      outputCanvas.height = 360;
      outputCanvas.style.cssText =
        "position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;left:-9999px;top:0;";
      document.body.appendChild(outputCanvas);
      processCanvas = outputCanvas;
      processCtx = outputCanvas.getContext("2d", { willReadFrequently: true });
      previewStream = outputCanvas.captureStream(fps);
      previewTrack = previewStream.getVideoTracks()[0] || null;
      mode = "canvas";

      const tick = () => {
        if (stopped) return;
        const vw = hiddenVideo.videoWidth;
        const vh = hiddenVideo.videoHeight;
        if (hiddenVideo.readyState >= 2 && vw > 0 && vh > 0) {
          if (outputCanvas.width !== vw || outputCanvas.height !== vh) {
            outputCanvas.width = vw;
            outputCanvas.height = vh;
          }
          processCtx.drawImage(hiddenVideo, 0, 0, vw, vh);
          const mappingVideo = getMappingVideoEl();
          const framePointer = resolveFramePointer(
            { ...options, getPointerClientPos: getPointerPos },
            mappingVideo
          );
          applyCursorPatch(processCtx, vw, vh, framePointer, prevFrameCanvas);
          savePrevFrame(outputCanvas, vw, vh);
        }
        rafId = global.requestAnimationFrame(tick);
      };
      rafId = global.requestAnimationFrame(tick);
    }

    try {
      if (hasInsertableStreams()) {
        void startProcessorPipeline();
      } else {
        startCanvasPipeline();
      }
    } catch (e) {
      console.warn("[preview-sanitizer] start failed, canvas fallback", e);
      try {
        startCanvasPipeline();
      } catch (e2) {
        unbindPointer();
        if (hiddenVideo) {
          hiddenVideo.srcObject = null;
          hiddenVideo.remove();
        }
        options.onFallback?.();
        return null;
      }
    }

    if (!previewStream) {
      unbindPointer();
      options.onFallback?.();
      return null;
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      unbindPointer();
      if (rafId) {
        global.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (generatorWriter) {
        generatorWriter.close().catch(() => {});
        generatorWriter = null;
      }
      if (previewTrack) {
        try {
          previewTrack.stop();
        } catch (_) {}
      }
      try {
        rawVideoTrack.removeEventListener?.("ended", stop);
      } catch (_) {}
      if (hiddenVideo) {
        hiddenVideo.srcObject = null;
        hiddenVideo.remove();
        hiddenVideo = null;
      }
      if (isRemovableDomCanvas(processCanvas)) {
        processCanvas.remove();
      }
      if (isRemovableDomCanvas(prevFrameCanvas)) {
        prevFrameCanvas.remove();
      }
      processor = null;
      generator = null;
      previewStream = null;
      previewTrack = null;
    }

    try {
      rawVideoTrack.addEventListener("ended", stop);
    } catch (_) {}

    return {
      previewStream,
      previewTrack,
      stop,
      mode,
    };
  }

  global.ScreenSharePreviewSanitizer = {
    isEnabled,
    isSupported,
    create,
    _internals: {
      getVideoContentRect,
      clientToFramePixels,
      applyCursorPatch,
      clampPatchRect,
    },
  };
})(typeof window !== "undefined" ? window : global);
