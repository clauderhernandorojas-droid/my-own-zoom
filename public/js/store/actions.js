/**
 * Acciones del store de sala (AppState).
 */
(function (global) {
  const ActionTypes = {
    UI_TOGGLE_CHAT: "UI_TOGGLE_CHAT",
    UI_SET_CHAT_OPEN: "UI_SET_CHAT_OPEN",
    UI_SET_LAYOUT: "UI_SET_LAYOUT",
    SHARE_LOCAL_STARTED: "SHARE_LOCAL_STARTED",
    SHARE_LOCAL_STOPPED: "SHARE_LOCAL_STOPPED",
    SHARE_REMOTE_SET: "SHARE_REMOTE_SET",
    SHARE_OWNER_SET: "SHARE_OWNER_SET",
    SHARE_REQUEST_ADD: "SHARE_REQUEST_ADD",
    SHARE_REQUEST_REMOVE: "SHARE_REQUEST_REMOVE",
    SHARE_MY_REQUEST_SET: "SHARE_MY_REQUEST_SET",
    SHARE_GRANT_SET: "SHARE_GRANT_SET",
    PARTICIPANTS_PANEL_SET: "PARTICIPANTS_PANEL_SET",
    FLAGS_SET: "FLAGS_SET",
    ROOM_RESET: "ROOM_RESET",
  };

  global.MojActionTypes = ActionTypes;
})(typeof window !== "undefined" ? window : global);
