/**
 * AppState — store central de sala (getState, dispatch, subscribe).
 */
(function (global) {
  const { initialState, roomReducer, freezeState } = global.MojRoomReducer || {};

  function shallowEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (a[k] !== b[k]) return false;
    }
    return true;
  }

  function createStore() {
    let state = freezeState(initialState());
    const listeners = new Set();
    const sliceListeners = [];

    function getState() {
      return state;
    }

    function select(selector) {
      return selector(state);
    }

    function subscribe(selector, listener) {
      if (typeof selector === "function" && typeof listener === "function") {
        let prev = selector(state);
        const entry = { selector, listener, prev };
        sliceListeners.push(entry);
        return () => {
          const i = sliceListeners.indexOf(entry);
          if (i >= 0) sliceListeners.splice(i, 1);
        };
      }
      if (typeof selector === "function") {
        listeners.add(selector);
        return () => listeners.delete(selector);
      }
      return () => {};
    }

    function dispatch(action) {
      const next = freezeState(roomReducer(state, action));
      if (next === state) return state;
      state = next;
      listeners.forEach((fn) => {
        try {
          fn(state);
        } catch (e) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[AppState] listener error", e);
          }
        }
      });
      sliceListeners.forEach((entry) => {
        let slice;
        try {
          slice = entry.selector(state);
        } catch (e) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[AppState] selector error", e);
          }
          return;
        }
        if (!shallowEqual(slice, entry.prev)) {
          const prev = entry.prev;
          entry.prev = slice;
          try {
            entry.listener(slice, prev, state);
          } catch (e) {
            if (typeof console !== "undefined" && console.warn) {
              console.warn("[AppState] slice listener error", e);
            }
          }
        }
      });
      return state;
    }

    function isShareActive(argState) {
      const root = argState == null ? getState() : argState;
      const sh = root?.share ?? root;
      if (sh?.active !== undefined) return !!sh.active;
      return !!(sh?.isLocalShareActive || sh?.isRemoteShareActive);
    }

    return { getState, dispatch, subscribe, select, isShareActive };
  }

  const store = createStore();
  global.AppState = store;
  global.createMojAppStore = createStore;
})(typeof window !== "undefined" ? window : global);
