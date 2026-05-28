# README de desarrollo — My Own Zoom

Briefing para retomar el trabajo en Cursor sin perder contexto. **Actualizar este archivo al cerrar una sesión** cuando cambie el esquema, la API, scripts de BD o decisiones de producto.

---

## 1. Resumen del estado actual

### Backend (`server.js`)

- Tras `sequelize.sync()`, arranque **SQLite / excepciones de agenda**: `ensureReunionExceptionColumns()` añade si faltan `parent_reunion_id`, `es_excepcion`, `occurrence_day_key`; en SQLite elimina índices únicos conflictivos sobre `room_id` y ejecuta **`repairSqliteReunionGhostReferences()`** (`src/services/sqliteReunionSchemaRepair.js`) para limpiar referencias huérfanas tras migraciones manuales.
- Helpers adicionales antes del `sync()`: columnas de invitados/solicitudes de acceso, esquema de **`reunion_asistencia`** (elimina tabla legacy incompatible si aplica).
- **Express** en el mismo proceso HTTP que **Socket.io** (mismo puerto; por defecto `3000`).
- **CORS** abierto para desarrollo; **JSON** body parser.
- Rutas bajo `/api`: autenticación, usuarios, reuniones, mensajes (ver `src/routes/`). Resolución de reunión por sala: **`findReunionByRoomKey`** en `src/services/reunionByRoom.js` (uso en rutas de reunión, adjuntos de chat y socket).
- **Health**: `GET /health` (en desarrollo incluye `copresenciaUmbralMs`, `asistenciaMetricasEnabled`, `asistenciaPersistenceEnabled`).
- **Historial de agenda (cliente)**: `GET /js/historialAcciones.js` sirve `src/services/historialAcciones.js` (pilas deshacer/rehacer en el navegador; sin persistencia en servidor).
- **WebRTC / ICE**: `GET /api/rtc/config` — STUN desde `STUN_URLS` o por defecto Google; TURN opcional vía `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
- **Estáticos**: `public/`; la raíz sirve `public/index.html`.
- **Base de datos**: Sequelize. Sin `DATABASE_URL` → **SQLite** en `data/app.sqlite`. Con `DATABASE_URL` → **PostgreSQL**.
- **Adjuntos de chat (archivos)**: `multer` escribe en `data/chat-adjuntos/<reunionId>/` (carpeta `data/` en `.gitignore`). **`POST /api/reuniones/room/:roomId/chat-adjunto`** con `multipart/form-data`, campo **`file`**, máximo **20 MB** y extensiones acotadas en `src/services/chatAdjuntos.js`. La subida **no** crea fila en `mensajes`: el cliente envía luego **`chat:message`** por Socket con `adjuntoRelPath`, `adjuntoNombreOriginal`, `adjuntoMime`, `adjuntoBytes`. Descarga autenticada: **`GET /api/mensajes/adjunto/:mensajeId`**.
- **Borrado de mensajes**: **`DELETE /api/mensajes/:mensajeId`** — autor o admin; elimina adjunto en disco si existe; emite por Socket **`chat:messageDeleted`** (`mensajeId`). Sala general: broadcast a la room; mensaje **privado**: solo sockets del autor y del destinatario.
- **`app.set('io', io)`** en `server.js` para que las rutas REST puedan emitir eventos Socket tras mutaciones (p. ej. borrado de chat).
- **Arranque BD**: tras `sequelize.sync()` se ejecuta **`ensureMensajeAdjuntoColumns()`** (añade columnas de adjunto en `mensajes` si faltan) para no depender de `sync({ alter: true })` global (evita errores con tablas auxiliares SQLite como backups).

### Persistencia y esquema

- Modelos en `src/models/`: `Usuario`, `Reunion`, `Participa`, `Mensaje`, `Tablero`, **`ReunionAsistencia`**, **`ReunionOcurrencia`**, **`ReunionInvitado`**, **`ReunionSolicitudAcceso`** y asociaciones en `src/models/index.js` (incluye relaciones padre/hijo de **excepciones de serie**).
- **Modelo `Reunion` (`reuniones`)**: las columnas reales en SQLite/Postgres son `creado_en` y `actualizado_en` (no `createdAt`/`updatedAt` en BD). El modelo declara atributos `createdAt`/`updatedAt` con `field: 'creado_en'` / `'actualizado_en'` y tiene **`timestamps: false`** para que Sequelize no gestione timestamps automáticos ni genere SQL con nombres de columna incorrectos.
- **Asistencia / copresencia**: filas en `reunion_asistencia` (entrada/salida por usuario y reunión); copresencia en memoria en `src/services/copresencia.js` (umbral configurable). Al `room:join` / `room:leave` el socket delega en `src/services/asistencia.js` (`registrarEntradaStub` / `registrarSalidaStub`) sin alterar la lógica interna de copresencia.
- **Ocurrencias de serie**: overrides de fecha por instancia en `reunion_ocurrencia` (`occurrenceId` UUID o legacy `t_<epochMs>`); servicio `src/services/reuniones.js` (`reagendarOcurrencia`). Además, excepciones/omisiones con filas `esExcepcion` + `occurrenceDayKey` en `reuniones`.
- **Importante:** el esquema base se aplica con **`sequelize.sync()`** al iniciar (`server.js`); las columnas nuevas de adjuntos en `mensajes` se completan con el helper anterior. **No** hay carpeta de migraciones `sequelize-cli` versionada en este repo en el estado auditado.

#### Asistencia y copresencia

**Asistencia básica (siempre activa)**

| Pieza | Archivo | Rol |
|-------|---------|-----|
| Persistencia entrada/salida | [`src/services/asistencia.js`](src/services/asistencia.js) | `reunion_asistencias`: `entradaAt`, `salidaAt`, `presente`, `asistio` |
| Acumulación copresencia (RAM) | [`src/services/copresencia.js`](src/services/copresencia.js) | `accumulatedMs` + tramo abierto; **no** hay columna `copresenceMs` en BD |
| Flush `asistio` | `calcularCopresencia` | Tras `room:leave`, `POST .../asistencia/salida` o al listar resumen en `GET .../asistencia` |
| Socket persistencia | [`src/socket/index.js`](src/socket/index.js) | `room:join` → `registrarEntradaStub`; `room:leave` → `registrarSalidaStub` + flush |
| Calendario (colores) | [`public/index.html`](public/index.html) | `loadAsistenciaForCalendar` + `sessionKindForOccurrence` → azul/verde/rojo |

**Reglas de copresencia:** tiempo en que coexisten ≥1 participante con rol bucket **docente** y ≥1 **estudiante** en la misma clave `(reunionId, inicioSesion)`. Umbral: `ASISTENCIA_COPRESENCIA_MS_MIN` (default 3 600 000 ms). Estudiantes: `asistio` en BD solo si hubo `entradaAt` y copresencia ≥ umbral; docentes: `asistio` con solo `entradaAt`.

**Eventos Socket (no confundir):**

| Evento | Dominio |
|--------|---------|
| `room:join` / `room:leave` | Persistencia asistencia + copresencia |
| `presence:join` / `presence:leave` | WebRTC/chat en sala; **no** actualiza calendario |
| `room:entry:*` | Sala de espera ([`src/socket/asistenciaSocket.js`](src/socket/asistenciaSocket.js)) |
| `attendance:*` | Asistencia en vivo (solo si `ASISTENCIA_LIVE_ENABLED=true`) |

**Limitación conocida:** en `room:join`, `inicioSesion` se toma de `reunion.fechaHora` (ancla de la serie), no de la ocurrencia concreta del día en reuniones recurrentes.

**Asistencia avanzada en tiempo real** (`ASISTENCIA_LIVE_ENABLED=true`)

| Paso | Implementación |
|------|----------------|
| Indicadores en vivo | `attendance:presence` — En sesión, docente/estudiante presente, copresencia activa |
| Contador | `attendance:copresence` cada ~8 s en sala + `GET /api/reuniones/:id/asistencia/live` |
| Umbral en vivo | `attendance:fulfilled` + `maybeFlushIfThresholdMet` (flush anticipado idempotente) |
| Cliente | [`public/js/asistenciaLive.js`](public/js/asistenciaLive.js) — badges lobby (`#homeAttendanceLiveBadge`), contador sala (`#meetAttendanceCopresence`); suscripción `attendance:subscribe` al elegir modo asistencia |
| Emisión | [`src/socket/attendanceLive.js`](src/socket/attendanceLive.js) |

**Fallback y seguridad**

