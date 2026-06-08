/**
 * RoomChatModule — facade chat sala (panel AppState + ChatModule mensajes).
 */
(function (global) {
  function init(deps = {}) {
    global.ChatPanelModule?.init?.({
      $: deps.$,
      legacySyncHidden: deps.legacySyncHidden,
      onChatVisibilityChange: deps.onChatVisibilityChange,
      legacyToggle: deps.legacyToggle,
    });
    if (typeof global.ChatModule !== "undefined" && deps.initChatRoom) {
      deps.initChatRoom();
    }
  }

  function update(prev, next) {
    global.ChatPanelModule?.update?.(prev, next);
  }

  function destroy() {
    global.ChatPanelModule?.destroy?.();
    global.ChatModule?.resetRoomChat?.();
  }

  function bindBottomBar(mods) {
    global.ChatPanelModule?.bindBottomBar?.(mods);
  }

  global.RoomChatModule = {
    init,
    update,
    destroy,
    bindBottomBar,
    toggleFromBar: () => global.ChatPanelModule?.toggleFromBar?.(),
  };
})(typeof window !== "undefined" ? window : global);
