/**

 * annotationUI.js — render de handlers, bounding boxes visuales y editor de texto inline.

 */

(function (global) {

  const Core = global.AnnotationCore;



  const HANDLE_VISUAL_PX = 4;

  const HANDLE_HIT_PX = 14;



  function boundsToPx(b, cr) {

    return {

      x: cr.x + b.x * cr.w,

      y: cr.y + b.y * cr.h,

      w: b.w * cr.w,

      h: b.h * cr.h,

    };

  }



  function drawSquareHandle(ctx, handleNorm, scaledCr, cssCr, sizePx) {

    const hp = boundsToPx(handleNorm, scaledCr);

    const dpr = cssCr?.w > 0 ? scaledCr.w / cssCr.w : 1;

    const side = Math.max(2, sizePx * dpr);

    const cx = hp.x + hp.w / 2;

    const cy = hp.y + hp.h / 2;

    ctx.fillRect(cx - side / 2, cy - side / 2, side, side);

  }



  function drawSelectionOverlay(ctx, scaledCr, cssContentRect, elementos, selection) {

    if (!ctx || !selection || !Core) return;

    const ids = selection.getSelectedIndices();

    const cr = scaledCr;

    const cssCr = cssContentRect || scaledCr;



    if (ids.length > 0) {

      ctx.save();

      ctx.lineWidth = 1.5;

      ctx.setLineDash([5, 4]);

      for (const i of ids) {

        const el = elementos[i];

        const b = Core.getElementNormBounds(el, cssCr, ctx);

        if (!b) continue;

        const px = boundsToPx(b, cr);

        ctx.strokeStyle = "#2563eb";

        ctx.strokeRect(px.x, px.y, px.w, px.h);

      }



      if (ids.length === 1) {

        const el = elementos[ids[0]];

        const b = Core.getElementNormBounds(el, cssCr, ctx);

        if (b && el) {

          const px = boundsToPx(b, cr);

          ctx.setLineDash([]);

          ctx.fillStyle = "#2563eb";

          for (const h of Core.getResizeHandleRects(b, el, cssCr, HANDLE_VISUAL_PX)) {

            drawSquareHandle(ctx, h, cr, cssCr, HANDLE_VISUAL_PX);

          }

        }

      } else {

        const gb = selection.getSelectionBounds(elementos, ctx, cssCr);

        if (gb) {

          const px = boundsToPx(gb, cr);

          ctx.setLineDash([2, 3]);

          ctx.strokeStyle = "#1d4ed8";

          ctx.strokeRect(px.x, px.y, px.w, px.h);

          ctx.setLineDash([]);

          ctx.fillStyle = "#1d4ed8";

          for (const h of Core.getResizeHandleRects(gb, null, cssCr, HANDLE_VISUAL_PX)) {

            drawSquareHandle(ctx, h, cr, cssCr, HANDLE_VISUAL_PX);

          }

        }

      }

      ctx.setLineDash([]);

      ctx.restore();

    }



    const m = selection.getMarqueeRect();

    if (m && (m.w > 0.002 || m.h > 0.002)) {

      const px = boundsToPx(m, cr);

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



  function hitTestResizeHandle(p, bounds, element, contentRect) {

    return Core?.hitTestResizeHandle(p, bounds, element, contentRect, HANDLE_HIT_PX) || null;

  }



  /**

   * Editor montado en stackEl (mismo origen que canvas) para alinear coords con drawText.

   * @returns {{ input: HTMLTextAreaElement, updateLayout: function, close: function }}

   */

  function createInlineTextEditor(opts) {

    const {

      hostEl,

      stackEl,

      contentRect,

      normPoint,

      color,

      fontSize,

      initialText,

      onCommit,

      onCancel,

    } = opts;



    const input = document.createElement("textarea");

    input.className = "screen-overlay-text-input";

    input.style.color = color || "#111111";

    if (initialText) input.value = String(initialText);



    const measureCanvas = document.createElement("canvas");

    const ctx = measureCanvas.getContext("2d");

    const chromeX = Core.TEXT_EDITOR_CHROME_X ?? 8;

    const chromeY = Core.TEXT_EDITOR_CHROME_Y ?? 8;



    const elStub = {

      type: "text",

      text: "",

      x: normPoint.x,

      y: normPoint.y,

      w: 0.25,

      h: 0.1,

      fontSize: fontSize || 24,

    };



    function measureCommittedBounds(text) {

      elStub.text = text || " ";

      elStub.fontSize = fontSize || 24;

      return Core.measureTextContentNorm(elStub, contentRect, ctx);

    }



    function syncDataset(bounds) {

      input.dataset.normX = String(normPoint.x);

      input.dataset.normY = String(normPoint.y);

      input.dataset.normW = String(bounds?.w ?? 0.25);

      input.dataset.normH = String(bounds?.h ?? 0.1);

    }



    function updateLayout() {

      elStub.text = input.value || " ";

      elStub.fontSize = fontSize || 24;

      const fs = Core.textFontSizePx(elStub, contentRect);

      input.style.fontSize = `${fs}px`;

      input.style.lineHeight = "1.25";



      const bounds = measureCommittedBounds(input.value || " ");

      const local = Core.boundsNormToStackLocalPx(bounds, contentRect);

      const tl = Core.normToStackLocalPx(normPoint.x, normPoint.y, contentRect);



      input.style.left = `${tl.x}px`;

      input.style.top = `${tl.y}px`;

      input.style.width = `${Math.max(48, local.width + chromeX)}px`;

      input.style.height = `${Math.max(20, local.height + chromeY)}px`;

      syncDataset(bounds);

    }



    updateLayout();

    hostEl.appendChild(input);



    input.addEventListener("input", updateLayout);



    let resizeObserver = null;

    if (stackEl && typeof ResizeObserver !== "undefined") {

      resizeObserver = new ResizeObserver(() => updateLayout());

      resizeObserver.observe(stackEl);

    }



    function close(commit) {

      input.removeEventListener("input", updateLayout);

      resizeObserver?.disconnect?.();

      const text = String(input.value || "").trim();

      const bounds = text ? measureCommittedBounds(text) : null;

      const nx = Number(input.dataset.normX);

      const ny = Number(input.dataset.normY);

      input.remove();

      if (commit && text && bounds) {

        onCommit?.({

          text,

          x: nx,

          y: ny,

          w: bounds.w,

          h: bounds.h,

          fontSize: fontSize || 24,

          color,

        });

      } else {

        onCancel?.();

      }

    }



    input.addEventListener("keydown", (ev) => {

      if (ev.key === "Escape") {

        ev.preventDefault();

        close(false);

      } else if (ev.key === "Enter" && !ev.shiftKey) {

        ev.preventDefault();

        close(true);

      }

    });

    input.addEventListener("blur", () => close(true));



    return {

      input,

      updateLayout,

      close,

    };

  }



  global.AnnotationUI = {

    HANDLE_VISUAL_PX,

    HANDLE_HIT_PX,

    drawSelectionOverlay,

    hitTestResizeHandle,

    createInlineTextEditor,

  };

})(typeof window !== "undefined" ? window : global);


