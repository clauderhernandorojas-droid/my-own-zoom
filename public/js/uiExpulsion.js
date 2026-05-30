/**
 * uiExpulsion.js — expulsión de invitados (solo host/docente): barra inferior + modal.
 */
(function (global) {
  /** @type {object | null} */
  let deps = null;
  let mounted = false;
  let expelSplit = null;
  let expelMenu = null;
  let expelMenuOpen = false;
  let modalEl = null;
  let pendingExpelUserId = null;

  function normId(id) {
    return String(id || "")
      .trim()
      .toLowerCase();
  }

  function sameUserId(a, b) {
    const x = normId(a);
    const y = normId(b);
    return !!(x && y && x === y);
  }

  function closeExpulsionMenu() {
    if (!expelMenu || !expelSplit) return;
    expelMenu.classList.remove("room-popover--open");
    expelSplit.querySelector(".room-tb-btn")?.removeAttribute("data-open");
    expelSplit.querySelector(".room-tb-chevron")?.setAttribute("aria-expanded", "false");
    expelMenuOpen = false;
  }

  function toggleExpulsionMenu() {
    if (!expelMenu || !expelSplit) return;
    if (expelMenuOpen) {
      closeExpulsionMenu();
      return;
    }
    refreshExpulsionMenu();
    expelMenu.classList.add("room-popover--open");
    expelSplit.querySelector(".room-tb-btn")?.setAttribute("data-open", "true");
    expelSplit.querySelector(".room-tb-chevron")?.setAttribute("aria-expanded", "true");
    expelMenuOpen = true;
  }

  function closeExpulsionModal() {
    pendingExpelUserId = null;
    modalEl?.classList.add("hidden");
  }

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement("div");
    modalEl.id = "expulsionConfirmModal";
    modalEl.className = "profile-modal hidden";
    modalEl.setAttribute("role", "dialog");
    modalEl.setAttribute("aria-modal", "true");
    modalEl.setAttribute("aria-labelledby", "expulsionConfirmModalTitle");
    modalEl.innerHTML =
      '<div class="profile-modal__backdrop"></div>' +
      '<div class="profile-modal__card share-req-modal__card">' +
      '<div class="share-req-modal__badge">Expulsar participante</div>' +
      '<h3 id="expulsionConfirmModalTitle">Confirmar expulsión</h3>' +
      '<p id="expulsionConfirmModalBody" class="share-req-modal__name"></p>' +
      '<p class="share-req-modal__hint">El participante será desconectado de la reunión. Podrá volver a solicitar entrada si la sala de espera está activa.</p>' +
      '<div class="share-req-modal__actions">' +
      '<button type="button" id="btnExpulsionCancel" class="btn-muted">Cancelar</button>' +
      '<button type="button" id="btnExpulsionConfirm" class="room-tb-btn room-tb-btn--danger">Expulsar</button>' +
      "</div></div>";
    document.body.appendChild(modalEl);
    modalEl.querySelector(".profile-modal__backdrop")?.addEventListener("click", closeExpulsionModal);
    modalEl.querySelector("#btnExpulsionCancel")?.addEventListener("click", closeExpulsionModal);
    modalEl.querySelector("#btnExpulsionConfirm")?.addEventListener("click", () => {
      const uid = pendingExpelUserId;
      closeExpulsionModal();
      closeExpulsionMenu();
      if (uid) void expelParticipant(uid);
    });
    return modalEl;
  }

  function showExpulsionConfirmModal(userId) {
    const uid = String(userId || "");
    if (!uid) return;
    const modal = ensureModal();
    const body = modal.querySelector("#expulsionConfirmModalBody");
    const displayName = deps?.getParticipantDisplayName?.(uid) || uid.slice(0, 8);
    if (body) {
      body.textContent = `¿Expulsar a ${displayName} (${uid.slice(0, 8)}…) de la reunión?`;
    }
    pendingExpelUserId = uid;
    modal.classList.remove("hidden");
  }

  function expelParticipant(userId) {
    const socket = deps?.getSocket?.();
    const roomId = deps?.getActiveRoomId?.();
    const uid = String(userId || "");
    if (!socket?.connected || !roomId || !uid) {
      deps?.setMediaStatus?.("No se pudo expulsar: sin conexión o sala.");
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      socket.emit(
        "room:expel",
        {
          roomId: deps.normRoomKey?.(roomId) ?? roomId,
          targetUserId: uid,
        },
        (resp) => {
          if (resp?.ok) {
            deps?.setMediaStatus?.("Participante expulsado.");
            deps?.log?.("Participante expulsado: " + uid);
            refreshExpulsionMenu();
            resolve(true);
          } else {
            deps?.setMediaStatus?.(resp?.error || "No se pudo expulsar al participante.");
            resolve(false);
          }
        }
      );
    });
  }

  function getExpellableUserIds() {
    const connected = deps?.getConnectedUserIds?.();
    const selfId = deps?.getCurrentUserId?.();
    const docenteId = deps?.getRoomDocenteUserId?.();
    if (!connected || typeof connected[Symbol.iterator] !== "function") return [];
    const out = [];
    for (const uid of connected) {
      const id = String(uid || "");
      if (!id) continue;
      if (sameUserId(id, selfId)) continue;
      if (sameUserId(id, docenteId)) continue;
      out.push(id);
    }
    return out;
  }

  function refreshExpulsionMenu() {
    if (!expelMenu) return;
    expelMenu.innerHTML = "";
    const title = document.createElement("p");
    title.className = "room-menu-title";
    title.textContent = "Expulsar participante";
    expelMenu.appendChild(title);

    const list = getExpellableUserIds();
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "room-menu-title";
      empty.style.fontWeight = "normal";
      empty.textContent = "No hay invitados conectados para expulsar.";
      expelMenu.appendChild(empty);
      return;
    }

    list.forEach((uid) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "room-menu-item";
      btn.setAttribute("role", "menuitem");
      const name = deps?.getParticipantDisplayName?.(uid) || uid.slice(0, 8);
      btn.textContent = name;
      const meta = document.createElement("span");
      meta.className = "room-menu-item__meta";
      meta.textContent = uid.slice(0, 8) + "…";
      btn.appendChild(meta);
      btn.addEventListener("click", () => {
        showExpulsionConfirmModal(uid);
        closeExpulsionMenu();
      });
      expelMenu.appendChild(btn);
    });
  }

  function updateExpulsionControlsVisibility() {
    if (!expelSplit) return;
    const show = !!(deps?.getActiveRoomId?.() && deps?.canManageSharingInMeeting?.());
    expelSplit.classList.toggle("hidden", !show);
    if (!show) {
      closeExpulsionMenu();
      closeExpulsionModal();
    }
  }

  function mountToolbar() {
    const container = document.getElementById("roomMediaControls");
    const leaveBtn = document.getElementById("btnSalirSala");
    if (!container || document.getElementById("expelSplit")) {
      expelSplit = document.getElementById("expelSplit");
      expelMenu = document.getElementById("expelMenu");
      return;
    }

    expelSplit = document.createElement("div");
    expelSplit.id = "expelSplit";
    expelSplit.className = "room-tb-split hidden";

    const btnMain = document.createElement("button");
    btnMain.type = "button";
    btnMain.id = "btnExpelMain";
    btnMain.className = "room-tb-btn room-tb-btn--danger";
    btnMain.title = "Expulsar a un participante de la reunión";
    btnMain.setAttribute("aria-label", "Expulsar participante");
    btnMain.setAttribute("aria-haspopup", "menu");
    btnMain.setAttribute("aria-expanded", "false");
    btnMain.innerHTML =
      '<svg class="room-tb-btn__svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="2"/>' +
      '<line x1="17" y1="8" x2="23" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      '<line x1="23" y1="8" x2="17" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      "</svg>" +
      '<span class="room-tb-label">Expulsar</span>';

    const btnMenu = document.createElement("button");
    btnMenu.type = "button";
    btnMenu.id = "btnExpelMenu";
    btnMenu.className = "room-tb-chevron";
    btnMenu.setAttribute("aria-label", "Lista de participantes para expulsar");
    btnMenu.setAttribute("aria-haspopup", "menu");
    btnMenu.setAttribute("aria-expanded", "false");
    btnMenu.textContent = "▲";

    expelMenu = document.createElement("div");
    expelMenu.id = "expelMenu";
    expelMenu.className = "room-popover";
    expelMenu.setAttribute("role", "menu");
    expelMenu.setAttribute("aria-label", "Participantes para expulsar");

    btnMain.addEventListener("click", () => toggleExpulsionMenu());
    btnMenu.addEventListener("click", () => toggleExpulsionMenu());

    expelSplit.appendChild(btnMain);
    expelSplit.appendChild(btnMenu);
    expelSplit.appendChild(expelMenu);

    if (leaveBtn) {
      container.insertBefore(expelSplit, leaveBtn);
    } else {
      container.appendChild(expelSplit);
    }
  }

  /**
   * @param {object} options
   */
  function initExpulsionControls(options) {
    deps = options || {};
    if (!mounted) {
      mountToolbar();
      ensureModal();
      mounted = true;
    }
    updateExpulsionControlsVisibility();
    refreshExpulsionMenu();
  }

  /**
   * @param {{ roomId?: string, byUserId?: string }} payload
   * @param {() => Promise<void>} onLeave
   */
  function onRoomExpelled(payload, onLeave) {
    const roomId = deps?.getActiveRoomId?.();
    if (!roomId || !payload?.roomId) return;
    const norm = deps?.normRoomKey;
    const a = norm ? norm(payload.roomId) : String(payload.roomId).toLowerCase();
    const b = norm ? norm(roomId) : String(roomId).toLowerCase();
    if (a !== b) return;
    deps?.setMediaStatus?.("El presentador te expulsó de la reunión.");
    void Promise.resolve(onLeave?.()).catch((err) => console.warn(err));
  }

  global.ExpulsionControls = {
    initExpulsionControls,
    showExpulsionConfirmModal,
    expelParticipant,
    updateExpulsionControlsVisibility,
    refreshExpulsionMenu,
    closeExpulsionMenu,
    onRoomExpelled,
  };
})(typeof window !== "undefined" ? window : globalThis);