- Con `ASISTENCIA_LIVE_ENABLED=false` (default): no se emiten `attendance:*`; el flujo básico no cambia.
- Rollback: desactivar flag y omitir script `asistenciaLive.js` si hiciera falta.
- **Multi-instancia:** el mapa `sessions` en `copresencia.js` es **por proceso**; en despliegues con varias réplicas hace falta sticky sessions o store compartido (Redis) antes de confiar en contadores en vivo.
- Regresión: `npm run test:copresencia` (socket join/leave + umbral).
- No duplicar reglas de copresencia en el calendario: solo consumir eventos/API; dominio en `copresencia.js`.

#### Reportes y exportación

**Estado actual:** no existen `reportes.js` ni `impresion.js` en servidor. La exportación de calendario es **HTML en el cliente** (iframe `srcdoc` + `window.print()`; el usuario puede “Guardar como PDF”). El tablero usa **jsPDF** en el navegador (`exportBoardToPdf`); no está ligado a asistencia.

| Salida | Mecanismo | Archivos clave |
|--------|-----------|----------------|
| Agendamiento / asistencia (cuadrícula 2 meses) | HTML + print | `public/index.html` — `printAgendamientoCalendar`, `printAsistenciaCalendar`, `openPrintCalendarPreview`, `buildPrintCalendarMonthHtml` |
| Asistencia con resumen + live opcional | Misma ventana print: cuadrícula + tabla/pie | [`public/js/reporteAsistenciaPrint.js`](public/js/reporteAsistenciaPrint.js), `GET /api/reuniones/:id/asistencia/reporte` |
| Tablero | PDF binario (jsPDF CDN) | `exportBoardToPdf` en `public/index.html` |

**Composición en servidor:** [`src/services/reporteAsistencia.js`](src/services/reporteAsistencia.js) — `buildReporteAsistenciaPayload` ensambla `basic: { asistencia, resumen }` (delega en `asistencia.js`; **no** reimplementa umbral ni colores) y, si aplica, `live: { enabled, included, snapshot }` vía `copresencia.getSessionSnapshot`.

**Endpoint:** `GET /api/reuniones/:reunionId/asistencia/reporte?desde=&hasta=&inicioSesion=&live=1` — misma auth que `GET .../asistencia`. Query `live=0` fuerza omitir snapshot aunque `ASISTENCIA_LIVE_ENABLED=true`.

**Nomenclatura live (API/RAM, no BD):**

| Campo en snapshot | Notas |
|-------------------|--------|
| `acumuladoMs` | Tiempo acumulado de copresencia; **no** hay columna `copresenceMs` en BD |
| `fulfilled` | Umbral cumplido (`fulfilledNotified` interno **o** `acumuladoMs >= umbralMs`) |
| `umbralMs` | Desde `ASISTENCIA_COPRESENCIA_MS_MIN` |

**Cliente al imprimir asistencia:** `printAsistenciaCalendar` llama al endpoint reporte (rango = dos meses visibles), actualiza `homeAsistenciaPayload` para colorear la cuadrícula y añade HTML bajo el calendario: sección “Registrado en base de datos” (`resumen.filas`) y, solo si `live.enabled && live.included`, “Instantánea en sala (RAM)”. [`asistenciaLive.js`](public/js/asistenciaLive.js) guarda el último `attendance:copresence` (`getLastCopresenceSnapshot`) como respaldo al imprimir sin refrescar API.

**Fallback:** con `ASISTENCIA_LIVE_ENABLED=false`, el reporte no incluye bloque live; la impresión coincide con el flujo básico (cuadrícula + tabla BD si hay filas). Sin sesión en RAM: texto “No hay sesión activa en este momento” — no inventar `acumuladoMs`.

**Riesgos:** no mezclar verde de celda (BD/`asistio`) con `fulfilled` live; multi-instancia → snapshot live por proceso; PDF de calendario en servidor queda como fase posterior.

#### Métricas avanzadas — Fase A (chat)

**Servicio:** [`src/services/metricasParticipacion.js`](src/services/metricasParticipacion.js) — `countMensajesPorReunion(reunionId, { desde, hasta, inicioSesion })` agrega mensajes por `usuarioId` en la ventana **[inicioSesion, inicioSesion + duración de reunión]** intersectada con `desde`/`hasta`. **No** devuelve contenido de mensajes, solo `{ userId, count }[]`.

**Flag:** `ASISTENCIA_METRICAS_ENABLED=true` (default desactivado). `GET /health` (dev) expone `asistenciaMetricasEnabled`.

**Query en reporte:** `GET .../asistencia/reporte?metrics=chat` (también `metrics=1` o `metrics=full` incluyen chat). `metrics=0` u omitido → `metrics: null`.

**Ejemplo de payload** (`metrics=chat`, flag on):

```json
{
  "reunionId": "...",
  "basic": { "asistencia": [], "resumen": { "filas": [] } },
  "live": { "enabled": false, "included": false, "snapshot": null },
  "metrics": {
    "enabled": true,
    "included": true,
    "participation": {
      "chatByUser": [{ "userId": "...", "count": 12 }]
    }
  }
}
```

Con flag off y `metrics=chat`: `metrics.enabled: false`, `metrics.included: false`, sin `chatByUser`.

**Impresión:** `buildMetricsHtml` en [`reporteAsistenciaPrint.js`](public/js/reporteAsistenciaPrint.js) — tabla «Mensajes por usuario» debajo del resumen BD y del pie live.

**Seguridad:** misma auth que `/asistencia`; el reporte solo expone conteos agregados, no texto ni adjuntos de chat.

#### Métricas avanzadas — Fase B (docente / copresencia RAM)

**Servicio:** [`src/services/copresencia.js`](src/services/copresencia.js) — acumula en RAM, por `(reunionId, inicioSesion)`:

| Campo | Significado |
|-------|-------------|
| `teacherPresenceMs` | Tiempo con ≥1 docente en sala (sin exigir estudiantes) |
| `copresenceMs` / `acumuladoMs` | Tiempo con ≥1 docente **y** ≥1 estudiante simultáneos |

**No se persisten ms en BD** (solo `asistio` booleano en `reunion_asistencias`). Tras reinicio del proceso o otra réplica, los valores RAM pueden ser 0.

**Query en reporte:** `GET .../asistencia/reporte?metrics=session` (solo sesión RAM), `metrics=full` o `metrics=1` (sesión + chat Fase A). `metrics=chat` no incluye `metrics.session`. `metrics=0` u omitido → `metrics: null`.

**Flag:** mismo `ASISTENCIA_METRICAS_ENABLED=true` que Fase A. Con flag off y `metrics=session|full`: `metrics.enabled: false`, `metrics.included: false`, sin `session` ni `chatByUser`.

**Ejemplo de payload** (`metrics=full`, flag on):

```json
{
  "metrics": {
    "enabled": true,
    "included": true,
    "session": {
      "inicioSesion": "2026-05-05T19:00:00.000Z",
      "teacherPresenceMs": 5400000,
      "copresenceMs": 3600000,
      "umbralMs": 3600000,
      "fulfilled": true,
      "teacherPresent": false,
      "copresenceActive": false,
      "source": "ram"
    },
    "participation": {
      "chatByUser": [{ "userId": "...", "count": 3 }]
    }
  }
}
```

**Impresión:** `buildSessionMetricsHtml` en [`public/js/reporteAsistenciaPrint.js`](public/js/reporteAsistenciaPrint.js) — bloque «Métricas de sesión» bajo la cuadrícula (`printAsistenciaCalendar` usa `metrics=full`). La cuadrícula y colores de asistencia (BD) no cambian.

**Rendimiento:** los ticks `attendance:copresence` (cada ~8 s) solo **leen** `getSessionSnapshot`; la agregación ocurre en `room:join` / `room:leave`. El conteo de chat (BD) solo en `GET .../reporte`.

#### Métricas avanzadas — Fase C (persistencia BD)

**Tabla:** `reunion_asistencia_ms` — una fila por `(reunion_id, inicio_sesion, user_id)` con los mismos ms de sesión (snapshot RAM al flush).

**Flags:** `ASISTENCIA_PERSISTENCE_ENABLED=true` (default **false**) + `ASISTENCIA_METRICAS_ENABLED=true` para exponer `metrics.session` en reporte.

**Flush:** al final de `calcularCopresencia` en [`copresencia.js`](src/services/copresencia.js) vía [`asistenciaMsPersistencia.js`](src/services/asistenciaMsPersistencia.js) — no en cada tick socket.

**Lectura reporte:** prioriza BD; si no hay filas → RAM. Campos extra: `source` (`db`|`ram`), `persistedAt`, `selectedBy`, `adminView`, `adminOverride`.

