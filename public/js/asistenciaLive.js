/**
 * Asistencia en vivo: escucha attendance:* y actualiza UI del lobby/sala.
 * Las reglas de copresencia viven solo en el servidor (copresencia.js).
 */
(function (global) {
  let socketRef = null;
  let getSelectedReunionId = () => null;
  let onFulfilledRefresh = null;
  let subscribedReunionId = null;
  let fulfillDebounceTimer = null;
  /** Último payload attendance:copresence (misma reunión) para enriquecer impresión. */
  let lastCopresencePayload = null;

  function formatMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return "0:00";
    const totalSec = Math.floor(n / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function updateLobbyBadge(payload) {
    const el = document.getElementById("homeAttendanceLiveBadge");
    if (!el || !payload) return;
    const sel = getSelectedReunionId();
    if (!sel || String(payload.reunionId) !== String(sel)) {
      el.classList.add("hidden");
      return;
    }
    const parts = [];
    if (payload.sessionActive) parts.push("En sesión");
    if (payload.teacherPresent) parts.push("Docente presente");
    if (payload.studentPresent) parts.push("Estudiante presente");
    if (payload.copresenceActive) parts.push("Copresencia activa");
    if (payload.fulfilled) parts.push("Umbral cumplido");
    if (!parts.length) {
      el.classList.add("hidden");
      return;
    }
    el.textContent = parts.join(" · ");
    el.classList.remove("hidden");
  }

  function updateMeetCopresence(payload) {
    const el = document.getElementById("meetAttendanceCopresence");
    if (!el) return;
    if (!payload) {
      el.classList.add("hidden");
      return;
    }
    const prog = formatMs(payload.acumuladoMs);
    const goal = formatMs(payload.umbralMs);
    let text = `Copresencia: ${prog} / ${goal}`;
    if (payload.copresenceActive) text += " · activa";
    if (payload.fulfilled) text += " · umbral cumplido";
    el.textContent = text;
    el.classList.remove("hidden");
  }

  function subscribe(reunionId) {
    if (!socketRef?.connected || !reunionId) return;
    const rid = String(reunionId);
    if (subscribedReunionId && subscribedReunionId !== rid) {
      socketRef.emit("attendance:unsubscribe", { reunionId: subscribedReunionId });
    }
    subscribedReunionId = rid;
    socketRef.emit("attendance:subscribe", { reunionId: rid }, (resp) => {
      if (resp?.ok && resp.snapshot) {
        updateLobbyBadge({ ...resp.snapshot, reunionId: rid });
        if (resp.snapshot.acumuladoMs != null) {
          updateMeetCopresence({
            reunionId: rid,
            acumuladoMs: resp.snapshot.acumuladoMs,
            umbralMs: resp.snapshot.umbralMs,
            copresenceActive: resp.snapshot.copresenceActive,
            fulfilled: resp.snapshot.fulfilled,
          });
        }
      }
    });
  }

  function unsubscribe() {
    if (socketRef?.connected && subscribedReunionId) {
      socketRef.emit("attendance:unsubscribe", { reunionId: subscribedReunionId });
    }
    subscribedReunionId = null;
    const badge = document.getElementById("homeAttendanceLiveBadge");
    if (badge) badge.classList.add("hidden");
  }

  function attachSocketHandlers(socket) {
    if (!socket) return;
    socket.off("attendance:presence");
    socket.off("attendance:copresence");
    socket.off("attendance:fulfilled");
    socket.on("attendance:presence", (p) => updateLobbyBadge(p));
    socket.on("attendance:copresence", (p) => {
      lastCopresencePayload = p && p.reunionId != null ? { ...p } : null;
      updateMeetCopresence(p);
      const sel = getSelectedReunionId();
      if (sel && String(p.reunionId) === String(sel)) {
        updateLobbyBadge({
          reunionId: p.reunionId,
          sessionActive: true,
          teacherPresent: p.copresenceActive,
          studentPresent: p.copresenceActive,
          copresenceActive: p.copresenceActive,
          fulfilled: p.fulfilled,
        });
      }
    });
    socket.on("attendance:fulfilled", (p) => {
      const sel = getSelectedReunionId();
      if (!sel || String(p.reunionId) !== String(sel)) return;
      updateLobbyBadge({
        reunionId: p.reunionId,
        sessionActive: true,
        fulfilled: true,
        copresenceActive: true,
        teacherPresent: true,
        studentPresent: true,
      });
      if (fulfillDebounceTimer) clearTimeout(fulfillDebounceTimer);
      fulfillDebounceTimer = setTimeout(() => {
        fulfillDebounceTimer = null;
        if (onFulfilledRefresh) onFulfilledRefresh(p.reunionId);
      }, 400);
    });
  }

  function init(opts) {
    getSelectedReunionId = opts.getSelectedReunionId || (() => null);
    onFulfilledRefresh = opts.onFulfilledRefresh || null;
    if (opts.socket) setSocket(opts.socket);
  }

  function setSocket(socket) {
    socketRef = socket;
    if (socket) attachSocketHandlers(socket);
    if (subscribedReunionId && socket?.connected) subscribe(subscribedReunionId);
  }

  function getLastCopresenceSnapshot() {
    return lastCopresencePayload ? { ...lastCopresencePayload } : null;
  }

  global.AsistenciaLive = {
    init,
    setSocket,
    subscribe,
    unsubscribe,
    formatMs,
    getLastCopresenceSnapshot,
  };
})(typeof window !== "undefined" ? window : globalThis);
