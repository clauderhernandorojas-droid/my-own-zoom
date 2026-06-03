/**

 * overlaySeleccion.js — selección local en coords normalizadas (overlay pantalla compartida).

 */

(function (global) {

  const Transform = global.OverlayTransform;

  const Ink = global.AnnotationInk;



  const TEXT_HIT_PAD = 0.015;



  const selected = new Set();

  let marquee = null;



  function getSelectedIndices() {

    return Array.from(selected).sort((a, b) => a - b);

  }



  function isSelected(idx) {

    return selected.has(idx);

  }



  function size() {

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



  function getElementBounds(el, ctx, contentRect) {

    return Transform?.getElementNormBounds(el, contentRect, ctx) || null;

  }



  function getSelectionBounds(elementos, ctx, contentRect) {

    if (!selected.size) return null;

    let minX = Infinity;

    let minY = Infinity;

    let maxX = -Infinity;

    let maxY = -Infinity;

    for (const i of selected) {

      const b = getElementBounds(elementos[i], ctx, contentRect);

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

    const b = getElementBounds(el, ctx, contentRect);

    if (!b || !Transform?.pointInRect) return false;

    const pad = Math.max(thresholdNorm || 0.04, (el.lw || 0.008) * 1.5);

    const box = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };

    if (!Transform.pointInRect(p, box)) return false;

    return Ink?.hitTestStrokeNorm

      ? Ink.hitTestStrokeNorm(p, el, Math.max(pad, thresholdNorm || 0.04))

      : true;

  }



  function hitTestTextForPointer(p, el) {

    const x = (el.x || 0) - TEXT_HIT_PAD;

    const y = (el.y || 0) - TEXT_HIT_PAD;

    const w = (el.w || 0.25) + TEXT_HIT_PAD * 2;

    const h = (el.h || 0.1) + TEXT_HIT_PAD * 2;

    return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;

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

        hit = hitTestTextForPointer(p, el);

      }

      if (hit) {

        const bounds = getElementBounds(el, ctx, contentRect);

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

      const b = getElementBounds(elementos[i], ctx, contentRect);

      if (!b) continue;

      const intersects =

        !(rect.x + rect.w < b.x || rect.x > b.x + b.w || rect.y + rect.h < b.y || rect.y > b.y + b.h);

      if (intersects) selected.add(i);

    }

    return getSelectedIndices();

  }



  function cancelMarquee() {

    marquee = null;

  }



  global.OverlaySeleccion = {

    getSelectedIndices,

    isSelected,

    size,

    clearSelection,

    selectOne,

    toggleInSelection,

    reconcileAfterStateChange,

    getElementBounds,

    getSelectionBounds,

    hitTestEditable,

    startMarquee,

    updateMarquee,

    finishMarquee,

    getMarqueeRect,

    cancelMarquee,

  };

})(typeof window !== "undefined" ? window : global);


