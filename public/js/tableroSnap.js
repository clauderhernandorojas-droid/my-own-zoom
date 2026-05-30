/**
 * tableroSnap.js — alineación y snap durante arrastre en el tablero.
 *
 * Módulo puro: coordenadas mundo, sin DOM ni socket.
 * Umbral en píxeles de pantalla → mundo con getThresholdWorld(zoom).
 */
(function (global) {
  let thresholdPx = 8;

  const X_PAIRS = [
    ['left', 'left'],
    ['left', 'right'],
    ['left', 'cx'],
    ['right', 'left'],
    ['right', 'right'],
    ['right', 'cx'],
    ['cx', 'left'],
    ['cx', 'cx'],
    ['cx', 'right'],
  ];

  const Y_PAIRS = [
    ['top', 'top'],
    ['top', 'bottom'],
    ['top', 'cy'],
    ['bottom', 'top'],
    ['bottom', 'bottom'],
    ['bottom', 'cy'],
    ['cy', 'top'],
    ['cy', 'cy'],
    ['cy', 'bottom'],
  ];

  function configure(opts) {
    if (opts && Number.isFinite(opts.thresholdPx)) {
      thresholdPx = Math.max(1, Math.min(50, opts.thresholdPx));
    }
  }

  function getThresholdPx() {
    return thresholdPx;
  }

  /** Convierte umbral de pantalla a unidades mundo según zoom del tablero. */
  function getThresholdWorld(zoom) {
    const z = Number(zoom);
    if (!Number.isFinite(z) || z <= 0) return thresholdPx;
    return thresholdPx / z;
  }

  function rectEdges(r) {
    return {
      left: r.x,
      right: r.x + r.w,
      top: r.y,
      bottom: r.y + r.h,
      cx: r.x + r.w / 2,
      cy: r.y + r.h / 2,
    };
  }

  function isValidRect(r) {
    return (
      r &&
      Number.isFinite(r.x) &&
      Number.isFinite(r.y) &&
      Number.isFinite(r.w) &&
      Number.isFinite(r.h) &&
      r.w > 0 &&
      r.h > 0
    );
  }

  /**
   * @param {{ movingRect: {x,y,w,h}, candidates: {rect:{x,y,w,h}}[], thresholdWorld: number }} opts
   * @returns {{ dxAdjust: number, dyAdjust: number, guides: { vertical: number[], horizontal: number[] } }}
   */
  function snapTranslation(opts) {
    const movingRect = opts?.movingRect;
    const candidates = opts?.candidates || [];
    const thr = Number(opts?.thresholdWorld);
    const empty = {
      dxAdjust: 0,
      dyAdjust: 0,
      guides: { vertical: [], horizontal: [] },
    };
    if (!isValidRect(movingRect) || !Number.isFinite(thr) || thr <= 0) return empty;

    const mov = rectEdges(movingRect);
    let bestDx = null;
    let bestDy = null;
    const guideX = new Set();
    const guideY = new Set();

    for (const cand of candidates) {
      const rect = cand?.rect;
      if (!isValidRect(rect)) continue;
      const oth = rectEdges(rect);

      for (const [mk, tk] of X_PAIRS) {
        const delta = oth[tk] - mov[mk];
        if (Math.abs(delta) > thr) continue;
        if (bestDx === null || Math.abs(delta) < Math.abs(bestDx)) {
          bestDx = delta;
          guideX.clear();
          guideX.add(oth[tk]);
        } else if (bestDx !== null && Math.abs(delta - bestDx) < 1e-6) {
          guideX.add(oth[tk]);
        }
      }

      for (const [mk, tk] of Y_PAIRS) {
        const delta = oth[tk] - mov[mk];
        if (Math.abs(delta) > thr) continue;
        if (bestDy === null || Math.abs(delta) < Math.abs(bestDy)) {
          bestDy = delta;
          guideY.clear();
          guideY.add(oth[tk]);
        } else if (bestDy !== null && Math.abs(delta - bestDy) < 1e-6) {
          guideY.add(oth[tk]);
        }
      }
    }

    return {
      dxAdjust: bestDx ?? 0,
      dyAdjust: bestDy ?? 0,
      guides: {
        vertical: Array.from(guideX),
        horizontal: Array.from(guideY),
      },
    };
  }

  global.TableroSnap = {
    configure,
    getThresholdPx,
    getThresholdWorld,
    snapTranslation,
  };
})(typeof window !== 'undefined' ? window : globalThis);
