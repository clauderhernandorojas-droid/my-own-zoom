/**
 * RoomNoticeBus — avisos share → chat vía evento DOM moj:room:notice.
 */
(function (global) {
  const EVENT_NAME = "moj:room:notice";

  function onRoomNotice(event) {
    const text = event?.detail?.text;
    if (!text) return;
    const state = global.AppState?.getState?.();
    if (state?.flags?.enableChat === false) return;
    global.ChatModule?.appendRecordingNotice?.(text);
  }

  if (typeof document !== "undefined") {
    document.addEventListener(EVENT_NAME, onRoomNotice);
  }

  function emitRoomNotice(text) {
    const msg = text != null ? String(text).trim() : "";
    if (!msg) return;
    if (typeof document !== "undefined") {
      document.dispatchEvent(
        new CustomEvent(EVENT_NAME, { detail: { text: msg } })
      );
    }
  }

  global.RoomNoticeBus = {
    emitRoomNotice,
    EVENT_NAME,
  };
})(typeof window !== "undefined" ? window : global);
