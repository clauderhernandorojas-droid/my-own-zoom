/**
 * roomKeyboardShortcuts.js — atajos globales en sala (reunión, tablero, overlay).
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let boundHandler = null;

  const LINE_WIDTH_STEPS = [2, 4, 7];
  const TOOL_KEYS = { p: "pencil", e: "eraser", t: "text", s: "pointer", h: "hand" };

  function isShortcutBlockedTarget(target) {
    if (!target) return false;
    const el = target.nodeType === 1 ? target : target.parentElement;
    if (!el) return false;
    const tag = String(el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    if (el.closest?.('[contenteditable="true"]')) return true;
    if (el.closest?.(".board-text-inline")) return true;
    if (el.closest?.(".screen-overlay-text-input")) return true;
    if (el.closest?.(".screen-overlay-stack textarea")) return true;
    const id = el.id || "";
    if (id === "chatInput" || id === "email" || id === "password" || id === "nombre") return true;
    if (el.closest?.("#authSection")) return true;
    return false;
  }

  function getAnnotationContext() {
    if (!deps?.getActiveRoomId?.()) return null;
    const roomSection = document.getElementById("roomSection");
    if (roomSection?.classList.contains("hidden")) return null;
    const shell = document.getElementById("roomShell");
    const inShareLayout =
      shell?.classList.contains("room-shell--presenter-focus") ||
      shell?.classList.contains("room-shell--remote-screen-dominant");
    const ScreenOverlay = global.ScreenOverlay;
    if (inShareLayout) {
      if (ScreenOverlay?.isToolbarOpen?.()) return "overlay";
      return null;
    }
    return "board";
  }

  function cycleLineWidth(current, direction) {
    let i = LINE_WIDTH_STEPS.indexOf(current);
    if (i < 0) i = 1;
    i = Math.max(0, Math.min(LINE_WIDTH_STEPS.length - 1, i + direction));
    return LINE_WIDTH_STEPS[i];
  }

  function isBrushWidthKey(key) {
    return key === "+" || key === "=" || key === "]" || key === "[" || key === "-" || key === "_";
  }

  function brushWidthDirection(key) {
    if (key === "+" || key === "=" || key === "]") return 1;
    if (key === "-" || key === "_" || key === "[") return -1;
    return 0;
  }

  function toggleMic() {
    const localStream = deps.getLocalStream?.();
    const screenShareAudioTrack = deps.getScreenShareAudioTrack?.();
    if (!localStream && !screenShareAudioTrack) return false;
    const t = localStream?.getAudioTracks?.()[0];
    const currentlyOn = t ? t.enabled : screenShareAudioTrack?.enabled !== false;
    deps.setMicEnabled?.(!currentlyOn);
    return true;
  }

  function toggleCam() {
    const localStream = deps.getLocalStream?.();
    if (!localStream) return false;
    const t = localStream.getVideoTracks?.()[0];
    if (!t) return false;
    deps.setCamEnabled?.(!t.enabled);
    return true;
  }

  function applyToolKey(tool) {
    const ctx = getAnnotationContext();
    if (ctx === "overlay") {
      global.ScreenOverlay?.setTool?.(tool === "hand" ? "pointer" : tool);
      return true;
    }
    if (ctx === "board") {
      deps.setBoardTool?.(tool);
      return true;
    }
    return false;
  }

  function handleDelete() {
    const ctx = getAnnotationContext();
    if (ctx === "overlay") {
      return !!global.ScreenOverlay?.deleteSelection?.();
    }
    return !!deps.deleteBoardSelection?.();
  }

  function handleArrowNudge(e) {
    const step = e.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else return false;

    const ctx = getAnnotationContext();
    if (ctx === "overlay") {
      return !!global.ScreenOverlay?.nudgeSelection?.(dx, dy);
    }
    return !!deps.nudgeBoardSelection?.(dx, dy);
  }

  function handleBrushWidth(key) {
    const dir = brushWidthDirection(key);
    if (!dir) return false;
    const ctx = getAnnotationContext();
    if (ctx === "overlay") {
      global.ScreenOverlay?.adjustLineWidth?.(dir);
      return true;
    }
    if (ctx === "board") {
      const next = cycleLineWidth(deps.getBoardLineWidth?.() ?? 4, dir);
      deps.setBoardLineWidth?.(next);
      return true;
    }
    return false;
  }

  function handleEscape(e) {
    const ctx = getAnnotationContext();
    if (ctx === "overlay" && global.ScreenOverlay?.hasSelection?.()) {
      global.ScreenOverlay.clearSelection?.();
      e.preventDefault();
      return true;
    }
    if ((deps.getBoardSelectionSize?.() ?? 0) > 0) {
      deps.clearBoardSelection?.();
      deps.drawBoard?.();
      e.preventDefault();
      return true;
    }
    if (global.ScreenOverlay?.isToolbarOpen?.()) {
      global.ScreenOverlay.closeToolbar?.();
      e.preventDefault();
      return true;
    }
    let handled = false;
    if (!deps.getChatPanelHidden?.()) {
      deps.closeChatPanel?.();
      handled = true;
    }
    if (deps.isParticipantsPanelOpen?.()) {
      deps.closeParticipantsPanel?.();
      handled = true;
    }
    deps.closeToolbarMenus?.();
    deps.closeBoardSideMenus?.();
    deps.closeChatCtxMenu?.();
    if (handled) e.preventDefault();
    return handled;
  }

  function handleBoardClipboard(e) {
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      if (deps.getBoardTool?.() !== "pointer") return false;
      const idx = deps.getSelectedElementIndex?.();
      if (idx == null || idx < 0) return false;
      const el = deps.getBoardElementAt?.(idx);
      if (el?.locked) return false;
      if (el && (el.type === "text" || el.type === "image")) {
        e.preventDefault();
        deps.setClipboardBoardElement?.(JSON.parse(JSON.stringify(el)));
        deps.log?.("Copiado al portapapeles del tablero (Ctrl+V).");
        return true;
      }
    }
    if (e.ctrlKey && (e.key === "v" || e.key === "V") && deps.getClipboardBoardElement?.()) {
      e.preventDefault();
      const copy = JSON.parse(JSON.stringify(deps.getClipboardBoardElement()));
      delete copy.locked;
      copy.x = Math.round((copy.x || 0) + 24);
      copy.y = Math.round((copy.y || 0) + 24);
      deps.pasteBoardElement?.(copy);
      deps.log?.("Pegado en el tablero.");
      return true;
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      deps.performBoardUndo?.();
      return true;
    }
    if (
      e.ctrlKey &&
      (e.key === "y" ||
        e.key === "Y" ||
        (e.shiftKey && (e.key === "z" || e.key === "Z")))
    ) {
      e.preventDefault();
      deps.performBoardRedo?.();
      return true;
    }
    return false;
  }

  function onKeyDown(e) {
    if (!deps?.getActiveRoomId?.()) return;
    if (deps.hasActiveBoardTextInput?.()) return;
    if (global.ScreenOverlay?.isEditingText?.()) return;
    if (isShortcutBlockedTarget(e.target)) return;

    let action = null;

    if (e.key === "Escape") {
      if (handleEscape(e)) action = "escape";
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "m" || e.key === "M")) {
      if (toggleMic()) {
        e.preventDefault();
        action = "toggleMic";
      }
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "v" || e.key === "V")) {
      if (toggleCam()) {
        e.preventDefault();
        action = "toggleCam";
      }
    } else if (handleBoardClipboard(e)) {
      action = "boardClipboard";
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (handleDelete()) {
        e.preventDefault();
        action = "delete";
      }
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      const k = e.key.toLowerCase();
      if (TOOL_KEYS[k]) {
        if (applyToolKey(TOOL_KEYS[k])) {
          e.preventDefault();
          action = "tool:" + TOOL_KEYS[k];
        }
      } else if (isBrushWidthKey(e.key)) {
        if (handleBrushWidth(e.key)) {
          e.preventDefault();
          action = "brushWidth";
        }
      }
    } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      if (handleArrowNudge(e)) {
        e.preventDefault();
        action = "nudge";
      }
    }

  }

  function init(options = {}) {
    deps = options;
    if (boundHandler) {
      global.removeEventListener("keydown", boundHandler);
    }
    boundHandler = onKeyDown;
    global.addEventListener("keydown", boundHandler);
  }

  function destroy() {
    if (boundHandler) {
      global.removeEventListener("keydown", boundHandler);
      boundHandler = null;
    }
    deps = null;
  }

  global.RoomKeyboardShortcuts = {
    init,
    destroy,
    isShortcutBlockedTarget,
    getAnnotationContext,
  };
})(typeof window !== "undefined" ? window : global);