**Selección admin-aware** (`selectPersistedSessionMetrics`): 1) fila del docente (`docenteUsuarioId`); 2) admin sin `?asRequester=true` → mayor `copresence_ms`; admin con `asRequester=true` → fila del solicitante; 3) no admin → fila del solicitante o max copresencia.

**Query:** `GET .../asistencia/reporte?metrics=session&asRequester=1` (solo relevante para admin).

**Migración manual:** [`migrations/2026_add_reunion_asistencia_ms.sql`](migrations/2026_add_reunion_asistencia_ms.sql). Arranque: `ensureReunionAsistenciaMsTable()` en `server.js`.

**Rollback operativo:** desactivar `ASISTENCIA_PERSISTENCE_ENABLED`; opcional `migrations/rollback_2026_add_reunion_asistencia_ms.sql`.

#### Pruebas de validación de métricas

| Script | Uso |
|--------|-----|
| `node scripts/validate-reporte-metrics-plan.cjs` | Fase A (chat): requiere servidor en marcha; `metrics=0`, `metrics=chat`, flag on/off. |
| `node scripts/validate-phase-b-debug.cjs` | Fase B (RAM + API): dos instancias recomendadas — **3001** (`ASISTENCIA_METRICAS_ENABLED=false`) y **3002** (`true`); escenarios socket A/B/C y HTTP `metrics=session\|full`; escribe `debug-<sesión>.log` (NDJSON). |
| `npm run test:asistencia-ms` | Fase C unitario: upsert + `selectPersistedSessionMetrics`. |
| `npm run validate:phase-c` | Fase C integración: servidor con persistencia on, flush, reinicio, `source: db`. |
| `node scripts/debug-api-reunion-metrics.cjs` | Login JWT + reporte; variable `VALIDATE_PORT` (default 3001). |

Validación Fase B (resumen): `teacherPresenceMs` solo con docente; `copresenceMs` solo con docente+estudiante; con flag on, `GET .../reporte?metrics=session` devuelve `metrics.session.source: "ram"`; `metrics=0` → `metrics: null`.

Validación Fase C (resumen): tras flush + reinicio, `metrics.session.source: "db"` y `persistedAt` ISO; persistencia off → sigue RAM aunque exista tabla vacía.

### Cliente (`public/index.html`)

- Una sola página: **login/registro**, listado y creación de **reuniones**, **chat** (general y privado con reglas docente↔estudiante; **adjuntos** por botón 📎, pegar o arrastrar sobre la zona de chat; texto opcional si hay adjunto pendiente), **tablero** colaborativo (herramientas, zoom, minimapa, seguimiento de vista del docente, persistencia vía socket + debounce a BD), **videollamadas WebRTC** (oferta/respuesta/ICE por Socket.io).
- **Chat (UX reciente)**: compositor en columna (preview del adjunto pendiente arriba, fila Adjunto / mensaje / Enviar abajo). En sala, el panel lateral usa **layout flex con scroll**: `#chatBox` encoge y hace scroll; `.chat-compose` permanece visible encima de la barra inferior; la preview pendiente (`#chatAdjuntoPending`) tiene `max-height` acotada para no tapar botones al adjuntar imágenes/PDF. Mensajes con preview y botón **×** para borrar (autor o admin). Menú contextual (clic derecho): copiar texto, nombre de archivo, enlace de API del adjunto, eliminar. Adjunto pendiente: **×** y menú contextual para quitar / copiar nombre. Escucha **`chat:messageDeleted`** para sincronizar borrados.
- **Medios locales**: si cámara y micrófono fallan, se intenta **solo micrófono** y, en último caso, unión con **stream vacío** y transceiver de vídeo **`recvonly`** para seguir en la sala. Los textos de estado de medios **no** se muestran bajo el título en la franja de vídeo (no hay `#mediaStatus` en esa zona); `setMediaStatus` puede seguir en código sin ese nodo en DOM.
- **Barra de medios estilo Zoom**: controles inferiores con patrón botón principal + menú desplegable para **Audio**, **Vídeo**, **Compartir** y **Grabar**; listas de dispositivos movidas al menú (incluye acciones rápidas de refresco/reinicio de medios). Se simplificó UI quitando botones redundantes de aplicar/actualizar.
- **Compartir pantalla y tablero**: menú con `Pantalla` / `Tablero`. Al compartir pantalla, se usa `getDisplayMedia`, se reemplaza la pista de vídeo enviada por WebRTC y al terminar se restaura la cámara automáticamente.
- **Anotaciones sobre pantalla compartida (sync en sala)**:
  - Estado **solo en RAM** en el servidor (`meetScreenShareInkByRoom` en `src/socket/index.js`), **sin persistencia** en base de datos; se limpia al dejar de compartir o al cambiar de presentador.
  - Eventos Socket: **`screenshare-annotate:update`** (el cliente envía `contenido.elementos`; el servidor sanitiza —trazos y textos únicamente— y rebroadcast); **`screenshare-annotate:state`** para enviar estado actual o vacío a quien entra durante share o cuando termina la captura.
  - Cliente (`public/index.html`): overlay sobre el vídeo de pantalla (lápiz, texto, emoji, borrador, selección), coordenadas normalizadas para encajar la relación de aspecto útil del vídeo.
  - **Selección múltiple en anotaciones**: un solo marco de unión cuando hay dos o más ítems; **redimensión conjunta** de trazos y textos con asas en el bbox unión; clic en hueco dentro del bbox (sin golpear otro elemento) inicia **arrastre del grupo**; **flechas** del teclado desplazan la selección (texto + trazos) en modo seleccionar con historial incremental.
- **Flujo de autorización para compartir pantalla (nuevo)**:
  - Invitado: al pulsar **Compartir**, no arranca captura directa; envía **solicitud** al presentador.
  - Presentador (docente/admin): recibe una solicitud **obvia en modal centrado** con acciones `Aceptar` / `Rechazar`.
  - Servidor: eventos Socket `meet:screenShare:request`, `meet:screenShare:response`, `meet:screenShare:grant`; solo presentador/admin puede conceder permiso.
  - El permiso para invitado es **temporal** y enfocado a compartir **pantalla** (no tablero).
  - Si la solicitud llega con la pestaña del presentador en segundo plano, se encola y se muestra al recuperar foco.
- **Render / despliegue frontend-backend separados (nuevo)**:
  - El cliente ahora resuelve un origen de API dinámico (`toApiUrl(...)`) en `public/index.html`.
  - Prioridad de origen:
    1) `window.__MOJ_API_ORIGIN` (si se define),
    2) `localStorage["moj_api_origin"]`,
    3) fallback automático a `https://lc-zoom.onrender.com` cuando el host actual es otro `*.onrender.com`,
    4) si no aplica, usa same-origin (local o despliegue monolítico).
  - Socket.IO cliente: se carga desde CDN (`https://cdn.socket.io/4.8.1/socket.io.min.js`) y la conexión usa `io(API_ORIGIN, ...)` cuando hay origen explícito; en caso contrario usa `io(...)` same-origin.
  - Esto evita que login/API/socket queden apuntando al host equivocado cuando el frontend está en un servicio distinto al backend.
