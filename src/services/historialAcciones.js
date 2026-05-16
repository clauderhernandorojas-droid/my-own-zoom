/**
 * Pila de acciones deshacer/rehacer para operaciones de agenda del calendario.
 * Sin dependencias de asistencia, copresencia ni lógica de negocio de reagendamiento:
 * solo orquesta pilas; el cliente registra callbacks que llaman a la API de reuniones.
 *
 * Cada acción: { type, label, undo: () => Promise, redo: () => Promise }
 * Tipos usados por el cliente: agendar | editar | reagendar | cancelar
 */

const MAX_ACCIONES = 50;

/** @readonly */
const ACCION_TYPES = Object.freeze({
  AGENDAR: 'agendar',
  EDITAR: 'editar',
  REAGENDAR: 'reagendar',
  CANCELAR: 'cancelar',
});

/**
 * @returns {{
 *   push: (action: object) => void,
 *   undo: () => Promise<object|null>,
 *   redo: () => Promise<object|null>,
 *   canUndo: () => boolean,
 *   canRedo: () => boolean,
 *   clear: () => void,
 *   onChange: (fn: (() => void)|null) => void,
 *   getSizes: () => { undo: number, redo: number },
 * }}
 */
function createHistorialAcciones() {
  /** @type {object[]} */
  let undoStack = [];
  /** @type {object[]} */
  let redoStack = [];
  /** @type {(() => void)|null} */
  let changeListener = null;

  function notify() {
    if (typeof changeListener === 'function') changeListener();
  }

  function push(action) {
    if (!action || typeof action.undo !== 'function' || typeof action.redo !== 'function') {
      return;
    }
    undoStack.push(action);
    if (undoStack.length > MAX_ACCIONES) undoStack.shift();
    redoStack = [];
    notify();
  }

  async function undo() {
    if (!undoStack.length) return null;
    const action = undoStack.pop();
    await action.undo();
    redoStack.push(action);
    notify();
    return action;
  }

  async function redo() {
    if (!redoStack.length) return null;
    const action = redoStack.pop();
    await action.redo();
    undoStack.push(action);
    notify();
    return action;
  }

  function canUndo() {
    return undoStack.length > 0;
  }

  function canRedo() {
    return redoStack.length > 0;
  }

  function clear() {
    undoStack = [];
    redoStack = [];
    notify();
  }

  function onChange(fn) {
    changeListener = typeof fn === 'function' ? fn : null;
    notify();
  }

  function getSizes() {
    return { undo: undoStack.length, redo: redoStack.length };
  }

  return {
    push,
    undo,
    redo,
    canUndo,
    canRedo,
    clear,
    onChange,
    getSizes,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createHistorialAcciones, MAX_ACCIONES, ACCION_TYPES };
}

if (typeof window !== 'undefined') {
  window.HistorialAcciones = { createHistorialAcciones, MAX_ACCIONES, ACCION_TYPES };
}
