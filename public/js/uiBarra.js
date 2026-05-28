/**
 * uiBarra.js — botón Chat y badge en la barra inferior de sala (#roomMediaControls).
 */
(function (global) {
  let btnChat = null;
  let badgeEl = null;
  /** @type {Function | null} */
  let onOpenChat = null;

  function formatBadgeCount(n) {
    const v = Number(n) || 0;
    if (v <= 0) return "";
    return v > 99 ? "99+" : String(v);
  }

  function updateBadge(totalUnread) {
    if (!badgeEl || !btnChat) return;
    const n = Number(totalUnread) || 0;
    if (n <= 0) {
      badgeEl.textContent = "";
      badgeEl.classList.add("hidden");
      badgeEl.setAttribute("aria-hidden", "true");
      btnChat.setAttribute(
        "aria-label",
        "Abrir chat"
      );
      return;
    }
    const label = n === 1 ? "1 mensaje sin leer" : `${n} mensajes sin leer`;
    badgeEl.textContent = formatBadgeCount(n);
    badgeEl.classList.remove("hidden");
    badgeEl.setAttribute("aria-hidden", "false");
    btnChat.setAttribute("aria-label", `Abrir chat (${label})`);
  }

  /**
   * @param {{ onOpenChat?: Function, onNotificacionesUpdate?: Function }} opts
   */
  function mountRoomBottomBar(opts) {
    onOpenChat = opts?.onOpenChat || null;
    const container = document.getElementById("roomMediaControls");
    if (!container) return;

    const leaveBtn = document.getElementById("btnLeave");
    if (document.getElementById("btnChatBar")) {
      btnChat = document.getElementById("btnChatBar");
      badgeEl = btnChat?.querySelector(".room-tb-badge");
      return;
    }

    btnChat = document.createElement("button");
    btnChat.type = "button";
    btnChat.id = "btnChatBar";
    btnChat.className = "room-tb-btn";
    btnChat.title = "Chat";
    btnChat.setAttribute("aria-label", "Abrir chat");
    btnChat.innerHTML =
      '<span class="room-tb-btn__icon" aria-hidden="true">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
      "</svg></span>" +
      '<span class="room-tb-badge hidden" aria-hidden="true"></span>';

    badgeEl = btnChat.querySelector(".room-tb-badge");

    btnChat.addEventListener("click", () => {
      onOpenChat?.();
    });

    if (leaveBtn) {
      container.insertBefore(btnChat, leaveBtn);
    } else {
      container.appendChild(btnChat);
    }

    if (typeof opts?.onNotificacionesUpdate === "function") {
      opts.onNotificacionesUpdate({ totalUnread: 0 });
    }
  }

  global.UiBarra = {
    mountRoomBottomBar,
    updateBadge,
  };
})(typeof window !== "undefined" ? window : globalThis);