- **Grabación de la reunión (docente)**: solo el **dueño de la sala** (`reunion.docenteUsuarioId`) ve los controles; el servidor rechaza `recording:state` para otros. Un único botón **grabar vídeo** con `MediaRecorder` sobre canvas compuesto (1280×720 @ ~24 fps) + mezcla Web Audio. Se retiró la casilla “incluir tablero”; la composición prioriza **pantalla compartida** cuando está activa y usa cámaras como franja contextual (arriba o a la derecha según layout). **IndexedDB** y `recording:state` / `recording:notify`.
- **Tablero**: cuadrícula punteada sutil y vista sin borde final visible (experiencia “infinita” práctica). El minimapa pasó a marco dinámico basado en contenido + viewport en lugar de límites fijos.
- **Home/Lobby rediseñado**: estilo unificado negro/blanco/azul, acciones rápidas, calendario y lista de próximas reuniones. Se removió el flujo manual de `Room ID` y la entrada se hace por acciones directas por reunión (`Entrar`, `Editar`, `Cupo`, `Eliminar`, `Copiar link`).
- **Calendario (dos meses, asistencia y agenda)**:
  - Vista de **dos meses** con navegación `‹` / `›` (`homeCalendarPanels`): los meses se apilan **en vertical** (`flex-direction: column` en `#homeCalendarPanels`) para ganar ancho y claridad; la barra superior (navegación, deshacer/rehacer, impresión) permanece arriba.
  - Celdas de día más altas (`min-height` ~92px). **Docente**: puntitos (`.calendar-day__dot`, uno por sesión del día) + botón **Ver** (abre modal de agenda del día con reagendar/eliminar). **Estudiante**: hora programada en la celda (`fechaHora`/`fechaHoraFin`, p. ej. `15:00 - 16:00`), sin botón Ver ni modal desde el calendario (sin alterar colores ni lógica de asistencia/copresencia).
  - Modos **Agendamiento** y **Asistencia** por reunión seleccionada; colores de día: azul (programado/futuro), verde (asistió / copresencia cumplida), rojo (no asistió / pasado sin registro).
  - **Vista detallada de agendamiento** (`homeAgendamientoReunionId`): con esa reunión enfocada, al abrir su modal de agenda **Editar**, se muestra un panel **solo lectura** (`#scheduleAgendamientoSesionesReadonly`, `syncScheduleAgendamientoDetalleSesiones` en `public/index.html`) con **cada sesión** incluida en el rango de los **dos meses visibles** del calendario, con **hora programada** en formato legible (`HH:mm – HH:mm`, derivada de `fechaHora` / `fechaHoraFin` por instancia vía `resolveMeetingOccurrenceSlot`). **No** se muestra ese panel cuando el modal se abre desde **Ver** el día (`_calendarDayMeetings` / roster): ahí solo debe verse el listado del día con **Eliminar**; si hubiera foco de agendamiento, el panel se oculta y vacía para no tapar la UX del roster. **Imprimir agendamiento** sigue replicando el **calendario visual** (celdas y colores), no un listado textual — la lógica de fechas por sesión es coherente entre pantalla, modal y print.
  - Datos de asistencia vía `GET /api/reuniones/:reunionId/asistencia` (filas + `resumen`); emparejamiento de ocurrencias con `entradaAt`/`salidaAt` en el mismo día local; soporte de **reagenda** (`fechaOcurrenciaOverride` vs `inicioSesion`).
  - **Reagendar** una ocurrencia de serie: `POST /api/reuniones/:reunionId/reagendar` con `occurrenceId` + `newDate`; el cliente hace después `PATCH` de la reunión padre. Tras reagendar, el `PATCH` localiza la última excepción con `ReunionOcurrencia.findOne({ order: [['actualizado_en','DESC']] })` — **no** usar `'actualizadoEn'` ni `'updatedAt'` en `order`/`where` (provoca `SQLITE_ERROR: no such column: ReunionOcurrencia.actualizadoEn` y 500 en el modal). Marcador ↻ en el día; aviso en modal «Reagendada desde…».
  - Barra superior del calendario (`calendar-head__tools`): historial deshacer/rehacer (docente), impresión de agendamiento (con hora) e impresión de asistencia (placeholder). Ver subsecciones más abajo.
  - Tras salir de sala, `loadHomeMeetings()` refresca el calendario para reflejar asistencia persistida.

#### Disposición vertical del calendario

- **Qué cambió**: `#homeCalendarPanels` usa `display: flex; flex-direction: column` (cada `.home-calendar-month-wrap` ocupa el ancho completo, un mes debajo del otro).
- **Por qué**: mayor claridad al leer dos meses seguidos y más espacio horizontal por celda para la **hora** (estudiante) o **puntitos + Ver** (docente) sin comprimir la cuadrícula.
- La cabecera `calendar-head` (flechas, etiqueta de rango, herramientas de impresión e historial) no se mueve; solo el bloque de meses es vertical.

#### calendarController.js (migración por pasos)

- **Archivo**: `public/js/calendarController.js`, cargado en `public/index.html` **después** de `/js/historialAcciones.js` y **antes** del bloque `<script>` principal.
- **Objetivo**: centralizar poco a poco inicialización, carga de datos del calendario y cableado con historial, impresión, reagendamiento y vistas por rol, **sin duplicar** lógica de dominio ya existente en servidor (`asistencia.js`, `copresencia.js`, `reuniones.js`, etc.).

| Dependencia / consumidor | Uso actual (paso 1) |
|----------------------------|---------------------|
| `GET /api/reuniones/calendario` vía `api()` del index | `CalendarController.loadHomeMeetings` carga la lista completa por rol (calendario, modal, asistencia) |
| `GET /api/reuniones/mis` vía `api()` del index | `CalendarController.loadHomeMisBuckets` carga `{ proximas, anteriores }` (≤10 c/u) para Acciones rápidas; todos los roles ven ambas secciones |
| `public/index.html` | `reloadLobbyHomeData()` delega calendario + buckets; `renderScheduledMeetings()` consume `getMisProximas()` / `getMisAnteriores()` |
| `HistorialAcciones` (`/js/historialAcciones.js`) | Sin cambios; paso 2 enlazará botones desde el controlador |
| Lista de reuniones en memoria | `CalendarController.getMeetings()` / `setMeetings()` sustituyen el antiguo `let homeMeetings` |

**API expuesta (paso 1)**:

| Miembro | Descripción |
|---------|-------------|
| `initStep1()` | Marca inicialización del paso 1 (extensible en pasos siguientes). |
| `getMeetings()` | Devuelve el array de reuniones del calendario (lista completa). |
| `setMeetings(arr)` | Reemplaza el array del calendario (p. ej. tras eliminar una reunión en el lobby). |
| `getMisProximas()` / `getMisAnteriores()` | Buckets de Acciones rápidas cargados desde `/mis`. |
| `setMisBuckets(proximas, anteriores)` | Actualización optimista de buckets tras eliminar. |
| `loadHomeMeetings(hooks)` | Sin token → `onNoToken()`; con token → `GET /api/reuniones/calendario`; siempre → `onAfterLoad(meetings)` en `finally`. |
| `loadHomeMisBuckets(hooks)` | Sin token → buckets vacíos; con token → `GET /api/reuniones/mis`. |

**Notas de migración — Paso 1 (hecho)**:

- Se movió el **estado** de reuniones al módulo: lista completa vía `/calendario` y buckets vía `/mis`.
- La **orquestación** tras la carga (fechas de calendario, focos `homeQuickSelectedReunionId` / `homeAgendamientoReunionId`, `homeAsistenciaPayload`, re-render) permanece en `public/index.html` mediante callbacks para no romper el orden de llamadas existente.
- **Prueba manual sugerida**: login → lobby carga reuniones; deshacer/rehacer, imprimir, Ver y asistencia/agendamiento siguen en el index (sin regresión esperada en paso 1).

**Pasos pendientes** (documentar cada uno al completarlo):

2. Conectar `calendarioHistorial` y botones de impresión al controlador (delegación sin reescribir `historialAcciones.js`).
3. Integrar reagendamiento y validación de solape del lado cliente donde aplique (sigue usando API existente).
4. Cablear asistencia/copresencia solo como orquestación; **no** modificar `src/services/asistencia.js` ni `copresencia.js`.

#### Historial de acciones (deshacer / rehacer)

- **Servicio**: `src/services/historialAcciones.js`, expuesto al navegador con `GET /js/historialAcciones.js` (`server.js`).
- **API del módulo**: `createHistorialAcciones()` devuelve `{ push, undo, redo, canUndo, canRedo, clear, onChange, getSizes }`. Máximo **50** entradas en la pila deshacer (`MAX_ACCIONES`).
- **Forma de cada acción**: `{ type, label, undo: () => Promise, redo: () => Promise }`. Tipos: `agendar`, `editar`, `reagendar`, `cancelar` (`ACCION_TYPES`).
- **Separación de dominios**: no importa ni usa `asistencia.js`, `copresencia.js` ni `reuniones.js` (reagendar). Solo gestiona pilas; el cliente (`public/index.html`, instancia `calendarioHistorial`) registra callbacks que llaman a `POST`/`PATCH`/`DELETE` de reuniones.
- **UI**: botones `#btnCalendarUndo` y `#btnCalendarRedo` en la barra del calendario (clase `btn-ghost btn-calendar-tool`). Visibles para **docente** y **admin** (`canManageScheduleRole` en `updateLobbyRoleUi`); se habilitan/deshabilitan con `updateCalendarHistoryButtons` vía `onChange`.
- **Registro (`push`)** tras operaciones exitosas: `pushHistorialAgendar`, `pushHistorialEditar`, `pushHistorialReagendar`, `pushHistorialCancelar` (eliminar reunión). **Deshacer** ejecuta `undo()` de la cima y la mueve a la pila rehacer; **Rehacer** hace `redo()` y la devuelve a deshacer.
- Al **cerrar sesión** se llama `calendarioHistorial.clear()` para no mezclar acciones entre usuarios.

#### Calendario por rol (Ver, hora en celda, puntitos)

