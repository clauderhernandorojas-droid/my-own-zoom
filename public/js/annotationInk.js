/**
 * annotationInk.js — geometría y dibujo de tinta sobre vídeo (coords normalizadas 0–1).
 * Sin DOM ni socket; reutilizable por screenOverlay y grabación compuesta (fase 2).
 */
(function (global) {
  /**
   * Rectángulo útil del vídeo dentro del contenedor (object-fit: contain).
   * @param {HTMLVideoElement} videoEl
   * @param {{ width: number, height: number }} containerSize
   * @returns {{ x: number, y: number, w: number, h: number }}
   */
  function getVideoContentRect(videoEl, containerSize) {
    const iw = Math.max(1, containerSize.width || 1);
    const ih = Math.max(1, containerSize.height || 1);
    const vw = videoEl?.videoWidth || 0;
    const vh = videoEl?.videoHeight || 0;
    if (!vw || !vh) {
      return { x: 0, y: 0, w: iw, h: ih };
    }
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

  /**
   * Rectángulo útil del vídeo en coords CSS del canvas (letterbox + offset del layout box del video).
   * @param {HTMLVideoElement | null} videoEl
   * @param {HTMLCanvasElement} canvasEl
   * @returns {{ x: number, y: number, w: number, h: number }}
   */
  function getVideoContentRectForOverlay(videoEl, canvasEl) {
    const canvasRect = canvasEl?.getBoundingClientRect?.();
    if (!canvasRect?.width || !canvasRect?.height) {
      return { x: 0, y: 0, w: 1, h: 1 };
    }
    return getVideoContentRect(videoEl, {
      width: canvasRect.width,
      height: canvasRect.height,
    });
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {HTMLCanvasElement} canvasEl
   * @param {{ x: number, y: number, w: number, h: number }} contentRect — en px del canvas
   */
  function clientToNorm(clientX, clientY, canvasEl, contentRect) {
    const rect = canvasEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0, inBounds: false };
    const scaleX = canvasEl.width / rect.width;
    const scaleY = canvasEl.height / rect.height;
    const cx = (clientX - rect.left) * scaleX;
    const cy = (clientY - rect.top) * scaleY;
    const cr = contentRect || { x: 0, y: 0, w: canvasEl.width, h: canvasEl.height };
    if (!cr.w || !cr.h) return { x: 0, y: 0, inBounds: false };
    const nx = (cx - cr.x) / cr.w;
    const ny = (cy - cr.y) / cr.h;
    return {
      x: nx,
      y: ny,
      inBounds: nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1,
    };
  }

  function normToCanvas(nx, ny, contentRect) {
    return {
      x: contentRect.x + nx * contentRect.w,
      y: contentRect.y + ny * contentRect.h,
    };
  }

  function cloneInkState(state) {
    return {
      elementos: (state?.elementos || []).map((el) => {
        if (el.type === "stroke") {
          return {
            ...el,
            points: (el.points || []).map((p) => ({ x: p.x, y: p.y })),
          };
        }
        return { ...el };
      }),
    };
  }

  function strokeLineWidthPx(el, contentRect) {
    const lw = typeof el.lw === "number" ? el.lw : typeof el.linewidthNorm === "number" ? el.linewidthNorm : 0.008;
    return Math.max(1, lw * contentRect.h);
  }

  function drawStroke(ctx, el, contentRect) {
    const pts = el.points;
    if (!pts || pts.length < 2) return;
    ctx.strokeStyle = el.color || "#111111";
    ctx.lineWidth = strokeLineWidthPx(el, contentRect);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    const p0 = normToCanvas(pts[0].x, pts[0].y, contentRect);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = normToCanvas(pts[i].x, pts[i].y, contentRect);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  function drawText(ctx, el, contentRect) {
    const text = String(el.text || "").trim();
    if (!text) return;
    const tl = normToCanvas(el.x || 0, el.y || 0, contentRect);
    const w = (el.w || 0.25) * contentRect.w;
    const h = (el.h || 0.1) * contentRect.h;
    const fontSize = Math.max(8, Math.min(160, Number(el.fontSize) || 22));
    const scale = contentRect.h / 720;
    const fs = Math.round(fontSize * Math.max(0.5, Math.min(2, scale)));
    ctx.fillStyle = el.color || "#111111";
    ctx.font = `${fs}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    wrapText(ctx, text, tl.x, tl.y, w, fs * 1.25);
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(/\s+/);
    let line = "";
    let cy = y;
    for (let i = 0; i < words.length; i++) {
      const test = line ? `${line} ${words[i]}` : words[i];
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, cy);
        line = words[i];
        cy += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, cy);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object[]} elementos
   * @param {{ x: number, y: number, w: number, h: number }} contentRect
   * @param {{ previewStroke?: object }} [opts]
   */
  function drawInkElementos(ctx, elementos, contentRect, opts = {}) {
    const els = elementos || [];
    for (const el of els) {
      if (el.type === "stroke") drawStroke(ctx, el, contentRect);
      else if (el.type === "text") drawText(ctx, el, contentRect);
    }
    if (opts.previewStroke?.points?.length >= 1) {
      const preview = opts.previewStroke;
      const pts = preview.points;
      if (pts.length === 1) {
        drawStroke(ctx, { ...preview, points: [pts[0], pts[0]] }, contentRect);
      } else {
        drawStroke(ctx, preview, contentRect);
      }
    }
  }

  function distPointToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function hitTestStrokeNorm(point, stroke, thresholdNorm) {
    const pts = stroke?.points;
    if (!pts || pts.length < 1) return false;
    const th = thresholdNorm || 0.02;
    if (pts.length === 1) {
      return Math.hypot(point.x - pts[0].x, point.y - pts[0].y) <= th;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distPointToSegment(
        point.x,
        point.y,
        pts[i].x,
        pts[i].y,
        pts[i + 1].x,
        pts[i + 1].y
      );
      if (d <= th) return true;
    }
    return false;
  }

  function hitTestTextNorm(point, el) {
    const x = el.x || 0;
    const y = el.y || 0;
    const w = el.w || 0.25;
    const h = el.h || 0.1;
    return point.x >= x && point.x <= x + w && point.y >= y && point.y <= y + h;
  }

  function hitTestElementAtNorm(point, el, thresholdNorm) {
    if (!el || !point) return false;
    if (el.type === "stroke") return hitTestStrokeNorm(point, el, thresholdNorm);
    if (el.type === "text") return hitTestTextNorm(point, el);
    return false;
  }

  function hitTestAnyElementAtNorm(point, elementos, thresholdNorm) {
    const els = elementos || [];
    for (let i = els.length - 1; i >= 0; i--) {
      if (hitTestElementAtNorm(point, els[i], thresholdNorm)) return i;
    }
    return -1;
  }

  /** Convierte grosor UI (px) a lw normalizado respecto a la altura del content rect. */
  function lineWidthToNorm(lineWidthPx, contentRect) {
    const h = contentRect?.h || 720;
    return Math.min(1, Math.max(0.001, lineWidthPx / h));
  }

  global.AnnotationInk = {
    getVideoContentRect,
    getVideoContentRectForOverlay,
    clientToNorm,
    normToCanvas,
    cloneInkState,
    drawInkElementos,
    hitTestStrokeNorm,
    hitTestTextNorm,
    hitTestAnyElementAtNorm,
    lineWidthToNorm,
  };
})(typeof window !== "undefined" ? window : global);
