/**
 * chat.js — chat en sala: hilos, render, composer, adjuntos y bus moj:chat:notify/read.
 * No confundir eventos del bus con Socket.IO `chat:message`.
 */
(function (global) {
  const EVENT_NOTIFY = "moj:chat:notify";
  const EVENT_READ = "moj:chat:read";
  const CHAT_REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "🎉", "👏"];
  const CHAT_EXTRA_EMOJIS = ["🔥", "👏", "🤝", "🙏", "💡", "✅", "❓", "😎", "🤔", "💯"];

  /** @type {object | null} */
  let deps = null;
  /** @type {Map<string, object>} */
  const chatThreads = new Map();
  let activeChatThreadKey = "general";
  let pendingChatAdjunto = null;
  let pendingChatPreviewUrl = "";
  const chatAdjuntoPreviewCache = new Map();
  /** @type {{ mensajeId: string, mensaje: object } | null} */
  let chatCtxMenuTarget = null;
  let composerBound = false;

  function $(id) {
    return deps?.$ ? deps.$(id) : document.getElementById(id);
  }

  function emitNotify(detail) {
    document.dispatchEvent(new CustomEvent(EVENT_NOTIFY, { detail: detail || {} }));
  }

  function emitRead(detail) {
    document.dispatchEvent(new CustomEvent(EVENT_READ, { detail: detail || {} }));
  }

  function sameUserId(a, b) {
    if (a == null || b == null) return false;
    return String(a).toLowerCase() === String(b).toLowerCase();
  }

  function dmThreadKey(userId) {
    const id = userId != null ? String(userId).trim().toLowerCase() : "";
    return id ? `dm:${id}` : null;
  }

  function resolveDmTargetForSend() {
    const key = activeChatThreadKey;
    if (key?.startsWith("dm:")) {
      const thread = chatThreads.get(key) || chatThreads.get(dmThreadKey(key.slice(3)));
      const peerId = thread?.targetUserId || key.slice(3);
      if (peerId) return { thread, peerId: String(peerId).trim() };
    }
    const active = chatThreads.get(key);
    if (active?.type === "dm" && active.targetUserId) {
      return { thread: active, peerId: String(active.targetUserId).trim() };
    }
    return null;
  }

  /** Identidad del usuario en sala; null si aún no cargó /api/usuarios/me. */
  function getSelfUserId() {
    const id = deps?.getCurrentUser?.()?.usuarioId;
    return id != null && String(id).trim() !== "" ? id : null;
  }

  function shouldMarkUnread(threadKey) {
    if (!threadKey) return false;
    if (deps?.getChatPanelHidden?.()) return true;
    return activeChatThreadKey !== threadKey;
  }

  /**
   * Reglas de badge: requiere selfId (degradación segura si falta).
   * Mensajes propios nunca incrementan unread.
   */
  function shouldIncrementUnreadForIncoming(autorUserId, threadKey) {
    const selfId = getSelfUserId();
    if (!selfId) return false;
    if (autorUserId && sameUserId(autorUserId, selfId)) return false;
    return shouldMarkUnread(threadKey);
  }

  function findThreadKeyForMessage(mensajeId) {
    const id = String(mensajeId || "").trim();
    if (!id) return null;
    for (const [key, thread] of chatThreads) {
      if (!thread?.messages) continue;
      if (thread.messages.some((m) => String(m?.mensajeId || "") === id)) {
        return key;
      }
    }
    return null;
  }

  function bumpThreadUnread(threadKey, meta) {
    if (!getSelfUserId()) return;
    if (!chatThreads.has(threadKey)) return;
    const thread = chatThreads.get(threadKey);
    thread.unread = (thread.unread || 0) + 1;
    renderChatThreadTabs();
    emitNotify({
      kind: meta?.kind || "message",
      threadKey,
      mensajeId: meta?.mensajeId,
      fromUserId: meta?.fromUserId,
      roomId: deps?.getActiveRoomId?.(),
    });
  }

  function markThreadRead(threadKey) {
    if (threadKey && chatThreads.has(threadKey)) {
      chatThreads.get(threadKey).unread = 0;
      renderChatThreadTabs();
    }
    emitRead({ threadKey });
  }

  function markAllRead() {
    chatThreads.forEach((t) => {
      t.unread = 0;
    });
    renderChatThreadTabs();
    emitRead({ all: true });
  }

  function ensureGeneralThread() {
    if (!chatThreads.has("general")) {
      chatThreads.set("general", {
        key: "general",
        type: "general",
        label: "General",
        targetUserId: null,
        messages: [],
        unread: 0,
      });
    }
  }

  function getChatThreads() {
    return chatThreads;
  }

  function getActiveChatThreadKey() {
    return activeChatThreadKey;
  }

  function appendChatLine(payload) {
    const m = payload?.mensaje;
    if (!m) return;
    const autor = m.autor || null;
    const destinatario = m.destinatario || null;
    const participantsById = deps?.getParticipantsById?.();
    if (participantsById) {
      if (autor?.usuarioId) participantsById.set(autor.usuarioId, autor);
      if (destinatario?.usuarioId) participantsById.set(destinatario.usuarioId, destinatario);
    }

    let threadKey = "general";
    if (m.tipo === "privado") {
      const selfId = deps?.getCurrentUser?.()?.usuarioId;
      const isMine = selfId && autor?.usuarioId && sameUserId(autor.usuarioId, selfId);
      const peerId = isMine
        ? m.destinatarioUsuarioId || destinatario?.usuarioId
        : autor?.usuarioId;
      if (peerId) {
        threadKey = dmThreadKey(peerId);
        if (!threadKey) return;
        if (!chatThreads.has(threadKey)) {
          const peer = participantsById?.get(peerId);
          const label = peer?.nombre || `Usuario ${String(peerId).slice(0, 8)}`;
          chatThreads.set(threadKey, {
            key: threadKey,
            type: "dm",
            targetUserId: peerId,
            label,
            messages: [],
            unread: 0,
          });
        }
      }
    } else {
      ensureGeneralThread();
    }

    const thread = chatThreads.get(threadKey);
    if (!thread) return;
    thread.messages.push(m);

    const autorId = autor?.usuarioId ?? null;
    const markUnread = shouldIncrementUnreadForIncoming(autorId, threadKey);
    if (markUnread) {
      thread.unread = (thread.unread || 0) + 1;
      emitNotify({
        kind: "message",
        threadKey,
        fromUserId: autor?.usuarioId,
        mensajeId: m.mensajeId,
      });
    }

    renderChatThreadTabs();
    renderChatMessages();
    refreshChatThreadPicker();
  }

  function onIncomingMessage(payload) {
    appendChatLine(payload);
  }

  function applyMessageReactionsUpdate(mensajeId, reactions) {
    const id = String(mensajeId || "").trim();
    if (!id) return;
    chatThreads.forEach((t) => {
      t.messages.forEach((m) => {
        if (String(m?.mensajeId || "") === id) {
          m.reaccionesResumen = Array.isArray(reactions) ? reactions : [];
        }
      });
    });
    renderChatMessages();
  }

  function onIncomingReaction(payload) {
    const mensajeId = payload?.mensajeId;
    if (!mensajeId) return;
    const threadKey = findThreadKeyForMessage(mensajeId);
    applyMessageReactionsUpdate(String(mensajeId), payload.reactions);
    if (threadKey && getSelfUserId() && shouldMarkUnread(threadKey)) {
      bumpThreadUnread(threadKey, { kind: "reaction", mensajeId: String(mensajeId) });
    } else if (threadKey && getSelfUserId()) {
      emitNotify({ kind: "reaction", threadKey, mensajeId: String(mensajeId) });
    }
  }

  function onActiveThreadChanged(threadKey) {
    if (!threadKey || deps?.getChatPanelHidden?.()) return;
    markThreadRead(threadKey);
  }

  function setActiveChatThread(threadKey) {
    if (!chatThreads.has(threadKey)) return;
    activeChatThreadKey = threadKey;
    const thread = chatThreads.get(threadKey);
    if (!deps?.getChatPanelHidden?.()) {
      thread.unread = 0;
      onActiveThreadChanged(threadKey);
    }
    renderChatThreadTabs();
    renderChatMessages();
  }

  function closeChatThread(threadKey) {
    const thread = chatThreads.get(threadKey);
    if (!thread || thread.type !== "dm") return;
    chatThreads.delete(threadKey);
    if (activeChatThreadKey === threadKey) {
      activeChatThreadKey = "general";
    }
    renderChatThreadTabs();
    renderChatMessages();
    refreshChatThreadPicker();
  }

  function renderChatThreadTabs() {
    const container = $("chatThreadTabs");
    if (!container) return;
    container.innerHTML = "";
    const ordered = [...chatThreads.values()].sort((a, b) => {
      if (a.key === "general") return -1;
      if (b.key === "general") return 1;
      return a.label.localeCompare(b.label, "es");
    });
    ordered.forEach((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-tab" + (t.key === activeChatThreadKey ? " active" : "");
      btn.textContent = t.label;
      if (t.unread > 0) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = String(t.unread);
        btn.appendChild(badge);
      }
      if (t.type === "dm") {
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "chat-tab-close";
        closeBtn.title = `Cerrar chat con ${t.label}`;
        closeBtn.textContent = "×";
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          closeChatThread(t.key);
        });
        btn.appendChild(closeBtn);
      }
      btn.addEventListener("click", () => setActiveChatThread(t.key));
      container.appendChild(btn);
    });
  }

  function removeChatMessageEverywhere(mensajeId) {
    const id = String(mensajeId || "").trim();
    if (!id) return;
    const url = chatAdjuntoPreviewCache.get(id);
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }
    chatAdjuntoPreviewCache.delete(id);
    chatThreads.forEach((t) => {
      t.messages = t.messages.filter((mm) => String(mm.mensajeId) !== id);
    });
    renderChatMessages();
  }

  function buildReactionSummaryFromRows(rows = []) {
    const grouped = new Map();
    rows.forEach((row) => {
      const emoji = String(row?.emoji || "");
      if (!emoji) return;
      if (!grouped.has(emoji)) grouped.set(emoji, []);
      grouped.get(emoji).push({
        usuarioId: row?.reactor?.usuarioId || row?.usuarioId || null,
        nombre: row?.reactor?.nombre || "",
      });
    });
    return [...grouped.entries()].map(([emoji, users]) => ({
      emoji,
      count: users.length,
      users,
    }));
  }

  function getMessageReactionSummary(m) {
    if (!m || typeof m !== "object") return [];
    if (Array.isArray(m.reaccionesResumen)) return m.reaccionesResumen;
    if (Array.isArray(m.reacciones)) return buildReactionSummaryFromRows(m.reacciones);
    return [];
  }

  function emitChatReactionToggle(mensajeId, emoji) {
    const socket = deps?.getSocket?.();
    const activeRoomId = deps?.getActiveRoomId?.();
    if (!socket || !activeRoomId || !mensajeId || !emoji) return;
    socket.emit(
      "chat:reaction:toggle",
      { roomId: deps.normRoomKey(activeRoomId), mensajeId, emoji },
      (r) => {
        if (!r || r.ok === false) {
          appendRecordingNotice("Reacción: " + (r?.error || "No se pudo actualizar"));
          return;
        }
        if (Array.isArray(r.reactions)) {
          applyMessageReactionsUpdate(String(mensajeId), r.reactions);
        }
      }
    );
  }

  function closeChatCtxMenu() {
    const menu = $("chatCtxMenu");
    if (menu) {
      menu.classList.remove("chat-ctx--open");
      menu.innerHTML = "";
      menu.setAttribute("aria-hidden", "true");
    }
    chatCtxMenuTarget = null;
  }

  function openChatCtxMenu(clientX, clientY, m) {
    closeChatCtxMenu();
    const menu = $("chatCtxMenu");
    if (!menu || !m) return;
    const midRaw = m.mensajeId;
    const mid = midRaw != null ? String(midRaw) : "";
    const isLocal = mid.startsWith("local-");
    const selfId = deps?.getCurrentUser?.()?.usuarioId;
    const authorId = m.autor?.usuarioId;
    const isAdmin = String(deps?.getCurrentUser?.()?.rol || "").toLowerCase() === "admin";
    const canDelete =
      !!mid &&
      !isLocal &&
      (isAdmin ||
        (selfId && authorId && String(authorId).toLowerCase() === String(selfId).toLowerCase()));

    const addItem = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
        closeChatCtxMenu();
      });
      menu.appendChild(b);
    };

    addItem("Copiar texto", () => {
      void deps?.copyTextToClipboard?.(m.contenido || "");
    });
    if (m.adjuntoNombreOriginal) {
      addItem("Copiar nombre de archivo", () => {
        void deps?.copyTextToClipboard?.(String(m.adjuntoNombreOriginal));
      });
    }
    if (mid && !isLocal && m.adjuntoRelPath) {
      addItem("Copiar enlace de descarga", () => {
        const path = deps.toApiUrl("/api/mensajes/adjunto/" + encodeURIComponent(mid));
        void deps?.copyTextToClipboard?.(path);
      });
    }
    if (canDelete) {
      addItem("Eliminar mensaje", async () => {
        if (!confirm("¿Eliminar este mensaje" + (m.adjuntoRelPath ? " y su archivo" : "") + "?")) return;
        try {
          await deps.api("/api/mensajes/" + encodeURIComponent(mid), { method: "DELETE" });
          removeChatMessageEverywhere(mid);
        } catch (err) {
          deps?.log?.(err?.message || "No se pudo eliminar");
        }
      });
    }

    chatCtxMenuTarget = { mensajeId: mid, mensaje: m };
    menu.classList.add("chat-ctx--open");
    menu.setAttribute("aria-hidden", "false");
    const mw = 200;
    const mh = 180;
    let x = clientX;
    let y = clientY;
    if (x + mw > window.innerWidth - 6) x = window.innerWidth - mw - 6;
    if (y + mh > window.innerHeight - 6) y = window.innerHeight - mh - 6;
    menu.style.left = Math.max(6, x) + "px";
    menu.style.top = Math.max(6, y) + "px";
  }

  async function downloadChatAdjunto(mensajeId, suggestedName) {
    if (!deps?.getToken?.()) return;
    const r = await fetch(deps.toApiUrl("/api/mensajes/adjunto/" + encodeURIComponent(mensajeId)), {
      headers: { Authorization: "Bearer " + deps.getToken() },
    });
    if (!r.ok) {
      deps?.log?.("No se pudo descargar el adjunto.");
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName || "adjunto";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function renderChatMessages() {
    const box = $("chatBox");
    if (!box) return;
    box.innerHTML = "";
    closeChatCtxMenu();
    const thread = chatThreads.get(activeChatThreadKey);
    if (!thread) return;

    const getChatAdjuntoFileUrl = async (m) => {
      if (!m?.adjuntoRelPath || !m?.mensajeId) return "";
      const cacheKey = String(m.mensajeId);
      if (chatAdjuntoPreviewCache.has(cacheKey)) {
        return chatAdjuntoPreviewCache.get(cacheKey);
      }
      try {
        const r = await fetch(
          deps.toApiUrl("/api/mensajes/adjunto/" + encodeURIComponent(m.mensajeId)),
          { headers: { Authorization: "Bearer " + deps.getToken() } }
        );
        if (!r.ok) return "";
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        chatAdjuntoPreviewCache.set(cacheKey, url);
        return url;
      } catch (_) {
        return "";
      }
    };

    thread.messages.forEach((m) => {
      const row = document.createElement("div");
      const autor = m.autor?.nombre || m.autor?.usuarioId || "?";
      const tipo = m.tipo === "privado" ? " (privado)" : "";
      row.className = "chat-msg" + (m.tipo === "privado" ? " msg-privado" : "");
      const mid = m.mensajeId != null ? String(m.mensajeId) : "";
      if (mid) row.dataset.mensajeId = mid;
      const tstr = new Date(m.marcaTiempo || Date.now()).toLocaleTimeString();

      const hdr = document.createElement("div");
      hdr.className = "chat-msg__hdr";
      hdr.textContent = `[${tstr}] ${autor}${tipo}`;
      row.appendChild(hdr);

      const body = document.createElement("div");
      body.className =
        "chat-msg__body" + (m.adjuntoRelPath && m.mensajeId ? " chat-msg__body--adjunto" : "");

      const selfId = deps?.getCurrentUser?.()?.usuarioId;
      const authorId = m.autor?.usuarioId;
      const isAdmin = String(deps?.getCurrentUser?.()?.rol || "").toLowerCase() === "admin";
      const canDelete =
        !!mid &&
        !mid.startsWith("local-") &&
        (isAdmin ||
          (selfId &&
            authorId &&
            String(authorId).toLowerCase() === String(selfId).toLowerCase()));

      if (canDelete) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "chat-msg__del";
        del.title = "Eliminar mensaje";
        del.setAttribute("aria-label", "Eliminar mensaje");
        del.textContent = "×";
        del.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!confirm("¿Eliminar este mensaje" + (m.adjuntoRelPath ? " y su archivo" : "") + "?")) return;
          try {
            await deps.api("/api/mensajes/" + encodeURIComponent(mid), { method: "DELETE" });
            removeChatMessageEverywhere(mid);
          } catch (err) {
            deps?.log?.(err?.message || "No se pudo eliminar");
          }
        });
        body.appendChild(del);
      }

      body.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openChatCtxMenu(e.clientX, e.clientY, m);
      });

      if (m.adjuntoRelPath && m.mensajeId) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chat-adjunto-btn";
        btn.textContent = `📎 ${m.adjuntoNombreOriginal || "archivo"}`;
        btn.title = "Descargar adjunto";
        btn.addEventListener("click", () =>
          downloadChatAdjunto(m.mensajeId, m.adjuntoNombreOriginal || "adjunto")
        );
        body.appendChild(btn);
        const previewWrap = document.createElement("div");
        previewWrap.className = "chat-adjunto-preview";
        const mime = String(m.adjuntoMime || "").toLowerCase();
        if (mime.startsWith("image/")) {
          const img = document.createElement("img");
          img.alt = m.adjuntoNombreOriginal || "adjunto";
          img.loading = "lazy";
          previewWrap.appendChild(img);
          void getChatAdjuntoFileUrl(m).then((url) => {
            if (url) img.src = url;
          });
        } else if (mime.startsWith("video/")) {
          const vid = document.createElement("video");
          vid.controls = true;
          vid.preload = "metadata";
          vid.playsInline = true;
          previewWrap.appendChild(vid);
          void getChatAdjuntoFileUrl(m).then((url) => {
            if (url) vid.src = url;
          });
        } else if (mime.startsWith("audio/")) {
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.preload = "metadata";
          previewWrap.appendChild(audio);
          void getChatAdjuntoFileUrl(m).then((url) => {
            if (url) audio.src = url;
          });
        } else if (mime.includes("pdf")) {
          const emb = document.createElement("embed");
          emb.type = "application/pdf";
          previewWrap.appendChild(emb);
          void getChatAdjuntoFileUrl(m).then((url) => {
            if (url) emb.src = url + "#page=1&view=FitH";
          });
        } else {
          const fileCap = document.createElement("span");
          fileCap.className = "chat-adjunto-preview--file";
          fileCap.textContent = "Vista previa no disponible";
          previewWrap.appendChild(fileCap);
        }
        body.appendChild(previewWrap);
      }
      const cap = document.createElement("div");
      cap.style.marginTop = "0.2rem";
      cap.style.whiteSpace = "pre-wrap";
      cap.textContent = m.contenido || "";
      body.appendChild(cap);

      const midForReaction = m.mensajeId != null ? String(m.mensajeId) : "";
      const summary = getMessageReactionSummary(m);
      if (summary.length) {
        const chips = document.createElement("div");
        chips.className = "chat-msg__reactions";
        summary.forEach((item) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "chat-react-chip";
          const myUid = String(deps?.getCurrentUser?.()?.usuarioId || "").trim().toLowerCase();
          const mine = (item.users || []).some(
            (u) => String(u?.usuarioId || "").trim().toLowerCase() === myUid
          );
          if (mine) chip.classList.add("chat-react-chip--mine");
          chip.title = (item.users || []).map((u) => u?.nombre || "Usuario").join(", ");
          chip.textContent = `${item.emoji} ${item.count}`;
          chip.addEventListener("click", () => {
            emitChatReactionToggle(midForReaction, item.emoji);
          });
          chips.appendChild(chip);
        });
        body.appendChild(chips);
      }

      if (midForReaction && !midForReaction.startsWith("local-")) {
        const reactRow = document.createElement("div");
        reactRow.className = "chat-msg__react-row";
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "chat-msg__react-add";
        addBtn.textContent = "Reaccionar";
        const picker = document.createElement("div");
        picker.className = "chat-msg__react-picker";
        CHAT_REACTION_EMOJIS.forEach((emoji) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "chat-msg__react-emoji";
          b.textContent = emoji;
          b.addEventListener("click", () => {
            emitChatReactionToggle(midForReaction, emoji);
            picker.classList.remove("open");
          });
          picker.appendChild(b);
        });
        addBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          picker.classList.toggle("open");
        });
        reactRow.appendChild(addBtn);
        reactRow.appendChild(picker);
        body.appendChild(reactRow);
      }

      row.appendChild(body);
      box.appendChild(row);
    });
    box.scrollTop = box.scrollHeight;
  }

  function refreshChatThreadPicker() {
    const sel = $("chatThreadPicker");
    if (!sel) return;
    const previous = sel.value;
    sel.innerHTML = "";
    const general = document.createElement("option");
    general.value = "general";
    general.textContent = "General";
    sel.appendChild(general);

    const currentUser = deps?.getCurrentUser?.();
    const participantsById = deps?.getParticipantsById?.();
    const userOptions = [...(participantsById?.values() || [])]
      .filter((u) => u?.usuarioId && !sameUserId(u.usuarioId, currentUser?.usuarioId))
      .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
    userOptions.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.usuarioId;
      opt.textContent = u.nombre || u.email || u.usuarioId;
      sel.appendChild(opt);
    });
    sel.value = previous && [...sel.options].some((o) => o.value === previous) ? previous : "general";
  }

  function openDmThreadByUserId(userId) {
    if (!userId) return;
    const key = dmThreadKey(userId);
    if (!key) return;
    if (!chatThreads.has(key)) {
      const u = deps?.getParticipantsById?.()?.get(userId);
      chatThreads.set(key, {
        key,
        type: "dm",
        targetUserId: String(userId).trim(),
        label: u?.nombre || `Usuario ${String(userId).slice(0, 8)}`,
        messages: [],
        unread: 0,
      });
    }
    setActiveChatThread(key);
  }

  function refreshAfterParticipants() {
    refreshChatThreadPicker();
    renderChatThreadTabs();
  }

  function appendRecordingNotice(text) {
    ensureGeneralThread();
    const thread = chatThreads.get("general");
    if (!thread) return;
    thread.messages.push({
      mensajeId: "local-sys-" + Date.now(),
      contenido: text,
      tipo: "general",
      marcaTiempo: new Date().toISOString(),
      autor: { nombre: "Sala", usuarioId: null },
    });
    if (getSelfUserId() && shouldMarkUnread("general")) {
      thread.unread = (thread.unread || 0) + 1;
      emitNotify({ kind: "message", threadKey: "general" });
    }
    renderChatThreadTabs();
    renderChatMessages();
    deps?.log?.(text);
  }

  function renderChatQuickReactionBar() {
    const bar = $("chatQuickReactionBar");
    if (!bar) return;
    bar.innerHTML = "";
    const handleQuickReaction = (emoji) => {
      if (!deps?.getActiveRoomId?.()) return;
      const input = $("chatInput");
      const current = String(input?.value || "");
      if (!current.trim() && !pendingChatAdjunto) {
        sendChatMessageFromComposer(emoji);
        return;
      }
      if (!input) return;
      const start = Number.isFinite(input.selectionStart) ? input.selectionStart : current.length;
      const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : current.length;
      const next = current.slice(0, start) + emoji + current.slice(end);
      input.value = next;
      const pos = start + emoji.length;
      try {
        input.setSelectionRange(pos, pos);
      } catch (_) {}
      input.focus();
    };
    CHAT_REACTION_EMOJIS.forEach((emoji) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chat-quick-reaction-btn";
      b.textContent = emoji;
      b.title = `Agregar ${emoji}`;
      b.addEventListener("click", () => handleQuickReaction(emoji));
      bar.appendChild(b);
    });
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "chat-quick-reaction-btn";
    moreBtn.textContent = "...";
    moreBtn.title = "Más emojis";
    moreBtn.addEventListener("click", () => {
      const picker = document.createElement("div");
      picker.className = "chat-msg__react-picker open";
      CHAT_EXTRA_EMOJIS.forEach((emoji) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chat-msg__react-emoji";
        b.textContent = emoji;
        b.addEventListener("click", () => {
          handleQuickReaction(emoji);
          picker.remove();
        });
        picker.appendChild(b);
      });
      if (bar.querySelector(".chat-msg__react-picker")) {
        bar.querySelector(".chat-msg__react-picker")?.remove();
        return;
      }
      bar.appendChild(picker);
    });
    bar.appendChild(moreBtn);
  }

  async function uploadChatAdjuntoFile(file) {
    const activeRoomId = deps?.getActiveRoomId?.();
    if (!activeRoomId || !deps?.getToken?.()) throw new Error("Sin sala o sesión");
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(
      deps.toApiUrl(
        "/api/reuniones/room/" + encodeURIComponent(activeRoomId) + "/chat-adjunto"
      ),
      {
        method: "POST",
        headers: { Authorization: "Bearer " + deps.getToken() },
        body: fd,
      }
    );
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!r.ok) throw new Error(data.error || r.statusText || "Error al subir");
    return data;
  }

  function getFirstFileFromDataTransfer(dataTransfer) {
    if (!dataTransfer) return null;
    if (dataTransfer.files && dataTransfer.files.length) return dataTransfer.files[0];
    const items = dataTransfer.items;
    if (!items?.length) return null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file") {
        const f = it.getAsFile?.();
        if (f) return f;
      }
    }
    return null;
  }

  function getClipboardFile(dataTransfer) {
    return getFirstFileFromDataTransfer(dataTransfer);
  }

  function isChatPasteOrDropTarget(el) {
    return !!(el && el.closest && el.closest("#chatDropZone"));
  }

  function chatInputHasFocus() {
    const ci = $("chatInput");
    return !!(ci && document.activeElement === ci);
  }

  function clearPendingChatAdjunto() {
    pendingChatAdjunto = null;
    if (pendingChatPreviewUrl) {
      try {
        URL.revokeObjectURL(pendingChatPreviewUrl);
      } catch (_) {}
      pendingChatPreviewUrl = "";
    }
    updateChatAdjuntoPendingUi();
  }

  function openPendingAdjuntoCtx(clientX, clientY) {
    closeChatCtxMenu();
    const menu = $("chatCtxMenu");
    if (!menu || !pendingChatAdjunto?.adjuntoRelPath) return;
    const addItem = (label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
        closeChatCtxMenu();
      });
      menu.appendChild(b);
    };
    addItem("Copiar nombre de archivo", () => {
      void deps?.copyTextToClipboard?.(pendingChatAdjunto.adjuntoNombreOriginal || "");
    });
    addItem("Quitar adjunto", () => clearPendingChatAdjunto());
    menu.classList.add("chat-ctx--open");
    menu.setAttribute("aria-hidden", "false");
    const mw = 200;
    const mh = 120;
    let x = clientX;
    let y = clientY;
    if (x + mw > window.innerWidth - 6) x = window.innerWidth - mw - 6;
    if (y + mh > window.innerHeight - 6) y = window.innerHeight - mh - 6;
    menu.style.left = Math.max(6, x) + "px";
    menu.style.top = Math.max(6, y) + "px";
  }

  function updateChatAdjuntoPendingUi() {
    const el = $("chatAdjuntoPending");
    if (!el) return;
    el.innerHTML = "";
    if (pendingChatAdjunto?.adjuntoRelPath) {
      const name = pendingChatAdjunto.adjuntoNombreOriginal || "archivo";
      const head = document.createElement("div");
      head.style.display = "flex";
      head.style.alignItems = "flex-start";
      head.style.justifyContent = "space-between";
      head.style.gap = "8px";
      head.style.width = "100%";
      head.style.boxSizing = "border-box";
      const cap = document.createElement("span");
      cap.style.fontSize = "0.82rem";
      cap.style.wordBreak = "break-word";
      cap.textContent = "📎 Pendiente: " + name + " · pulsa Enviar";
      const xbtn = document.createElement("button");
      xbtn.type = "button";
      xbtn.className = "chat-msg__del";
      xbtn.title = "Quitar adjunto";
      xbtn.setAttribute("aria-label", "Quitar adjunto");
      xbtn.textContent = "×";
      xbtn.addEventListener("click", (e) => {
        e.preventDefault();
        clearPendingChatAdjunto();
      });
      head.appendChild(cap);
      head.appendChild(xbtn);
      el.appendChild(head);
      if (pendingChatPreviewUrl) {
        const shell = document.createElement("div");
        shell.style.marginTop = "6px";
        shell.style.position = "relative";
        shell.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          openPendingAdjuntoCtx(e.clientX, e.clientY);
        });
        const wrap = document.createElement("div");
        wrap.className = "chat-adjunto-preview";
        const mime = String(pendingChatAdjunto.adjuntoMime || "").toLowerCase();
        if (mime.startsWith("image/")) {
          const img = document.createElement("img");
          img.alt = name;
          img.src = pendingChatPreviewUrl;
          wrap.appendChild(img);
        } else if (mime.startsWith("video/")) {
          const vid = document.createElement("video");
          vid.controls = true;
          vid.preload = "metadata";
          vid.src = pendingChatPreviewUrl;
          wrap.appendChild(vid);
        } else if (mime.startsWith("audio/")) {
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.preload = "metadata";
          audio.src = pendingChatPreviewUrl;
          wrap.appendChild(audio);
        } else if (mime.includes("pdf")) {
          const emb = document.createElement("embed");
          emb.type = "application/pdf";
          emb.src = pendingChatPreviewUrl + "#page=1&view=FitH";
          wrap.appendChild(emb);
        }
        shell.appendChild(wrap);
        el.appendChild(shell);
      }
    } else if (pendingChatPreviewUrl) {
      URL.revokeObjectURL(pendingChatPreviewUrl);
      pendingChatPreviewUrl = "";
    }
  }

  async function uploadPendingChatFile(file) {
    if (!file) return;
    const activeRoomId = deps?.getActiveRoomId?.();
    if (!activeRoomId) {
      deps?.log?.("Entra en una sala antes de adjuntar archivos.");
      return;
    }
    if (!deps?.getToken?.()) {
      deps?.log?.("Sesión requerida: inicia sesión para adjuntar archivos.");
      deps?.setMediaStatus?.("Inicia sesión para adjuntar.");
      return;
    }
    deps?.setMediaStatus?.("Subiendo adjunto…");
    if (pendingChatPreviewUrl) {
      URL.revokeObjectURL(pendingChatPreviewUrl);
      pendingChatPreviewUrl = "";
    }
    try {
      const data = await uploadChatAdjuntoFile(file);
      const ft = String(file.type || "").toLowerCase();
      if (
        ft.startsWith("image/") ||
        ft.startsWith("video/") ||
        ft.startsWith("audio/") ||
        ft.includes("pdf")
      ) {
        pendingChatPreviewUrl = URL.createObjectURL(file);
      }
      pendingChatAdjunto = {
        adjuntoRelPath: data.adjuntoRelPath,
        adjuntoNombreOriginal: data.adjuntoNombreOriginal || file.name || "archivo",
        adjuntoMime: data.adjuntoMime,
        adjuntoBytes: data.adjuntoBytes,
      };
      updateChatAdjuntoPendingUi();
      deps?.setMediaStatus?.("Adjunto listo. Pulsa Enviar (el mensaje de texto es opcional).");
    } catch (e) {
      pendingChatAdjunto = null;
      if (pendingChatPreviewUrl) {
        URL.revokeObjectURL(pendingChatPreviewUrl);
        pendingChatPreviewUrl = "";
      }
      updateChatAdjuntoPendingUi();
      deps?.log?.("Adjunto: " + (e?.message || String(e)));
      deps?.setMediaStatus?.(e?.message || "Error al subir adjunto");
    }
  }

  function sendChatMessageFromComposer(forcedContent = null) {
    const raw =
      forcedContent != null ? String(forcedContent) : String($("chatInput")?.value || "");
    const contenido = raw.trim();
    const socket = deps?.getSocket?.();
    const activeRoomId = deps?.getActiveRoomId?.();
    if ((!contenido && !pendingChatAdjunto) || !activeRoomId || !socket) return;
    const dmTarget = resolveDmTargetForSend();
    const active =
      dmTarget?.thread || chatThreads.get(activeChatThreadKey) || chatThreads.get("general");
    const payload = {
      roomId: deps.normRoomKey(activeRoomId),
      contenido,
      tipo: "general",
      ...(pendingChatAdjunto || {}),
    };
    if (dmTarget?.peerId) {
      payload.tipo = "privado";
      payload.destinatarioUsuarioId = dmTarget.peerId;
    }
    const input = $("chatInput");
    const onAck = (err, r) => {
      const ackErr = err && typeof err === "object" && err.message ? err : null;
      const resp = r !== undefined ? r : !ackErr && err && typeof err === "object" && "ok" in err ? err : r;
      if (ackErr) {
        deps?.setMediaStatus?.("Tiempo de espera agotado al enviar el mensaje");
        deps?.log?.("Chat: timeout al enviar");
        return;
      }
      if (resp && !resp.ok) {
        deps?.setMediaStatus?.(resp.error || "No se pudo enviar el mensaje");
        deps?.log?.("Chat: " + (resp.error || "error"));
        return;
      }
      if (input) input.value = "";
      pendingChatAdjunto = null;
      updateChatAdjuntoPendingUi();
      deps?.setMediaStatus?.("");
    };
    if (socket.timeout) {
      socket.timeout(8000).emit("chat:message", payload, onAck);
    } else {
      socket.emit("chat:message", payload, (r) => onAck(null, r));
    }
  }

  function openChatFromBar() {
    deps?.setChatPanelHidden?.(false);
    let bestKey = activeChatThreadKey || "general";
    let bestUnread = 0;
    chatThreads.forEach((t, k) => {
      const u = Number(t.unread) || 0;
      if (u > bestUnread) {
        bestUnread = u;
        bestKey = k;
      }
    });
    setActiveChatThread(bestKey);
  }

  function resetRoomChat() {
    markAllRead();
    clearPendingChatAdjunto();
    for (const u of chatAdjuntoPreviewCache.values()) {
      try {
        URL.revokeObjectURL(u);
      } catch (_) {}
    }
    chatAdjuntoPreviewCache.clear();
    $("chatBox") && ($("chatBox").innerHTML = "");
    chatThreads.clear();
    ensureGeneralThread();
    activeChatThreadKey = "general";
    refreshChatThreadPicker();
    renderChatThreadTabs();
    $("chatDropZone")?.classList.remove("chat-drop-zone--over");
  }

  function bindComposer() {
    if (composerBound) return;
    composerBound = true;

    $("btnEnviarChat")?.addEventListener("click", () => sendChatMessageFromComposer());
    $("chatInput")?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      sendChatMessageFromComposer();
    });

    $("btnChatAdjunto")?.addEventListener("click", () => {
      if (!deps?.getActiveRoomId?.()) {
        deps?.log?.("Entra en una sala antes de adjuntar archivos.");
        return;
      }
      $("chatAdjuntoInput")?.click();
    });

    $("chatAdjuntoInput")?.addEventListener("change", async () => {
      const inp = $("chatAdjuntoInput");
      const file = inp?.files?.[0];
      if (inp) inp.value = "";
      if (!deps?.getActiveRoomId?.()) {
        deps?.log?.("Entra en una sala antes de adjuntar archivos.");
        return;
      }
      if (!file) return;
      await uploadPendingChatFile(file);
    });

    const z = $("chatDropZone");
    if (z) {
      z.addEventListener("dragenter", (e) => {
        if (!deps?.getActiveRoomId?.()) return;
        e.preventDefault();
      });
      z.addEventListener("dragover", (e) => {
        if (!deps?.getActiveRoomId?.()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        z.classList.add("chat-drop-zone--over");
      });
      z.addEventListener("dragleave", (e) => {
        if (!z.contains(e.relatedTarget)) z.classList.remove("chat-drop-zone--over");
      });
      z.addEventListener("drop", async (e) => {
        e.preventDefault();
        z.classList.remove("chat-drop-zone--over");
        if (!deps?.getActiveRoomId?.()) {
          deps?.log?.("Entra en una sala antes de adjuntar archivos.");
          return;
        }
        const f = getFirstFileFromDataTransfer(e.dataTransfer);
        if (!f) {
          deps?.log?.(
            "Soltar: no se recibió ningún archivo (algunos orígenes no envían el fichero al navegador). Prueba Adjunto o arrastra desde el Explorador de archivos."
          );
          deps?.setMediaStatus?.("No se pudo leer el archivo al soltar.");
          return;
        }
        await uploadPendingChatFile(f);
      });
    }

    $("chatThreadPicker")?.addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "general") {
        setActiveChatThread("general");
        return;
      }
      openDmThreadByUserId(val);
      e.target.value = "general";
    });
  }

  /**
   * @param {object} hooks
   */
  function initChatRoom(hooks) {
    deps = hooks || null;
    ensureGeneralThread();
    bindComposer();
    renderChatQuickReactionBar();
  }

  global.ChatModule = {
    initChatRoom,
    getChatThreads,
    getActiveChatThreadKey,
    appendChatLine,
    onIncomingMessage,
    onIncomingReaction,
    onActiveThreadChanged,
    markAllRead,
    markThreadRead,
    appendRecordingNotice,
    removeChatMessageEverywhere,
    setActiveChatThread,
    openDmThreadByUserId,
    openChatFromBar,
    refreshAfterParticipants,
    resetRoomChat,
    renderChatQuickReactionBar,
    renderChatThreadTabs,
    renderChatMessages,
    uploadPendingChatFile,
    getClipboardFile,
    isChatPasteOrDropTarget,
    chatInputHasFocus,
    closeChatCtxMenu,
    clearPendingChatAdjunto,
    shouldMarkUnread,
    sameUserId,
    emitNotify,
    emitRead,
    EVENT_NOTIFY,
    EVENT_READ,
  };
})(typeof window !== "undefined" ? window : globalThis);
