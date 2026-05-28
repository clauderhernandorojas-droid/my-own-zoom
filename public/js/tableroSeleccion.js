/**
 * Subcapa de selección del tablero (estado local; no viaja por socket).
 *
 * Multiselección con Shift+click y drag-box (marquee). Hit-tests incluyen
 * trazos (`stroke`) además de texto e imagen. El módulo es puro: recibe el
 * array `elementos`, el `ctx` 2D y un callback `getElementBounds` (definido
 * en public/index.html para texto/imagen). Para `stroke`, el AABB se calcula
 * desde sus puntos con el padding del `lineWidth`.
 *
 * Estado expuesto en window.TableroSeleccion; no toca boardState, sockets ni
 * helpers compartidos.
 */
(function (global) {
  /** @type {Set<number>} */
  const selected = new Set();

  /** @type {null | { startX:number, startY:number, x:number, y:number, w:number, h:number, additive:boolean, baseline: number[] }} */
  let marquee = null;

  // ───── Estado ───────────────────────────────────────────────────────────

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

  function addToSelection(idx) {
    if (Number.isInteger(idx) && idx >= 0) selected.add(idx);
  }

  function toggleInSelection(idx) {
    if (!Number.isInteger(idx) || idx < 0) return;
    if (selected.has(idx)) selected.delete(idx);
    else selected.add(idx);
  }

  function setSelection(indices) {
    selected.clear();
    if (!Array.isArray(indices)) return;
    for (const i of indices) if (Number.isInteger(i) && i >= 0) selected.add(i);
  }

  /** Tras un applyBoardState (remoto o local), poda índices fuera de rango. */
  function reconcileAfterStateChange(elementosLength) {
    const len = Number(elementosLength) || 0;
    for (const i of Array.from(selected)) {
      if (i < 0 || i >= len) selected.delete(i);
    }
  }

  // ───── Geometría / utilidades ──────────────────────────────────────────

  function isFiniteWorldPoint(p) {
    return p && Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  function pointInRect(p, r) {
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  function rectsIntersect(a, b) {
    if (!a || !b) return false;
    return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
  }

  function distancePointToSegment(px, py, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const ab2 = abx * abx + aby * aby;
    if (ab2 <= 1e-8) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
    const cx = ax + abx * t;
    const cy = ay + aby * t;
    return Math.hypot(px - cx, py - cy);
  }

  function strokeBoundsAABB(el) {
    if (!el || el.type !== 'stroke' || !Array.isArray(el.points) || el.points.length === 0) return null;
    const hw = (Number(el.lineWidth) || 2) / 2;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of el.points) {
      if (!isFiniteWorldPoint(pt)) continue;
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    if (!Number.isFinite(minX)) return null;
    return {
      x: minX - hw,
      y: minY - hw,
      w: Math.max(1, maxX - minX + hw * 2),
      h: Math.max(1, maxY - minY + hw * 2),
    };
  }

  /** Bounds unificado para overlay/marquee. text/image vía callback; stroke con AABB. */
  function getElementWorldBounds(el, ctx, getElementBounds) {
    if (!el) return null;
    if (el.type === 'stroke') return strokeBoundsAABB(el);
    if (typeof getElementBounds === 'function') return getElementBounds(el, ctx);
    return null;
  }

  function getSelectionBounds(elementos, ctx, getElementBounds) {
    if (!Array.isArray(elementos) || selected.size === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const i of selected) {
      const el = elementos[i];
      const b = getElementWorldBounds(el, ctx, getElementBounds);
      if (!b) continue;
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  // ───── Hit-tests ────────────────────────────────────────────────────────

  function hitTestStrokeAtPoint(el, p, extraRadius = 6) {
    if (!el || el.type !== 'stroke' || !Array.isArray(el.points) || el.points.length === 0) return false;
    const pts = el.points;
    const radius = Math.max(6, (Number(el.lineWidth) || 2) * 0.5 + extraRadius);
    if (pts.length === 1) {
      return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= radius;
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (!isFiniteWorldPoint(a) || !isFiniteWorldPoint(b)) continue;
      if (distancePointToSegment(p.x, p.y, a.x, a.y, b.x, b.y) <= radius) return true;
    }
    return false;
  }

  /**
   * Devuelve el primer elemento (en orden inverso de pintado) sobre el punto.
   * Incluye trazos. Para text/image acepta `includeLocked` (Alt+click).
   * `bounds` se devuelve siempre (AABB para stroke; bounds del callback para text/image).
   */
  function hitTestEditable(p, elementos, ctx, includeLocked, getElementBounds) {
    if (!Array.isArray(elementos)) return null;
    for (let i = elementos.length - 1; i >= 0; i--) {
      const el = elementos[i];
      if (!el) continue;
      if (el.type === 'text' || el.type === 'image') {
        if (el.locked && !includeLocked) continue;
        const b = typeof getElementBounds === 'function' ? getElementBounds(el, ctx) : null;
        if (!b) continue;
        if (pointInRect(p, b)) return { index: i, bounds: b, element: el };
        continue;
      }
      if (el.type === 'stroke') {
        if (el.locked && !includeLocked) continue;
        if (hitTestStrokeAtPoint(el, p)) {
          const b = strokeBoundsAABB(el);
          if (b) return { index: i, bounds: b, element: el };
        }
      }
    }
    return null;
  }

  function hitTestTextElement(p, elementos, ctx, getElementBounds) {
    if (!Array.isArray(elementos)) return null;
    for (let i = elementos.length - 1; i >= 0; i--) {
      const el = elementos[i];
      if (el?.type !== 'text') continue;
      if (el.locked) continue;
      const b = typeof getElementBounds === 'function' ? getElementBounds(el, ctx) : null;
      if (!b) continue;
      if (pointInRect(p, b)) return { index: i, bounds: b, element: el };
    }
    return null;
  }

  function hitTestAnyAtPoint(p, elementos, ctx, getElementBounds) {
    if (!Array.isArray(elementos)) return -1;
    for (let i = elementos.length - 1; i >= 0; i--) {
      const el = elementos[i];
      if (!el) continue;
      if (el.type === 'stroke') {
        if (hitTestStrokeAtPoint(el, p)) return i;
        continue;
      }
      if (el.type === 'text' || el.type === 'image') {
        const b = typeof getElementBounds === 'function' ? getElementBounds(el, ctx) : null;
        if (!b) continue;
        const pad = 6;
        if (pointInRect(p, { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 })) {
          return i;
        }
      }
    }
    return -1;
  }

  // ───── Marquee (drag-box) ───────────────────────────────────────────────

  function startMarquee(p, additive) {
    if (!isFiniteWorldPoint(p)) return;
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
    if (!marquee || !isFiniteWorldPoint(p)) return;
    const x = Math.min(marquee.startX, p.x);
    const y = Math.min(marquee.startY, p.y);
    const w = Math.abs(p.x - marquee.startX);
    const h = Math.abs(p.y - marquee.startY);
    marquee.x = x;
    marquee.y = y;
    marquee.w = w;
    marquee.h = h;
  }

  function getMarqueeRect() {
    if (!marquee) return null;
    return { x: marquee.x, y: marquee.y, w: marquee.w, h: marquee.h };
  }

  /**
   * Cierra el marquee: si tiene tamaño mínimo, selecciona elementos cuyo AABB
   * intersecte el rectángulo. Si fue un "click sin arrastrar" en zona vacía,
   * deselecciona (a menos que sea aditivo).
   * Devuelve la selección final.
   */
  function finishMarquee(elementos, ctx, getElementBounds) {
    if (!marquee) return getSelectedIndices();
    const rect = { x: marquee.x, y: marquee.y, w: marquee.w, h: marquee.h };
    const additive = marquee.additive;
    const baseline = marquee.baseline;
    const meaningful = rect.w >= 3 && rect.h >= 3;
    marquee = null;

    if (!meaningful) {
      if (!additive) selected.clear();
      return getSelectedIndices();
    }

    if (additive) {
      selected.clear();
      for (const i of baseline) selected.add(i);
    } else {
      selected.clear();
    }
    if (Array.isArray(elementos)) {
      for (let i = 0; i < elementos.length; i++) {
        const el = elementos[i];
        if (!el || el.locked) continue;
        const b = getElementWorldBounds(el, ctx, getElementBounds);
        if (!b) continue;
        if (rectsIntersect(rect, b)) selected.add(i);
      }
    }
    return getSelectedIndices();
  }

  function cancelMarquee() {
    marquee = null;
  }

  // ───── Resize (handle-aware, math puro) ────────────────────────────────

  /**
   * Calcula `anchor`, factores de escala `sx,sy` y `newBounds` para un resize
   * desde el handle `handleId` con desplazamiento `dx,dy` (en coordenadas mundo)
   * sobre el bbox original `ob = {x,y,w,h}`. `shiftKey` fuerza escala uniforme
   * en handles de esquina. Devuelve `null` si `ob` es degenerado.
   */
  function getResizeTransform(handleId, ob, dx, dy, shiftKey, minSize = 4) {
    if (!ob || !(ob.w > 0) || !(ob.h > 0)) return null;
    const movesLeft = handleId === 'nw' || handleId === 'w' || handleId === 'sw';
    const movesRight = handleId === 'ne' || handleId === 'e' || handleId === 'se';
    const movesTop = handleId === 'nw' || handleId === 'n' || handleId === 'ne';
    const movesBottom = handleId === 'sw' || handleId === 's' || handleId === 'se';

    const ax = movesLeft ? ob.x + ob.w : (movesRight ? ob.x : ob.x + ob.w / 2);
    const ay = movesTop ? ob.y + ob.h : (movesBottom ? ob.y : ob.y + ob.h / 2);

    let nw = ob.w;
    let nh = ob.h;
    if (movesRight) nw = ob.w + dx;
    else if (movesLeft) nw = ob.w - dx;
    if (movesBottom) nh = ob.h + dy;
    else if (movesTop) nh = ob.h - dy;
    if (!movesLeft && !movesRight) nw = ob.w;
    if (!movesTop && !movesBottom) nh = ob.h;

    nw = Math.max(minSize, nw);
    nh = Math.max(minSize, nh);

    let sx = nw / ob.w;
    let sy = nh / ob.h;

    const corner = (movesLeft || movesRight) && (movesTop || movesBottom);
    if (shiftKey && corner) {
      const s = Math.max(sx, sy);
      sx = s;
      sy = s;
      nw = ob.w * s;
      nh = ob.h * s;
    }

    const nx = movesLeft ? ax - nw : ob.x;
    const ny = movesTop ? ay - nh : ob.y;

    return { anchor: { x: ax, y: ay }, sx, sy, newBounds: { x: nx, y: ny, w: nw, h: nh } };
  }

  function transformPoint(p, anchor, sx, sy) {
    return {
      x: anchor.x + (p.x - anchor.x) * sx,
      y: anchor.y + (p.y - anchor.y) * sy,
    };
  }

  // ───── Export ──────────────────────────────────────────────────────────

  global.TableroSeleccion = {
    getSelectedIndices,
    isSelected,
    selectOne,
    addToSelection,
    toggleInSelection,
    setSelection,
    clearSelection,
    size,
    reconcileAfterStateChange,

    isFiniteWorldPoint,
    pointInRect,
    rectsIntersect,
    hitTestStrokeAtPoint,
    hitTestEditable,
    hitTestTextElement,
    hitTestAnyAtPoint,
    getElementWorldBounds,
    getSelectionBounds,

    startMarquee,
    updateMarquee,
    finishMarquee,
    getMarqueeRect,
    cancelMarquee,

    getResizeTransform,
    transformPoint,
  };
})(typeof window !== 'undefined' ? window : globalThis);
