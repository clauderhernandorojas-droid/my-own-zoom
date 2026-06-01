/**
 * Pila de acciones deshacer/rehacer (cliente).
 * Copia del módulo en src/services/historialAcciones.js para uso en navegador.
 */
(function (global) {
  const MAX_ACCIONES = 50;

  const ACCION_TYPES = Object.freeze({
    AGENDAR: "agendar",
    EDITAR: "editar",
    REAGENDAR: "reagendar",
    CANCELAR: "cancelar",
  });

  function createHistorialAcciones() {
    let undoStack = [];
    let redoStack = [];
    let changeListener = null;

    function notify() {
      if (typeof changeListener === "function") changeListener();
    }

    function push(action) {
      if (!action || typeof action.undo !== "function" || typeof action.redo !== "function") {
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
      changeListener = typeof fn === "function" ? fn : null;
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

  global.HistorialAcciones = { createHistorialAcciones, MAX_ACCIONES, ACCION_TYPES };
})(typeof window !== "undefined" ? window : global);
