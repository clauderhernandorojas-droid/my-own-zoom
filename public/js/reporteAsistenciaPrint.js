/**
 * Fetch y HTML de reporte de asistencia (BD + live opcional) para impresión.
 */
(function (global) {
  let apiFn = null;
  let escapeHtml = (s) => String(s ?? "");

  function formatMs(ms) {
    if (global.AsistenciaLive && typeof global.AsistenciaLive.formatMs === "function") {
      return global.AsistenciaLive.formatMs(ms);
    }
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return "0:00";
    const totalSec = Math.floor(n / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function calendarRangeIso(viewDate) {
    const ref = viewDate instanceof Date && !Number.isNaN(viewDate.getTime()) ? viewDate : new Date();
    const y = ref.getFullYear();
    const mo = ref.getMonth();
    const desde = new Date(y, mo, 1, 0, 0, 0, 0).toISOString();
    const hasta = new Date(y, mo + 2, 0, 23, 59, 59, 999).toISOString();
    return { desde, hasta };
  }

  /**
   * @param {string} reunionId
   * @param {{ desde: string, hasta: string, live?: string }} range
   */
  async function fetchReporte(reunionId, range) {
    if (!apiFn || !reunionId) return null;
    const q = new URLSearchParams();
    if (range?.desde) q.set("desde", range.desde);
    if (range?.hasta) q.set("hasta", range.hasta);
    if (range?.live != null) q.set("live", String(range.live));
    else q.set("live", "1");
    if (range?.metrics != null) q.set("metrics", String(range.metrics));
    const qs = q.toString();
    const path = `/api/reuniones/${encodeURIComponent(String(reunionId))}/asistencia/reporte${qs ? `?${qs}` : ""}`;
    return apiFn(path);
  }

  function estadoLabel(estado) {
    const e = String(estado || "").toLowerCase();
    if (e === "asistio") return "Asistió";
    if (e === "futuro") return "Programado";
    if (e === "ausente") return "Ausente";
    if (e === "sin_registro") return "Sin registro";
    return estado || "—";
  }

  function buildSummaryHtml(reportPayload) {
    if (!reportPayload?.basic) return "";
    const resumen = reportPayload.basic.resumen;
    const filas = Array.isArray(resumen?.filas) ? resumen.filas : [];
    let html = `<section class="print-report-summary" aria-label="Resumen de asistencia">`;
    html += `<h2 class="print-report-summary__title">Registrado en base de datos</h2>`;
    if (!filas.length) {
      html += `<p class="print-report-summary__empty">No hay filas de resumen en el rango seleccionado.</p>`;
    } else {
      html += `<table class="print-report-table"><thead><tr>`;
      html += `<th>Participante</th><th>Estado</th><th>Entrada</th><th>Salida</th><th>Asistió</th>`;
      html += `</tr></thead><tbody>`;
      for (const f of filas) {
        const ent = f.entradaAt ? new Date(f.entradaAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" }) : "—";
        const sal = f.salidaAt ? new Date(f.salidaAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" }) : "—";
        html += `<tr><td>${escapeHtml(f.nombre || f.email || f.usuarioId || "—")}</td>`;
        html += `<td>${escapeHtml(estadoLabel(f.estado))}</td>`;
        html += `<td>${escapeHtml(ent)}</td><td>${escapeHtml(sal)}</td>`;
        html += `<td>${f.asistio ? "Sí" : "No"}</td></tr>`;
      }
      html += `</tbody></table>`;
    }

    const live = reportPayload.live;
    if (live && live.enabled && live.included) {
      html += `<h2 class="print-report-summary__title">Instantánea en sala (RAM)</h2>`;
      html += `<p class="print-report-summary__note">No sustituye el historial en base de datos. Puede variar si hay varias instancias del servidor.</p>`;
      const snap = live.snapshot;
      const clientSnap =
        global.AsistenciaLive && typeof global.AsistenciaLive.getLastCopresenceSnapshot === "function"
          ? global.AsistenciaLive.getLastCopresenceSnapshot()
          : null;
      const useSnap =
        snap && (snap.sessionActive || snap.acumuladoMs > 0)
          ? snap
          : clientSnap && String(clientSnap.reunionId) === String(reportPayload.reunionId)
            ? clientSnap
            : snap;
      if (!useSnap || (!useSnap.sessionActive && !useSnap.acumuladoMs)) {
        html += `<p class="print-report-summary__empty">No hay sesión activa en este momento.</p>`;
      } else {
        const prog = formatMs(useSnap.acumuladoMs);
        const goal = formatMs(useSnap.umbralMs);
        html += `<ul class="print-report-live-list">`;
        html += `<li>Copresencia acumulada: <strong>${escapeHtml(prog)}</strong> / umbral <strong>${escapeHtml(goal)}</strong></li>`;
        html += `<li>Umbral cumplido: <strong>${useSnap.fulfilled ? "Sí" : "No"}</strong></li>`;
        html += `<li>Docente presente: <strong>${useSnap.teacherPresent ? "Sí" : "No"}</strong> · Estudiante presente: <strong>${useSnap.studentPresent ? "Sí" : "No"}</strong></li>`;
        html += `<li>Copresencia activa ahora: <strong>${useSnap.copresenceActive ? "Sí" : "No"}</strong></li>`;
        html += `</ul>`;
      }
    }

    html += `</section>`;
    return html;
  }

  function resolveUserLabel(userId, reportPayload) {
    const filas = reportPayload?.basic?.resumen?.filas;
    if (Array.isArray(filas)) {
      const f = filas.find((row) => String(row.usuarioId) === String(userId));
      if (f) return f.nombre || f.email || String(userId);
    }
    return String(userId);
  }

  function buildSessionMetricsHtml(reportPayload) {
    const m = reportPayload?.metrics;
    if (!m || !m.enabled || !m.included) return "";
    const session = m.session;
    if (!session || typeof session !== "object") return "";

    const teacherMs = Number(session.teacherPresenceMs) || 0;
    const copresenceMs = Number(session.copresenceMs) || 0;
    const umbralMs = Number(session.umbralMs) || 0;

    const source = session.source === "db" ? "db" : "ram";
    const persistedAt = session.persistedAt ? String(session.persistedAt) : "";
    const selectedBy = session.selectedBy ? String(session.selectedBy) : "";

    let html = `<section class="print-report-summary print-report-session-metrics" aria-label="Métricas de sesión">`;
    html += `<h2 class="print-report-summary__title">Métricas de sesión</h2>`;
    if (source === "db") {
      html += `<p class="print-report-summary__note">Origen: <strong>base de datos</strong>`;
      if (persistedAt) {
        html += ` · Persistido: <strong>${escapeHtml(persistedAt)}</strong>`;
      }
      if (selectedBy) {
        html += ` · Selección: <strong>${escapeHtml(selectedBy)}</strong>`;
      }
      html += `.</p>`;
    } else {
      html += `<p class="print-report-summary__note">Origen: <strong>RAM</strong> (memoria del proceso actual). Pueden ser 0 si no hubo sala activa en este servidor.</p>`;
    }
    html += `<ul class="print-report-live-list">`;
    html += `<li>Tiempo con docente presente: <strong>${escapeHtml(formatMs(teacherMs))}</strong></li>`;
    html += `<li>Copresencia acumulada (docente + estudiante): <strong>${escapeHtml(formatMs(copresenceMs))}</strong> / umbral <strong>${escapeHtml(formatMs(umbralMs))}</strong></li>`;
    html += `<li>Umbral copresencia cumplido: <strong>${session.fulfilled ? "Sí" : "No"}</strong></li>`;
    html += `<li>Docente presente ahora: <strong>${session.teacherPresent ? "Sí" : "No"}</strong> · Copresencia activa ahora: <strong>${session.copresenceActive ? "Sí" : "No"}</strong></li>`;
    html += `</ul>`;
    if (session.adminView) {
      html += `<p class="print-report-summary__note">Vista administrador (máxima copresencia o fila representativa).</p>`;
    }
    if (session.adminOverride) {
      html += `<p class="print-report-summary__note">Vista como solicitante (admin con asRequester).</p>`;
    }
    html += `</section>`;
    return html;
  }

  function buildMetricsHtml(reportPayload) {
    const m = reportPayload?.metrics;
    if (!m || !m.enabled || !m.included) return "";
    const chat = m.participation?.chatByUser;
    if (!Array.isArray(chat)) return "";

    let html = `<section class="print-report-summary print-report-metrics" aria-label="Métricas de participación">`;
    html += `<h2 class="print-report-summary__title">Mensajes por usuario</h2>`;
    html += `<p class="print-report-summary__note">Solo conteos en el período de la sesión; no se incluye el texto de los mensajes.</p>`;
    if (!chat.length) {
      html += `<p class="print-report-summary__empty">No hay mensajes en el período considerado.</p>`;
    } else {
      html += `<table class="print-report-table"><thead><tr><th>Usuario</th><th>Mensajes</th></tr></thead><tbody>`;
      for (const row of chat) {
        html += `<tr><td>${escapeHtml(resolveUserLabel(row.userId, reportPayload))}</td>`;
        html += `<td>${escapeHtml(String(row.count))}</td></tr>`;
      }
      html += `</tbody></table>`;
    }
    html += `</section>`;
    return html;
  }

  function init(opts) {
    apiFn = opts.api || null;
    if (typeof opts.escapeHtml === "function") escapeHtml = opts.escapeHtml;
  }

  global.ReporteAsistenciaPrint = {
    init,
    fetchReporte,
    buildSummaryHtml,
    buildSessionMetricsHtml,
    buildMetricsHtml,
    calendarRangeIso,
    formatMs,
  };
})(typeof window !== "undefined" ? window : globalThis);