- **Docente / profesor / admin global** (`canManageScheduleRole` en [`public/js/helpers.js`](public/js/helpers.js), alineado con `canManageReuniones` en [`src/utils/roles.js`](src/utils/roles.js)): en días con sesión se muestran **puntitos** (`.calendar-day__dots`) y el botón **Ver** (`btn-calendar-ver`). **Ver** abre `#scheduleModal` con listado del día, edición, reagendar y eliminar. La lista de próximas reuniones muestra además **Editar**, **Cupo**, **Eliminar** y **Copiar código** (no solo Entrar / Asistencia / Agendamiento).
- **`isTeacherRole`** (solo docente/profesor): se reserva para reglas de **dueño docente** en asistencia del calendario (`calendarAsistenciaRowsFromPayload` / `docenteDueño`), no para ocultar la agenda al admin.
- **Estudiante**: en cada día con sesión se muestra la **hora** en la celda (`.calendar-day__times` / `.calendar-day__time`). **No** hay botón Ver ni modal desde el calendario; puede usar **Entrar** en la lista de próximas reuniones.
- **Modal de agenda (docente o admin vía Ver o Editar)**: formulario completo de agendar/editar; el estudiante no entra al modal desde el calendario.

#### Impresión en la barra superior

- **`#btnCalendarPrintAgendamiento`** / **`#btnCalendarPrintAsistencia`**: generan HTML con la misma cuadrícula que en pantalla y llaman a **`print()`** desde un **iframe oculto** con `srcdoc` (evita pestañas `blob:` en blanco en algunos navegadores/perfiles). Estilos embebidos en `getCalendarPrintEmbeddedStyles()`: en **impresión** se fuerza **A4 apaisado**, márgenes cortos, celdas más compactas, `page-break-inside: avoid` en cada `.home-calendar-month-wrap` y `print-color-adjust: exact` en todos los nodos para acercar verde/rojo/azul al lobby. Las **horas** en celdas (`calendar-day__time`) se mantienen. Para **asistencia**, el docente **dueño** de la reunión (`docenteUsuarioId` = usuario actual) usa **`calendarAsistenciaRowsFromPayload`**: todas las filas de `GET .../asistencia` (`asistencia[]`) para colorear por participación de la clase; el resto de roles sigue filtrando a la fila propia (`parseAsistenciaRowsFromApi`). Conviene activar **gráficos de fondo** en el diálogo de impresión del navegador si los tonos salen apagados.
- Botones visibles para todos los roles; estilos `btn-ghost btn-calendar-tool`.
- **Agendamiento en modal**: creación y edición con título, inicio, duración, zona horaria, link compartible y copia al portapapeles. Modal con scroll interno + acciones sticky para mantener botones visibles en pantallas pequeñas.
- **Solapamiento de agenda (docente)**: el servidor valida intervalos `[fechaHora, fechaHoraFin]` frente al resto de reuniones no finalizadas del mismo docente (`src/services/reunionHorarioSolapamiento.js`): una query carga la agenda, se construyen intervalos ocupados (padres, expansión RRULE alineada al cliente, excepciones; se omiten `omitInstance` y la reunión bajo edición vía `excludeReunionId`). Al validar el **padre** de una serie, las filas **excepción** (`esExcepcion`) con el mismo `parentReunionId` que el `excludeReunionId` **no** se añaden a la agenda ocupada (evita 409 falso tras reagendar: la expansión teórica ya no choca con la propia excepción). En **`POST .../reagendar`**, la sustitución de la serie padre debe excluir de la expansión RRULE tanto el **día origen** como el **día destino**; si solo se omite el origen, una serie diaria/semanal puede autoconflictar en el día destino (409 falso citando la misma clase). **`POST /api/reuniones`**, **`PATCH`** del padre (no excepción) y **`POST .../reagendar`** validan solape; conflicto → **409** con mensaje en español (título y hora de fin de la sesión **bloqueadora**, que puede ser otra clase distinta de la que se está guardando). En **`PATCH /api/reuniones/:id`**, si título, fechas, zona y recurrencia normalizada no cambian respecto a la BD (`isAgendaPatchNoOp` en `src/routes/reuniones.js`), **no** se re-ejecuta la validación de solape (permite «Guardar sin cambios» sin 409 sobre un estado ya conflictivo). En el cliente, el modal de agendamiento (`#scheduleModal`, `#scheduleModalError`) captura explícitamente el **409**: muestra el `error` del API o, si falta, el texto «Esta sesión se solapa con otra. Elige otro horario.» sin cerrar el modal. Excepciones de ocurrencia validan con `validateNoOverlapForDocente`. Rutas `POST .../excepcion-ocurrencia` y `POST .../omitir-ocurrencia` para edición/omisión por día.
- **Recurrencia en UI**: `No repetir`, `Diario`, `Semanal`, `Mensual`, `Personalizado` (base diaria/semanal/mensual, intervalo y selección de días con chips). Fin de secuencia con modo `Nunca` o `Hasta fecha`, resumen legible de la regla y validación visual/funcional cuando la fecha fin queda antes del inicio.
- **Nombre obligatorio para entrar**: mini-modal para capturar nombre visible antes de unirse a reunión, con persistencia local por usuario.
- **Auth (login/registro) — UX actualizada**:
  - Login y registro se separaron: `Crear cuenta` abre modal dedicado.
  - El registro **no** inicia sesión automática (flujo explícito): tras crear cuenta, vuelve al login.
  - Mensaje de login mantenido genérico: `Credenciales inválidas`.
- **Seguridad de roles en registro**:
  - El registro público crea siempre `estudiante` (backend ignora rol del cliente).
  - Se elimina selector de rol en el registro público para evitar confusión/escalamiento.
- **Promoción de roles (admin)**:
  - Nuevo endpoint `PATCH /api/usuarios/:usuarioId/rol` (solo admin) para cambiar entre `estudiante` / `docente` / `admin`.
  - Incluye auditoría básica en logs servidor (`[AUDIT] usuario:rol:update` con actor, objetivo, cambio, IP, user-agent).
- **Sala de espera con aprobación del presentador (nuevo)**:
  - El invitado en `#/meet/:roomId/wait` ya no entra directo; envía solicitud de entrada.
  - El presentador recibe modal centrado con nombre del solicitante y botones `Aceptar` / `Rechazar`.
  - Al rechazar, se pide confirmación explícita.
  - El servidor valida entrada real: `room:join` rechaza a no-presentadores sin grant previo.
  - Eventos Socket añadidos: `room:entry:request`, `room:entry:response`, `room:entry:decision`.
- **Franja de vídeo en sala**: una fila con marca **My Own Zoom** + botón **Copiar enlace** (sin UUID visible bajo el título); vídeos a la derecha. `#btnToggleChat` y `#btnRoomViewToggle` existen ocultos solo para sincronizar JS con el panel azul de layout/chat.
- **Tablero**: menús laterales (colores, emojis, grosor, tamaño de texto, más) fuera de la barra vertical; posición **`fixed`** para evitar recortes y scroll fantasma; barra vertical acotada en altura (`max-height`) sin estirar vacío.
- **Texto en tablero (herramienta T)** — `public/index.html`:
  - Edición inline con **`contenteditable`** (mismo aspecto de borde punteado que la selección final; evita controles nativos de `textarea`).
  - **Sin `max-width`** en el editor para que el cuadro pueda crecer horizontalmente sin recortar el texto (`white-space: pre` salvo saltos con Enter).
  - Al **redimensionar** un bloque de texto seleccionado con el puntero, solo manijas en **esquinas**; manijas algo mayores y zona de golpeo ampliada; cursor de resize al pasar sobre la manija en modo puntero.
  - Coherencia canvas ↔ editor: las medidas de texto usan **`getBoardPixelRatio()`** (relación `canvas.width` / ancho CSS), alineado con el redimensionado del canvas por `devicePixelRatio` en `resizeBoardCanvasToViewport`.
  - La posición persistida del texto usa la **ancla mundo** del editor (`worldX` / `worldY`) al confirmar, evitando drift por conversiones redundantes.
  - Tamaño de fuente inicial por defecto para texto nuevo: **24 px** (`boardTextSize`; el menú de tamaño de texto del tablero sigue actualizando el editor activo).
- **Reacciones**:
  - **Mensajes de chat** con persistencia por BD (`mensaje_reacciones`) y sync por Socket (`chat:reaction:toggle` / `chat:messageReaction`) en general y privados.
  - **Barra rápida de emojis** encima del input de chat (incluye botón `...` para más emojis); si el input está vacío, el emoji se envía como mensaje.
  - **Reacción de sala** desde toolbar inferior (botón junto a Grabar) con menú emergente (`room:reaction`), visible como aviso en chat general.
  - **Compatibilidad SQLite en orden de reacciones**: el servidor ordena por `mensajeReaccionId` (no por `createdAt`) para evitar errores en BD locales con esquemas previos.
