/**
 * calendarController.js — calendario del lobby (migración por pasos).
 * Paso 1: estado de reuniones + carga desde GET /api/reuniones/mis.
 * La orquestación post-carga (asistencia, render) permanece en callbacks del index.
 *
 * @see README-dev.md → «calendarController.js (migración)»
 */
(function (global) {
  /** @type {Array<object>} */
  let meetings = [];

  function getMeetings() {
    return meetings;
  }

  function setMeetings(next) {
    meetings = Array.isArray(next) ? next : [];
  }

  /**
   * Recarga la lista de reuniones del usuario.
   * @param {{
   *   getToken: () => string | null,
   *   api: (path: string, opts?: object) => Promise<any>,
   *   onNoToken: () => void | Promise<void>,
   *   onAfterLoad: (meetings: object[]) => void | Promise<void>,
   * }} hooks
   */
  async function loadHomeMeetings(hooks) {
    if (!hooks || typeof hooks.getToken !== "function" || typeof hooks.api !== "function") {
      throw new Error("CalendarController.loadHomeMeetings: hooks inválidos");
    }
    setMeetings([]);
    if (!hooks.getToken()) {
      await Promise.resolve(hooks.onNoToken && hooks.onNoToken());
      return;
    }
    try {
      const data = await hooks.api("/api/reuniones/mis");
      setMeetings(Array.isArray(data && data.reuniones) ? data.reuniones : []);
    } catch (_) {
      setMeetings([]);
    } finally {
      await Promise.resolve(hooks.onAfterLoad && hooks.onAfterLoad(getMeetings()));
    }
  }

  /** Reservado para pasos posteriores (historial, impresión, etc.). */
  function initStep1() {
    return { ok: true, step: 1 };
  }

  global.CalendarController = {
    initStep1,
    getMeetings,
    setMeetings,
    loadHomeMeetings,
  };
})(typeof window !== "undefined" ? window : globalThis);
