/**
 * calendarController.js — calendario del lobby (migración por pasos).
 * Paso 1: estado de reuniones + carga desde GET /api/reuniones/calendario.
 * Buckets de Acciones rápidas: GET /api/reuniones/mis → proximas / anteriores.
 * La orquestación post-carga (asistencia, render) permanece en callbacks del index.
 *
 * @see README-dev.md → «calendarController.js (migración)»
 */
(function (global) {
  /** @type {Array<object>} */
  let meetings = [];
  /** @type {Array<object>} */
  let misProximas = [];
  /** @type {Array<object>} */
  let misAnteriores = [];

  function getMeetings() {
    return meetings;
  }

  function setMeetings(next) {
    meetings = Array.isArray(next) ? next : [];
  }

  function getMisProximas() {
    return misProximas;
  }

  function getMisAnteriores() {
    return misAnteriores;
  }

  function setMisBuckets(proximas, anteriores) {
    misProximas = Array.isArray(proximas) ? proximas : [];
    misAnteriores = Array.isArray(anteriores) ? anteriores : [];
  }

  /**
   * Recarga la lista completa de reuniones para calendario/modal/asistencia.
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
      const data = await hooks.api("/api/reuniones/calendario");
      setMeetings(Array.isArray(data && data.reuniones) ? data.reuniones : []);
    } catch (_) {
      setMeetings([]);
    } finally {
      await Promise.resolve(hooks.onAfterLoad && hooks.onAfterLoad(getMeetings()));
    }
  }

  /**
   * Recarga buckets de Acciones rápidas (≤10 próximas, ≤10 anteriores).
   * @param {{
   *   getToken: () => string | null,
   *   api: (path: string, opts?: object) => Promise<any>,
   * }} hooks
   */
  async function loadHomeMisBuckets(hooks) {
    if (!hooks || typeof hooks.getToken !== "function" || typeof hooks.api !== "function") {
      throw new Error("CalendarController.loadHomeMisBuckets: hooks inválidos");
    }
    if (!hooks.getToken()) {
      setMisBuckets([], []);
      return;
    }
    try {
      const data = await hooks.api("/api/reuniones/mis");
      setMisBuckets(
        Array.isArray(data && data.proximas) ? data.proximas : [],
        Array.isArray(data && data.anteriores) ? data.anteriores : []
      );
    } catch (_) {
      setMisBuckets([], []);
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
    getMisProximas,
    getMisAnteriores,
    setMisBuckets,
    loadHomeMeetings,
    loadHomeMisBuckets,
  };
})(typeof window !== "undefined" ? window : globalThis);