- **Responsive sala (ajuste anti-regresión)**: en `max-width: 720px` se mantiene layout horizontal (tablero izquierda, chat derecha), splitter visible y toolbar de tablero vertical; se evita el fallback viejo de chat abajo + toolbar horizontal.
- **Composer de chat (ajuste anti-regresión)**: `#chatInput` volvió a `textarea`, botones Adjunto/Enviar debajo del input y Enter para enviar (`Shift+Enter` salto de línea).
- **Chat en sala (`chat.js`, fase 1 + 2)**:
  - **`public/js/chat.js`**: estado de hilos (`chatThreads`, hilo activo), `appendChatLine`, render de mensajes/pestañas, composer (enviar, adjuntos, DnD, barra rápida de emojis), menú contextual, reacciones y avisos de sala (`appendRecordingNotice`). Inicialización: `ChatModule.initChatRoom({ $, api, getToken, ... })` desde `index.html`.
  - **`notificaciones.js`**: agrega `totalUnread` desde `chatThreads[].unread`; escucha el bus interno.
  - **`uiBarra.js`**: botón `#btnChatBar` + badge `.room-tb-badge` en `#roomMediaControls`.
  - **Bus interno en `document`** (no Socket.io): `moj:chat:notify`, `moj:chat:read`. Reglas: no-leído si hilo distinto al activo **o** panel oculto; **sin badge en mensajes propios** (`shouldIncrementUnreadForIncoming`: compara `autorId` con `getSelfUserId()`).
  - **Identidad antes del socket**: `ensureCurrentUserLoaded()` en `index.html` carga `/api/usuarios/me` en `enterRoom` (y `init()` restaura sesión antes de `initChatModule()`). Si aún falta `usuarioId`, el chat **no incrementa unread** ni emite notify (degradación segura en `chat.js`).
  - **`index.html`**: glue de sala (socket, `loadParticipantsForRoom`, `setChatPanelHidden`, WebRTC); delega chat a `ChatModule`. CSS de `.room-chat-panel`: overflow contenido, composer fijo, scroll en historial y slot de adjunto pendiente.
- **Selección en tablero (puntero)** — implementada en [`public/js/tableroSeleccion.js`](public/js/tableroSeleccion.js) (estado local; no viaja por socket):
  - Click sobre un elemento (texto, imagen o **trazo**) selecciona ese elemento; los trazos son seleccionables, arrastrables y **redimensionables**.
  - **Shift+click** acumulativo: añade o quita del conjunto.
  - **Drag-box / marquee**: click+arrastre en zona vacía dibuja un rectángulo translúcido azul; al soltar selecciona todos los elementos cuyo AABB intersecte. **Shift+drag-box** añade al conjunto en lugar de reemplazarlo.
  - **Drag agrupado**: con N>1 seleccionados, arrastrar desde el cuerpo de cualquiera mueve los N juntos (texto/imagen por `x,y`; trazo por traslación de todos sus puntos). Un único snapshot al historial.
  - **Resize individual**: con N=1 no bloqueado se dibujan handles alrededor del bbox y al arrastrarlos se escala el elemento. Imagen y **trazo** soportan los 8 handles con escala no uniforme (Shift en esquina = uniforme); el trazo escala todos sus `points` respecto al anchor opuesto y reescala `lineWidth` por la media de `|sx|,|sy|`. Texto conserva su escala uniforme por distancia al origen (`applyTextUniformScale`).
  - **Resize de grupo**: con N>1 y ningún elemento `locked` se dibuja un bbox de unión y handles. Al arrastrar un handle, todos los elementos seleccionados se transforman respecto al anchor opuesto del bbox de grupo: trazos escalan `points` + `lineWidth`; imágenes escalan `w,h` y reposicionan `x,y`; textos escalan `fontSize` (uniforme) y reposicionan `x,y`. Un único snapshot al historial. Si hay algún `locked` los handles de grupo se ocultan (sólo se permite drag).
  - **Flechas del teclado** mueven toda la multiselección (Shift = paso de 10 px); **Delete/Backspace** borra todos los seleccionados (saltando `locked`).
  - **`selectedElementIndex`** se conserva como alias de "único seleccionado" para compat (lock UI, Ctrl+C, edición de texto inline); vale `-1` cuando hay 0 o >1 seleccionados.
  - Math compartido en el módulo: `getResizeTransform(handleId, ob, dx, dy, shiftKey)` calcula `anchor` + `sx,sy` + `newBounds`; `applyResizeTransform(el, anchor, sx, sy)` en `public/index.html` aplica la transformación según el tipo del elemento (respetando `locked`).
- **Borrador del tablero**: al tocar un trazo/elemento, elimina el elemento completo (hit-test por segmento para strokes) en lugar de “pintar blanco”.
- **Exportación del tablero a PDF** en cliente con **jsPDF** (recorte al contenido).

### Cupo de sala

- Regla explícita: **1 docente (dueño de la reunión) + hasta 5 participantes que no son el docente** (en la práctica orientado a estudiantes). Implementado en `src/services/reunionParticipacion.js` (`MAX_ESTUDIANTES = 5`) y expuesto en API (`cupo` en `GET /reuniones/room/:roomId`).

---

## 2. Decisiones de negocio reflejadas en código

