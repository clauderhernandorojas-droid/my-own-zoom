/**
 * annotationCore.js — trazos, texto, emojis, selección, bounds y transformaciones (coords 0–1).
 * Sin DOM ni socket; consumido por annotationUI, annotationSync y screenOverlay.
 */
(function (global) {
  const TableroSel = global.TableroSeleccion;

  const MIN_NORM = 0.02;
  const TEXT_HIT_PAD_NORM = 0.003;
  const TEXT_LINE_HEIGHT_FACTOR = 1.25;
  const TEXT_CHROME_PAD_PX = 2;
  /** Borde+padding del textarea inline (box-sizing: border-box), alineado con screenOverlay.css */
  const TEXT_EDITOR_CHROME_X = 8;
  const TEXT_EDITOR_CHROME_Y = 8;

  const selected = new Set();
  let marquee = null;

  // ── Geometría / coords ───────────────────────────────────────────────────

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

  function lineWidthToNorm(lineWidthPx, contentRect) {
    const h = contentRect?.h || 720;
    return Math.min(1, Math.max(0.001, lineWidthPx / h));
  }

  function textFontSizePx(el, contentRect) {
    const fontSize = Math.max(8, Math.min(160, Number(el.fontSize) || 22));
    const scale = (contentRect?.h || 720) / 720;
    return Math.round(fontSize * Math.max(0.5, Math.min(2, scale)));
  }

  function measureTextLineWidth(ctx, line) {
    const m = ctx.measureText(line);
    let w = m.width;
    if (m.actualBoundingBoxLeft !== undefined && m.actualBoundingBoxRight !== undefined) {
      const span = m.actualBoundingBoxRight - Math.min(0, m.actualBoundingBoxLeft);
      w = Math.max(w, span);
    }
    return w;
  }

  function measureLineHeightPx(ctx, line, fallbackPx) {
    const m = ctx.measureText(line || "M");
    if (
      m.actualBoundingBoxAscent !== undefined &&
      m.actualBoundingBoxDescent !== undefined
    ) {
      return m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    }
    return fallbackPx * 1.25;
  }

  /** Posición en px locales del stack (mismo origen que el canvas). */
  function normToStackLocalPx(nx, ny, contentRect) {
    return normToCanvas(nx, ny, contentRect);
  }

  /** Convierte bbox norm a px locales del stack. */
  function boundsNormToStackLocalPx(bounds, contentRect) {
    if (!bounds) return { left: 0, top: 0, width: 48, height: 24 };
    const tl = normToCanvas(bounds.x, bounds.y, contentRect);
    return {
      left: tl.x,
      top: tl.y,
      width: Math.max(24, bounds.w * contentRect.w),
      height: Math.max(16, bounds.h * contentRect.h),
    };
  }

  function wrapTextLines(ctx, text, maxWidthPx) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = "";
    for (let i = 0; i < words.length; i++) {
      const test = line ? `${line} ${words[i]}` : words[i];
      if (ctx.measureText(test).width > maxWidthPx && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  function isEmojiElement(el) {
    if (!el || el.type !== "text") return false;
    const t = String(el.text || "").trim();
    if (!t || t.length > 8) return false;
    try {
      return /\p{Extended_Pictographic}/u.test(t);
    } catch (_) {
      return t.length <= 2;
    }
  }

  function chromeBoundsFromTextPx(textOrigin, textWPx, textHPx, contentRect, padPx) {
    const padNormX = padPx / contentRect.w;
    const padNormY = padPx / contentRect.h;
    return {
      x: textOrigin.x - padNormX,
      y: textOrigin.y - padNormY,
      w: Math.max(MIN_NORM, (textWPx + padPx * 2) / contentRect.w),
      h: Math.max(MIN_NORM, (textHPx + padPx * 2) / contentRect.h),
    };
  }

  function measureTextLayoutNorm(el, contentRect, ctx) {
    if (!el || el.type !== "text") return null;
    const textOrigin = { x: el.x || 0, y: el.y || 0 };
    const text = String(el.text || "").trim();
    const padPx = TEXT_CHROME_PAD_PX;

    if (!ctx || !contentRect?.w || !contentRect?.h) {
      const textSize = { w: el.w || MIN_NORM, h: el.h || MIN_NORM };
      return {
        textOrigin,
        textSize,
        chromeBounds: { x: textOrigin.x, y: textOrigin.y, w: textSize.w, h: textSize.h },
      };
    }

    const px = textFontSizePx(el, contentRect);
    const lineHeightPx = px * TEXT_LINE_HEIGHT_FACTOR;
    ctx.font = `${px}px "Segoe UI", system-ui, sans-serif`;

    if (!text) {
      const textWPx = measureTextLineWidth(ctx, " ");
      const textHPx = lineHeightPx;
      const textSize = {
        w: Math.max(MIN_NORM, textWPx / contentRect.w),
        h: Math.max(MIN_NORM, textHPx / contentRect.h),
      };
      return {
        textOrigin,
        textSize,
        chromeBounds: chromeBoundsFromTextPx(textOrigin, textWPx, textHPx, contentRect, padPx),
      };
    }

    if (isEmojiElement(el)) {
      const wPx = measureTextLineWidth(ctx, text);
      const hPx = measureLineHeightPx(ctx, text, px);
      const side = Math.max(wPx, hPx);
      const textSize = {
        w: Math.max(MIN_NORM, side / contentRect.w),
        h: Math.max(MIN_NORM, side / contentRect.h),
      };
      return {
        textOrigin,
        textSize,
        chromeBounds: chromeBoundsFromTextPx(textOrigin, side, side, contentRect, padPx),
      };
    }

    const maxWidthPx = Math.max(48, (el.w || 0.25) * contentRect.w);
    const rawLines = text.split("\n");
    const lines = [];
    for (const raw of rawLines) {
      const wrapped = wrapTextLines(ctx, raw.trim() || " ", maxWidthPx - padPx * 2);
      lines.push(...wrapped);
    }
    if (!lines.length) lines.push(" ");

    let maxW = 0;
    for (const ln of lines) {
      maxW = Math.max(maxW, measureTextLineWidth(ctx, ln || " "));
    }
    const textWPx = maxW;
    const textHPx = lines.length * lineHeightPx;
    const textSize = {
      w: Math.max(MIN_NORM, textWPx / contentRect.w),
      h: Math.max(MIN_NORM, textHPx / contentRect.h),
    };

    return {
      textOrigin,
      textSize,
      chromeBounds: chromeBoundsFromTextPx(textOrigin, textWPx, textHPx, contentRect, padPx),
    };
  }

  function measureEmptyTextLineNorm(el, contentRect, ctx) {
    const layout = measureTextLayoutNorm({ ...el, text: "" }, contentRect, ctx);
    if (!layout) return { x: el.x || 0, y: el.y || 0, w: MIN_NORM, h: MIN_NORM };
    return layout.chromeBounds;
  }

  function measureTextContentNorm(el, contentRect, ctx) {
    const layout = measureTextLayoutNorm(el, contentRect, ctx);
    if (!layout) return null;
    return layout.chromeBounds;
  }

  // ── Dibujo ───────────────────────────────────────────────────────────────

  function strokeLineWidthPx(el, contentRect) {
    const lw =
      typeof el.lw === "number"
        ? el.lw
        : typeof el.linewidthNorm === "number"
          ? el.linewidthNorm
          : 0.008;
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
    const fs = textFontSizePx(el, contentRect);
    ctx.fillStyle = el.color || "#111111";
    ctx.font = `${fs}px "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    wrapText(ctx, text, tl.x, tl.y, w, fs * TEXT_LINE_HEIGHT_FACTOR);
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const rawLines = text.split("\n");
    let cy = y;
    for (const raw of rawLines) {
      const words = raw.split(/\s+/);
      let line = "";
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
      if (line) {
        ctx.fillText(line, x, cy);
        cy += lineHeight;
      }
    }
  }

  function drawInkElementos(ctx, elementos, contentRect, opts = {}) {
    const els = elementos || [];
    const skipSet = new Set(Array.isArray(opts.skipTextIndices) ? opts.skipTextIndices : []);
    for (let idx = 0; idx < els.length; idx++) {
      const el = els[idx];
      if (el.type === "stroke") drawStroke(ctx, el, contentRect);
      else if (el.type === "text") {
        if (skipSet.has(idx)) continue;
        drawText(ctx, el, contentRect);
      }
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

  // ── Bounds / transform ───────────────────────────────────────────────────

  function strokeBoundsNorm(el, contentRect) {
    if (!el || el.type !== "stroke" || !el.points?.length) return null;
    const pad = typeof el.lw === "number" ? el.lw * 0.5 : 0.008;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of el.points) {
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
    if (!Number.isFinite(minX)) return null;
    return {
      x: minX - pad,
      y: minY - pad,
      w: Math.max(MIN_NORM, maxX - minX + pad * 2),
      h: Math.max(MIN_NORM, maxY - minY + pad * 2),
    };
  }

  function getElementNormBounds(el, contentRect, ctx) {
    if (!el) return null;
    if (el.type === "stroke") return strokeBoundsNorm(el, contentRect);
    if (el.type === "text") return measureTextContentNorm(el, contentRect, ctx);
    return null;
  }

  function pointInRect(p, r) {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  function handleHalfNorm(contentRect, hitPx) {
    const w = Math.max(1, contentRect?.w || 400);
    const h = Math.max(1, contentRect?.h || 400);
    const halfPx = hitPx / 2;
    return {
      hx: Math.max(0.004, halfPx / w),
      hy: Math.max(0.004, halfPx / h),
    };
  }

  function getResizeHandleRects(bounds, element, contentRect, hitPx) {
    if (!bounds) return [];
    const { hx, hy } = handleHalfNorm(contentRect, hitPx);
    const sx = hx * 2;
    const sy = hy * 2;
    const x1 = bounds.x;
    const y1 = bounds.y;
    const x2 = bounds.x + bounds.w;
    const y2 = bounds.y + bounds.h;
    const mx = bounds.x + bounds.w / 2;
    const my = bounds.y + bounds.h / 2;
    const ids = [
      ["nw", x1, y1],
      ["n", mx, y1],
      ["ne", x2, y1],
      ["e", x2, my],
      ["se", x2, y2],
      ["s", mx, y2],
      ["sw", x1, y2],
      ["w", x1, my],
    ];
    return ids.map(([id, cx, cy]) => ({
      id,
      x: cx - hx,
      y: cy - hy,
      w: sx,
      h: sy,
    }));
  }

  function hitTestResizeHandle(p, bounds, element, contentRect, hitPx) {
    if (!bounds) return null;
    const rects = getResizeHandleRects(bounds, element, contentRect, hitPx);
    for (let i = rects.length - 1; i >= 0; i--) {
      if (pointInRect(p, rects[i])) return rects[i].id;
    }
    return null;
  }

  function applyResizeTransform(el, anchor, sx, sy) {
    if (!el) return el;
    if (el.type === "stroke" && Array.isArray(el.points)) {
      const points = el.points.map((p) => ({
        x: anchor.x + (p.x - anchor.x) * sx,
        y: anchor.y + (p.y - anchor.y) * sy,
      }));
      const lineScale = Math.max(0.1, (Math.abs(sx) + Math.abs(sy)) / 2);
      const baseLw = typeof el.lw === "number" ? el.lw : 0.008;
      return { ...el, points, lw: Math.max(0.001, baseLw * lineScale) };
    }
    if (el.type === "text") {
      const ox = el.x || 0;
      const oy = el.y || 0;
      const ow = el.w || 0.25;
      const oh = el.h || 0.1;
      const t = {
        x: anchor.x + (ox - anchor.x) * sx,
        y: anchor.y + (oy - anchor.y) * sy,
      };
      const fontScale = Math.max(0.1, (Math.abs(sx) + Math.abs(sy)) / 2);
      return {
        ...el,
        x: t.x,
        y: t.y,
        w: Math.max(MIN_NORM, ow * Math.abs(sx)),
        h: Math.max(MIN_NORM, oh * Math.abs(sy)),
        fontSize: Math.max(8, Math.round((Number(el.fontSize) || 22) * fontScale)),
      };
    }
    return el;
  }

  function applyTextBoxResize(handleId, orig, ob, dx, dy) {
    let x = ob.x;
    let y = ob.y;
    let w = ob.w;
    let h = ob.h;
    const movesLeft = handleId === "nw" || handleId === "w" || handleId === "sw";
    const movesRight = handleId === "ne" || handleId === "e" || handleId === "se";
    const movesTop = handleId === "nw" || handleId === "n" || handleId === "ne";
    const movesBottom = handleId === "sw" || handleId === "s" || handleId === "se";
    if (movesRight) w = ob.w + dx;
    if (movesLeft) {
      x = ob.x + dx;
      w = ob.w - dx;
    }
    if (movesBottom) h = ob.h + dy;
    if (movesTop) {
      y = ob.y + dy;
      h = ob.h - dy;
    }
    w = Math.max(MIN_NORM, w);
    h = Math.max(MIN_NORM, h);
    return { ...orig, x, y, w, h };
  }

  function applyDragTransform(orig, dx, dy) {
    if (!orig) return orig;
    if (orig.type === "stroke" && orig.points) {
      return {
        ...orig,
        points: orig.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
      };
    }
    if (orig.type === "text") {
      return {
        ...orig,
        x: (orig.x || 0) + dx,
        y: (orig.y || 0) + dy,
      };
    }
    return orig;
  }

  function getResizeTransform(handleId, ob, dx, dy, shiftKey) {
    return TableroSel?.getResizeTransform
      ? TableroSel.getResizeTransform(handleId, ob, dx, dy, shiftKey, MIN_NORM)
      : null;
  }

  function shouldUseUniformTextResize(el) {
    return el?.type === "text";
  }

  // ── Hit-test ─────────────────────────────────────────────────────────────

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

  function hitTestTextNorm(point, el, contentRect, ctx) {
    const b = measureTextContentNorm(el, contentRect, ctx);
    if (!b) return false;
    const pad = TEXT_HIT_PAD_NORM;
    return (
      point.x >= b.x - pad &&
      point.x <= b.x + b.w + pad &&
      point.y >= b.y - pad &&
      point.y <= b.y + b.h + pad
    );
  }

  function hitTestElementAtNorm(point, el, contentRect, ctx, thresholdNorm) {
    if (!el || !point) return false;
    if (el.type === "stroke") return hitTestStrokeNorm(point, el, thresholdNorm);
    if (el.type === "text") return hitTestTextNorm(point, el, contentRect, ctx);
    return false;
  }

  function hitTestAnyElementAtNorm(point, elementos, contentRect, ctx, thresholdNorm) {
    const els = elementos || [];
    for (let i = els.length - 1; i >= 0; i--) {
      if (hitTestElementAtNorm(point, els[i], contentRect, ctx, thresholdNorm)) return i;
    }
    return -1;
  }

  // ── Selección ────────────────────────────────────────────────────────────

  function getSelectedIndices() {
    return Array.from(selected).sort((a, b) => a - b);
  }

  function isSelected(idx) {
    return selected.has(idx);
  }

  function selectionSize() {
    return selected.size;
  }

  function clearSelection() {
    selected.clear();
  }

  function selectOne(idx) {
    selected.clear();
    if (Number.isInteger(idx) && idx >= 0) selected.add(idx);
  }

  function toggleInSelection(idx) {
    if (!Number.isInteger(idx) || idx < 0) return;
    if (selected.has(idx)) selected.delete(idx);
    else selected.add(idx);
  }

  function reconcileAfterStateChange(len) {
    const n = Number(len) || 0;
    for (const i of Array.from(selected)) {
      if (i < 0 || i >= n) selected.delete(i);
    }
  }

  function isFiniteNorm(p) {
    return p && Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  function getSelectionBounds(elementos, ctx, contentRect) {
    if (!selected.size) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const i of selected) {
      const b = getElementNormBounds(elementos[i], contentRect, ctx);
      if (!b) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function hitTestStrokeForPointer(p, el, ctx, contentRect, thresholdNorm) {
    const b = getElementNormBounds(el, contentRect, ctx);
    if (!b || !pointInRect) return false;
    const pad = Math.max(thresholdNorm || 0.04, (el.lw || 0.008) * 1.5);
    const box = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
    if (!pointInRect(p, box)) return false;
    return hitTestStrokeNorm(p, el, Math.max(pad, thresholdNorm || 0.04));
  }

  function hitTestEditable(p, elementos, ctx, contentRect, thresholdNorm) {
    if (!Array.isArray(elementos) || !isFiniteNorm(p)) return null;
    const th = thresholdNorm || 0.05;
    for (let i = elementos.length - 1; i >= 0; i--) {
      const el = elementos[i];
      if (!el) continue;
      let hit = false;
      if (el.type === "stroke") {
        hit = hitTestStrokeForPointer(p, el, ctx, contentRect, th);
      } else if (el.type === "text") {
        hit = hitTestTextNorm(p, el, contentRect, ctx);
      }
      if (hit) {
        const bounds = getElementNormBounds(el, contentRect, ctx);
        return { index: i, element: el, bounds };
      }
    }
    return null;
  }

  function startMarquee(p, additive) {
    if (!isFiniteNorm(p)) return;
    marquee = {
      startX: p.x,
      startY: p.y,
      x: p.x,
      y: p.y,
      w: 0,
      h: 0,
      additive: !!additive,
      baseline: additive ? getSelectedIndices() : [],
    };
    if (!additive) selected.clear();
  }

  function updateMarquee(p) {
    if (!marquee || !isFiniteNorm(p)) return;
    marquee.x = Math.min(marquee.startX, p.x);
    marquee.y = Math.min(marquee.startY, p.y);
    marquee.w = Math.abs(p.x - marquee.startX);
    marquee.h = Math.abs(p.y - marquee.startY);
  }

  function getMarqueeRect() {
    return marquee ? { x: marquee.x, y: marquee.y, w: marquee.w, h: marquee.h } : null;
  }

  function finishMarquee(elementos, ctx, contentRect) {
    if (!marquee) return getSelectedIndices();
    const rect = { x: marquee.x, y: marquee.y, w: marquee.w, h: marquee.h };
    const additive = marquee.additive;
    const baseline = marquee.baseline;
    const meaningful = rect.w >= 0.01 && rect.h >= 0.01;
    marquee = null;

    if (!meaningful) {
      if (!additive) selected.clear();
      return getSelectedIndices();
    }

    if (additive) {
      selected.clear();
      for (const i of baseline) selected.add(i);
    }

    for (let i = 0; i < (elementos?.length || 0); i++) {
      const b = getElementNormBounds(elementos[i], contentRect, ctx);
      if (!b) continue;
      const intersects = !(
        rect.x + rect.w < b.x ||
        rect.x > b.x + b.w ||
        rect.y + rect.h < b.y ||
        rect.y > b.y + b.h
      );
      if (intersects) selected.add(i);
    }
    return getSelectedIndices();
  }

  function cancelMarquee() {
    marquee = null;
  }

  const selectionApi = {
    getSelectedIndices,
    isSelected,
    size: selectionSize,
    clearSelection,
    selectOne,
    toggleInSelection,
    reconcileAfterStateChange,
    getElementBounds: getElementNormBounds,
    getSelectionBounds,
    hitTestEditable,
    startMarquee,
    updateMarquee,
    finishMarquee,
    getMarqueeRect,
    cancelMarquee,
  };

  global.AnnotationCore = {
    MIN_NORM,
    TEXT_HIT_PAD_NORM,
    TEXT_LINE_HEIGHT_FACTOR,
    TEXT_CHROME_PAD_PX,
    TEXT_EDITOR_CHROME_X,
    TEXT_EDITOR_CHROME_Y,
    getVideoContentRect,
    getVideoContentRectForOverlay,
    clientToNorm,
    normToCanvas,
    normToStackLocalPx,
    boundsNormToStackLocalPx,
    cloneInkState,
    lineWidthToNorm,
    textFontSizePx,
    measureTextLineWidth,
    measureEmptyTextLineNorm,
    measureTextLayoutNorm,
    measureTextContentNorm,
    isEmojiElement,
    drawInkElementos,
    getElementNormBounds,
    getResizeHandleRects,
    hitTestResizeHandle,
    applyResizeTransform,
    applyTextBoxResize,
    applyDragTransform,
    getResizeTransform,
    shouldUseUniformTextResize,
    pointInRect,
    hitTestStrokeNorm,
    hitTestTextNorm,
    hitTestAnyElementAtNorm,
    selection: selectionApi,
  };
})(typeof window !== "undefined" ? window : global);
