/**
 * Efectos post-dispatch (transiciones de layout, chat en share).
 */
(function (global) {
  const T = global.MojActionTypes || {};

  function registerRoomEffects(store, hooks = {}) {
    if (!store?.subscribe) return () => {};

    let prevLayout = store.getState().ui.currentLayout;

    const unsubLayout = store.subscribe(
      (s) => s.ui.currentLayout,
      (layout) => {
        if (layout === "share" && prevLayout !== "share") {
          if (hooks.onShareLayoutEnter) hooks.onShareLayoutEnter();
        }
        prevLayout = layout;
        if (hooks.onLayoutChange) hooks.onLayoutChange(layout);
      }
    );

    return () => {
      unsubLayout();
    };
  }

  global.MojRoomEffects = {
    registerRoomEffects,
    ActionTypes: T,
  };
})(typeof window !== "undefined" ? window : global);