| Tema | Dónde / qué hace |
|------|------------------|
| Solo **docente** o **admin** gestiona agenda (crear, excepciones, omitir, reagendar) | `canManageReuniones()` en [`src/utils/roles.js`](src/utils/roles.js); usado en `src/routes/reuniones.js` |
| **Listado de reuniones por rol** — `GET /api/reuniones/calendario` devuelve `{ reuniones }` (lista completa, sin límite): `admin` ve todas; `docente` ve las que creó (incluye finalizadas); estudiante ve las suyas vía `Participa`. Cadena: `getReunionScopeForUser()` → [`src/services/reunionesListing.js`](src/services/reunionesListing.js) → [`src/services/reunionPresenter.js`](src/services/reunionPresenter.js) → handler en `src/routes/reuniones.js` | Ver fila «Acciones rápidas» para `/mis` |
| **Acciones rápidas con doble bucket** — `GET /api/reuniones/mis` devuelve `{ proximas, anteriores }` (≤10 c/u, calculados en [`src/services/reunionesMisBuckets.js`](src/services/reunionesMisBuckets.js)). Todos los roles ven ambas secciones. **Eliminar:** `DELETE /api/reuniones/:id` hace hard-delete en cascada ([`src/services/reunionDelete.js`](src/services/reunionDelete.js)); la fila desaparece de BD y no reaparece tras re-login. Frontend: `buildScheduledItem`, `renderBucket`, `renderScheduledMeetings` en `public/index.html`; estado en `calendarController.js` | `public/index.html`, `public/js/calendarController.js` |
| **Eliminar reunión** — `eliminarReunionEnBd` destruye la fila y dependencias (mensajes, participa, tablero, ocurrencias, invitados, solicitudes, asistencias, hijos `parentReunionId`). Solo owner o admin | [`src/services/reunionDelete.js`](src/services/reunionDelete.js), `DELETE /:reunionId` |
| Reunión nueva: estado **programada** si la fecha es futura (si no, **activa**), docente auto-inscrito y **Tablero** vacío creado | `src/routes/reuniones.js` |
| **Convención de timestamps en modelos Sequelize** — Todos los modelos en [`src/models/`](src/models/) usan `timestamps: true` con alias físicos `createdAt: 'creado_en'` y `updatedAt: 'actualizado_en'` (heredado del `define` global de [`src/config/database.js`](src/config/database.js) y declarado explícitamente en las options de cada modelo para autodocumentación). No se declaran `createdAt`/`updatedAt` como atributos manuales del modelo ni se usan hooks `beforeUpdate` para tocar `actualizado_en`: Sequelize lo hace solo al hacer `.save()` / `.update()`. Servicios y rutas no deben asignar manualmente esas columnas. **Importante para consultas:** al usar `createdAt: 'creado_en'`/`updatedAt: 'actualizado_en'` Sequelize renombra el atributo del modelo (de `createdAt`/`updatedAt` a `creado_en`/`actualizado_en`); por lo tanto las consultas que ordenan/filtran por timestamps deben usar los alias físicos (`order: [['creado_en','ASC']]`, no `'createdAt'`), de lo contrario Sequelize lo trata como columna literal y falla con `SQLITE_ERROR: no such column: Reunion.createdAt`. Mismo patrón en `ReunionOcurrencia` tras reagendar: `PATCH` en `src/routes/reuniones.js` ordena la última excepción con `[['actualizado_en','DESC']]` (no `actualizadoEn`) | Modelos: [`reunion.js`](src/models/reunion.js), [`reunionInvitado.js`](src/models/reunionInvitado.js), [`reunionSolicitudAcceso.js`](src/models/reunionSolicitudAcceso.js), [`reunionOcurrencia.js`](src/models/reunionOcurrencia.js), [`reunionAsistenciaMs.js`](src/models/reunionAsistenciaMs.js), etc. Config global: [`src/config/database.js`](src/config/database.js). Consumidor que aplica la convención al ordenar: [`src/services/reunionByRoom.js`](src/services/reunionByRoom.js), `PATCH` post-reagendar en `src/routes/reuniones.js` |
| Edición y eliminación de reuniones por dueño/admin | `PATCH /api/reuniones/:reunionId`, `DELETE /api/reuniones/:reunionId` (hard-delete en cascada) |
| **Cupo** 5 no-docentes + docente | `puedeUnirseParticipar`, mensaje de error fijo en español |
| Chat **privado**: estudiante solo hacia docente; docente puede escribir a estudiante; reglas en Socket y REST | `src/socket/index.js`, `src/routes/mensajes.js` |
| **Adjuntos de chat**: subida HTTP; mensaje con metadatos vía Socket; comprobación de que el fichero exista en disco antes de persistir | `src/routes/reuniones.js`, `src/socket/index.js`, `src/services/chatAdjuntos.js`, `GET .../mensajes/adjunto/...` |
| **Reacciones de mensaje** (toggle por usuario/emoji, persistencia y broadcast) | `src/socket/index.js`, `src/models/mensajeReaccion.js`, `src/routes/mensajes.js`, `public/index.html` |
| **Reacción de sala** desde toolbar inferior | `room:reaction` en `src/socket/index.js`, menú `roomReactionMenu` en `public/index.html` |
| **Notificaciones de chat en barra inferior** (badge sin falsos positivos en eco propio; identidad cargada antes del socket) | `ensureCurrentUserLoaded`, `getSelfUserId`, `shouldIncrementUnreadForIncoming` en `public/js/chat.js` + `public/index.html`; bus `moj:chat:notify` / `notificaciones.js` / `uiBarra.js` |
| **Layout del panel de chat con adjunto pendiente** (composer visible sobre toolbar inferior) | CSS `.room-chat-panel` en `public/index.html`: `#chatBox` scroll + `.chat-compose` fijo + `.chat-adjunto-pending-slot` con altura máxima |
| **room_id** único por reunión (UUID), búsqueda case-insensitive en sala | normalización `normRoomId` / `findReunionByRoomKey` |
| JWT en cabecera para API; token también para Socket (`auth` o `query`) | `src/middleware/auth.js`, `src/socket/index.js` |
| **Grabación** (vídeo + audio mezclado): solo el dueño de la sala (`docenteUsuarioId`); UI oculta para el resto; `recording:state` rechazado en socket si no es el docente | `public/index.html` (`isRoomDocente`, `updateTeacherRecordingControlsVisibility`), `recording:state` en `src/socket/index.js` |
| **Compartir pantalla por solicitud**: invitado solicita, presentador aprueba/rechaza en modal; grant temporal por sala y validación en socket para iniciar share | `public/index.html` (modal + cola + handlers), `src/socket/index.js` (`meet:screenShare:request/response/grant`, `meetScreenShareGrant`) |
| **Anotaciones en pantalla compartida** (estado en RAM, sanitizado, rebroadcast) | `screenshare-annotate:update`, `screenshare-annotate:state` en `src/socket/index.js`; overlay y herramientas en `public/index.html` |
| **API/Socket cross-origin en Render**: helper `toApiUrl`, fallback de origen, y conexión Socket.IO al backend público cuando frontend/backend están separados | `public/index.html` (`API_ORIGIN`, `inferApiOrigin`, `toApiUrl`, `connectSocketIfNeeded`) |
| **Registro público sin escalamiento de rol**: alta siempre como `estudiante`, sin confiar en `rol` del cliente | `src/routes/auth.js`, `public/index.html` |
| **Cambio de rol administrado**: promoción/degradación de rol solo por admin + auditoría básica | `PATCH /api/usuarios/:usuarioId/rol` (legacy), **`GET/PATCH /api/admin/usuarios`** en `src/routes/admin.js` + panel [`public/admin.html`](public/admin.html) |
| **Panel admin (gestión de roles)** | `src/middleware/requireAdmin.js`, `public/js/helpers.js` (`isAdminRole`, `canManageScheduleRole`), enlace «Panel admin» en lobby — ver §4 |
| **Predicados de rol compartidos (cliente + servidor)** | `public/js/helpers.js` (`normalizeRol`, `isTeacherRole`, `isAdminRole`, `canManageScheduleRole`, `getUserRoleLabel`); `src/utils/roles.js` (`canManageReuniones`) |
| **Control de acceso en sala de espera**: entrada de invitado condicionada a aprobación del presentador (enforcement en socket) | `public/index.html` (wait modal + estado), `src/socket/index.js` (`roomEntryGrant`, `room:entry:*`, gate en `room:join`) |
| **Modelo de reacciones de mensaje**: entidad dedicada `MensajeReaccion` + asociaciones `Mensaje`/`Usuario`; corrige fallos de runtime en `chat:reaction:toggle` cuando el modelo no estaba declarado | `src/models/mensajeReaccion.js`, `src/models/index.js`, `src/socket/index.js` |
| Recurrencia persistida por API en `reuniones.recurrencia` (JSON serializado), validada en backend y consumida por calendario/listado del home | `src/routes/reuniones.js`, `public/index.html` |
| **Sin solape de horarios** del docente al crear/editar/reagendar; 409 descriptivo en API y modal de agenda; omisión de validación en PATCH si agenda sin cambios (`isAgendaPatchNoOp`); excepciones de serie excluidas del mapa de ocupación al validar el padre (`buildBusyIntervals`) | `src/services/reunionHorarioSolapamiento.js`, `src/routes/reuniones.js`, `public/index.html` (`scheduleApiErrorMessage`, `#scheduleModalError`, `openScheduleModal` + roster vs panel agendamiento) |
| Campos de reunión para **agenda futura** (`fechaHoraFin`, `zonaHoraria`, `recurrencia`, `serieId`) y **excepciones de serie** (`parentReunionId`, `esExcepcion`, `occurrenceDayKey`) | `src/models/reunion.js` |
| **Asistencia en BD** + umbral de copresencia | Ver §1 «Asistencia y copresencia»; `src/models/reunionAsistencia.js`, `src/services/asistencia.js`, `src/services/copresencia.js`, `GET/POST .../asistencia`, `GET .../asistencia/live`, socket `room:join`/`room:leave`, opcional `attendance:*` vía `src/socket/attendanceLive.js` |
| **Asistencia en vivo (opcional)** | `ASISTENCIA_LIVE_ENABLED`, `public/js/asistenciaLive.js`, eventos `attendance:presence` / `attendance:copresence` / `attendance:fulfilled` |
| **Métricas de reporte (Fase A/B/C)** | `ASISTENCIA_METRICAS_ENABLED`, `ASISTENCIA_PERSISTENCE_ENABLED`, `GET .../asistencia/reporte?metrics=0\|chat\|session\|full`, `reporteAsistencia.js`, `asistenciaMsPersistencia.js`, tabla `reunion_asistencia_ms` |
| **Reagendar ocurrencia** (solo docente dueño) | `POST /api/reuniones/:reunionId/reagendar`, `src/services/reuniones.js` + tabla `reunion_ocurrencia` |
| **Deshacer/rehacer agenda** (pilas en cliente; ver §1 Historial de acciones) | `src/services/historialAcciones.js`, `public/index.html` (`calendarioHistorial`, `#btnCalendarUndo` / `#btnCalendarRedo`); migración hacia `public/js/calendarController.js` (paso 2) |
| **Calendario lobby — estado y carga** (`getMeetings` / `setMeetings` / `loadHomeMeetings`, paso 1) | `public/js/calendarController.js` + delegación en `public/index.html` |
| **Impresión agendamiento y asistencia** (cuadrícula 2 meses; asistencia + tabla resumen BD y pie live opcional vía reporte) | §1 «Reportes y exportación»; `public/index.html`, [`public/js/reporteAsistenciaPrint.js`](public/js/reporteAsistenciaPrint.js), [`src/services/reporteAsistencia.js`](src/services/reporteAsistencia.js), `GET .../asistencia/reporte` |
| **Calendario por rol** (Ver + puntitos docente/admin; hora en celda estudiante) | `public/index.html` + `canManageScheduleRole` en `helpers.js` |
| Invitaciones / solicitudes de acceso a reunión (modelo y servicio) | `src/models/reunionInvitado.js`, `reunionSolicitudAcceso.js`, `src/services/reunionInvitacionesSolicitudes.js` |
| Búsqueda de reunión por `room_id` (case-insensitive) centralizada | `src/services/reunionByRoom.js` |
| Reparación opcional de integridad SQLite en `reuniones` tras cambios de esquema | `src/services/sqliteReunionSchemaRepair.js`, llamado desde `server.js` |

