/**
 * overlayTransform.js — bounds, handles y resize en coords normalizadas (0–1).
 */
(function (global) {
  const Ink = global.AnnotationInk;
  const TableroSel = global.TableroSeleccion;

  const MIN_NORM = 0.02;

  function handleHalfNorm(contentRect) {
    const h = Math.max(1, contentRect?.h || 400);
    return Math.max(0.012, 10 / h);
  }

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

  function textBoundsNorm(el, contentRect, ctx) {
    if (!el || el.type !== "text") return null;
    const x = el.x || 0;
    const y = el.y || 0;
    const w = el.w || 0.25;
    const h = el.h || 0.1;
    if (ctx && contentRect && Ink?.normToCanvas) {
      const tl = Ink.normToCanvas(x, y, contentRect);
      const fs = Math.max(8, Number(el.fontSize) || 22);
      const scale = contentRect.h / 720;
      const px = Math.round(fs * Math.max(0.5, Math.min(2, scale)));
      ctx.font = `${px}px "Segoe UI", system-ui, sans-serif`;
      const text = String(el.text || "").trim();
      const measured = Math.min(contentRect.w * 0.9, Math.max(w * contentRect.w, ctx.measureText(text || "M").width + 8));
      const nh = Math.max(h * contentRect.h, px * 1.4) / contentRect.h;
      return { x, y, w: measured / contentRect.w, h: nh };
    }
    return { x, y, w, h };
  }

  function getElementNormBounds(el, contentRect, ctx) {
    if (!el) return null;
    if (el.type === "stroke") return strokeBoundsNorm(el, contentRect);
    if (el.type === "text") return textBoundsNorm(el, contentRect, ctx);
    return null;
  }

  function getResizeHandleRects(bounds, element, contentRect) {
    if (!bounds) return [];
    const hh = handleHalfNorm(contentRect);
    const s = hh * 2;
    const x1 = bounds.x;
    const y1 = bounds.y;
    const x2 = bounds.x + bounds.w;
    const y2 = bounds.y + bounds.h;
    const mx = bounds.x + bounds.w / 2;
    const my = bounds.y + bounds.h / 2;
    const isText = element?.type === "text";
    const ids = isText
      ? [
          ["nw", x1, y1],
          ["ne", x2, y1],
          ["se", x2, y2],
          ["sw", x1, y2],
        ]
      : [
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
      x: cx - hh,
      y: cy - hh,
      w: s,
      h: s,
    }));
  }

  function pointInRect(p, r) {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  function hitTestResizeHandle(p, bounds, element, contentRect) {
    if (!bounds) return null;
    const rects = getResizeHandleRects(bounds, element, contentRect);
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

  function getResizeTransform(handleId, ob, dx, dy, shiftKey) {
    return TableroSel?.getResizeTransform
      ? TableroSel.getResizeTransform(handleId, ob, dx, dy, shiftKey, MIN_NORM)
      : null;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ x: number, y: number, w: number, h: number }} scaledCr — coords canvas (× DPR), como drawOverlay
   * @param {{ x: number, y: number, w: number, h: number }} cssContentRect — rect CSS para handles
   */
  function drawSelectionOverlay(ctx, scaledCr, cssContentRect, elementos, selection) {
    if (!ctx || !selection) return;
    const ids = selection.getSelectedIndices();
    const cr = scaledCr;
    const cssCr = cssContentRect || scaledCr;

    const boundsToPx = (b) => ({
      x: cr.x + b.x * cr.w,
      y: cr.y + b.y * cr.h,
      w: b.w * cr.w,
      h: b.h * cr.h,
    });

    if (ids.length > 0) {
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      for (const i of ids) {
        const el = elementos[i];
        const b = getElementNormBounds(el, cssCr, ctx);
        if (!b) continue;
        const px = boundsToPx(b);
        ctx.strokeStyle = "#2563eb";
        ctx.strokeRect(px.x, px.y, px.w, px.h);
      }

      if (ids.length === 1) {
        const el = elementos[ids[0]];
        const b = getElementNormBounds(el, cssCr, ctx);
        if (b && el) {
          const px = boundsToPx(b);
          ctx.setLineDash([]);
          ctx.fillStyle = "#2563eb";
          for (const h of getResizeHandleRects(b, el, cssCr)) {
            const hp = boundsToPx(h);
            ctx.fillRect(hp.x, hp.y, hp.w, hp.h);
          }
        }
      } else {
        const gb = selection.getSelectionBounds(elementos, ctx, cssCr);
        if (gb) {
          const px = boundsToPx(gb);
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = "#1d4ed8";
          ctx.strokeRect(px.x, px.y, px.w, px.h);
          ctx.setLineDash([]);
          ctx.fillStyle = "#1d4ed8";
          for (const h of getResizeHandleRects(gb, null, cssCr)) {
            const hp = boundsToPx(h);
            ctx.fillRect(hp.x, hp.y, hp.w, hp.h);
          }
        }
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    const m = selection.getMarqueeRect();
    if (m && (m.w > 0.002 || m.h > 0.002)) {
      const px = boundsToPx(m);
      ctx.save();
      ctx.fillStyle = "rgba(37, 99, 235, 0.10)";
      ctx.fillRect(px.x, px.y, px.w, px.h);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(px.x, px.y, px.w, px.h);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  global.OverlayTransform = {
    getElementNormBounds,
    getResizeHandleRects,
    hitTestResizeHandle,
    applyResizeTransform,
    applyTextBoxResize,
    getResizeTransform,
    drawSelectionOverlay,
    pointInRect,
    MIN_NORM,
  };
})(typeof window !== "undefined" ? window : global);
