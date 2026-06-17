/**
 * crossDomainEffects — efectos entre dominios chat/share (sin escribir share.* desde chat).
 */
(function (global) {
  const T = global.MojActionTypes || {};

  function registerCrossDomainEffects(store) {
    if (!store?.subscribe || !store.dispatch) return () => {};

    let prevLayout = store.getState()?.ui?.currentLayout;

    const unsubLayout = store.subscribe(
      (s) => s.ui.currentLayout,
      (layout) => {
        if (layout === "share" && prevLayout !== "share") {
          store.dispatch({ type: T.UI_SET_CHAT_OPEN, open: false });
        }
        prevLayout = layout;
      }
    );

    return () => {
      unsubLayout();
    };
  }

  global.MojCrossDomainEffects = {
    registerCrossDomainEffects,
  };
})(typeof window !== "undefined" ? window : global);