---

## 3. Próximas etapas visibles en el esquema / producto

- **Chat**: pulir UX según feedback (flujo copiar/cortar, toasts, consistencia del borrado y reacciones en todos los clientes).
- **Recurrencia avanzada de serie**: regla JSON + overrides por `reunion_ocurrencia` y excepciones `esExcepcion`; edición por día del calendario; unificar UX de filtrado por serie seleccionada con la vista de asistencia/agendamiento.
- **Migraciones explícitas**: pasar de `sync()` a **sequelize-cli** (o similar) para entornos compartidos y despliegues.
- **Mejoras opcionales**: endurecer reglas de cupo si entraran roles mixtos; export PDF también desde servidor; TURN en producción; tests automatizados.

*(La exportación PDF del tablero en el navegador ya está; las extensiones serían otro canal o formato.)*

---

## 4. Administración (panel de roles)

Usuarios con rol global **`admin`** pueden abrir **`/admin.html`** (enlace «Panel admin» en el lobby) para listar usuarios y cambiar roles (`docente`, `estudiante`, `admin`).

**API (requiere JWT + rol admin):**

| Método | Ruta |
|--------|------|
| `GET` | `/api/admin/usuarios` |
| `PATCH` | `/api/admin/usuarios/:id/rol` — body `{ "rol": "docente" }` |

**Primer administrador** (BD vacía o Render con SQL): promover manualmente una cuenta existente:

```sql
UPDATE usuarios SET rol = 'admin' WHERE email = 'tu-correo@ejemplo.com';
```

Cierra sesión y vuelve a entrar para que el cliente cargue el rol desde `GET /api/usuarios/me`.

### Bootstrap temporal (solo desarrollo)

**Advertencia:** endpoint **temporal**. Tras promover tu cuenta **una vez**, elimina el bloque `if (process.env.NODE_ENV !== 'production') { … make-admin … }` en [`src/routes/usuarios.js`](src/routes/usuarios.js) y esta subsección (o márcala obsoleta). No desplegar a producción con este código aunque esté condicionado por `NODE_ENV`.

| Método | Ruta |
|--------|------|
| `PATCH` | `/api/usuarios/me/make-admin` — promueve al usuario del JWT; no existe si `NODE_ENV=production` (p. ej. Render) |

1. Inicia sesión y obtén el token (p. ej. tras `POST /api/auth/login` o `GET /api/usuarios/me`).
2. Promoción (solo tu sesión, sin pasar UUID en la URL):

```bash
curl -X PATCH "http://localhost:3000/api/usuarios/me/make-admin" \
  -H "Authorization: Bearer TU_TOKEN"
```

Respuesta esperada: `{ "ok": true, "id": "…", "rol": "admin" }`. Sin token → **401**.
3. Refresca el lobby o vuelve a llamar `GET /api/usuarios/me` → enlace **Panel admin**.
4. **Limpieza:** borra el bloque `me/make-admin` en `usuarios.js` (y esta subsección si ya no aplica) y confirma con commit.

El registro público (`POST /api/auth/register`) sigue creando cuentas **`estudiante`** por defecto.

**Archivos principales:**

| Archivo | Rol |
|---------|-----|
| `src/middleware/requireAdmin.js` | Middleware `403` si `rol !== 'admin'` |
| `src/routes/admin.js` | Listado y cambio de rol |
| `public/admin.html` | UI tabla + selector de rol |
| `public/js/helpers.js` | `isAdminRole`, `isTeacherRole`, `canManageScheduleRole`, `getUserRoleLabel` (lobby y `admin.html`) |
| `public/js/tableroSeleccion.js` | Subcapa de selección del tablero: estado (Set), hit-tests (text/image/stroke), drag-box (marquee), helpers de bounds, `getResizeTransform` para resize de elemento o grupo — selección **local**, no se serializa por socket |
| `src/utils/roles.js` | `canManageReuniones()`, `getReunionScopeForUser()` (política de scope: `all` para admin, `owned` para docente, `participating` para el resto) — predicados puros sin Sequelize, reutilizados en `reunionesListing.js` |
| `src/services/reunionPresenter.js` | `reunionJsonWithReagenda(reunion)` — serializador único de modelos `Reunion` con metadatos de reagendamiento (extraído del router para reuso desde servicios) |
| `src/services/reunionesListing.js` | `listarReunionesParaUsuario(usuario)` → lista completa por rol; usado por `GET /api/reuniones/calendario` |
| `src/services/reunionesMisBuckets.js` | `buildMisBucketsForUsuario(usuario)` → `{ proximas, anteriores }` ≤10; usado por `GET /api/reuniones/mis` |

**QA manual:** usuario `estudiante` → `GET /api/admin/usuarios` debe devolver **403**; usuario `admin` → lista OK; tras `PATCH`, el afectado ve el nuevo rol en el badge del lobby tras re-login o refresco (`GET /api/usuarios/me`).

---

## 5. Scripts NPM actuales

| Comando | Uso |
|---------|-----|
| `npm start` | Arranca `node server.js` |
| `npm run dev` | Mismo servidor con `node --watch` |
| `npm run test:copresencia` | Script `scripts/test-copresencia-socket.cjs` (socket.io-client; prueba entrada/salida y umbral) |

Scripts adicionales (sin entrada en `package.json`): `validate-reporte-metrics-plan.cjs`, `validate-phase-b-debug.cjs`, `debug-api-reunion-metrics.cjs` — ver § métricas.

Variables útiles: `PORT`, `JWT_SECRET`, `DATABASE_URL`, `STUN_URLS`, `TURN_*`, `NODE_ENV`, **`ASISTENCIA_COPRESENCIA_MS_MIN`** (ms mínimos de copresencia; p. ej. `30000` en pruebas, `3600000` ≈ 60 min en producción), **`ASISTENCIA_LIVE_ENABLED`** (`true` para indicadores/contador/flush anticipado por socket; default desactivado), **`ASISTENCIA_METRICAS_ENABLED`** (`true` para `metrics=chat|session|full` en `GET .../asistencia/reporte`; default desactivado), **`ASISTENCIA_PERSISTENCE_ENABLED`** (`true` para flush/lectura BD de métricas sesión; default desactivado).

---

## 6. Sequelize CLI — estado y uso previsto

**Estado actual:** no hay `npm run db:migrate` definido en `package.json`; no hay archivos de migración en el árbol revisado. El lockfile puede listar `sequelize-cli` como devDependency aunque el `package.json` no lo refleje — conviene alinear e instalar de nuevo si se adopta la CLI.

**Cuando se integre sequelize-cli**, patrón habitual:

1. Añadir devDependency: `sequelize-cli`.
2. Crear `.sequelizerc` apuntando a `config`, `models-path`, `migrations-path`, `seeders-path`.
3. Generar migraciones iniciales equivalentes al estado actual de los modelos (o baseline + migraciones nuevas).
4. Scripts típicos en `package.json`:

| Script sugerido | Comando subyacente |
|-----------------|-------------------|
| `db:migrate` | `sequelize-cli db:migrate` |
| `db:migrate:undo` | `sequelize-cli db:migrate:undo` |
| `db:migrate:undo:all` | `sequelize-cli db:migrate:undo:all` |
| `db:seed` | `sequelize-cli db:seed:all` (si hay seeders) |

Tras migrar a CLI, **sustituir o condicionar** `sequelize.sync()` en producción para evitar alteraciones automáticas no controladas.

---

## 7. Buenas prácticas para sesiones en Cursor

- **Actualizar este `README-dev.md`** cuando: se añadan rutas o eventos de socket; cambien modelos o estrategia de BD; se añadan variables de entorno; cambie el cupo o las reglas de chat; cambie la grabación (audio/vídeo) o la mezcla Web Audio; se creen migraciones o scripts.
- Así el siguiente chat o sesión puede usar este archivo como **contexto inicial** (pegar resumen o `@README-dev.md`).

---

*Última actualización de este documento: mayo 2026 — fix chat: badge sin falsos positivos en mensajes propios (`ensureCurrentUserLoaded`, degradación segura sin `selfId`); layout del panel lateral con adjunto pendiente (composer fijo, scroll en historial). Anterior: DELETE real en cascada; buckets `/mis`; fix reagendar `actualizado_en`.*
