# README de desarrollo — My Own Zoom

Briefing para retomar el trabajo en Cursor sin perder contexto. **Actualizar este archivo al cerrar una sesión** cuando cambie el esquema, la API, scripts de BD o decisiones de producto.

---

## 1. Resumen del estado actual

### Backend (`server.js`)

- **Express** en el mismo proceso HTTP que **Socket.io** (mismo puerto; por defecto `3000`).
- **CORS** abierto para desarrollo; **JSON** body parser.
- Rutas bajo `/api`: autenticación, usuarios, reuniones, mensajes (ver `src/routes/`).
- **Health**: `GET /health`.
- **WebRTC / ICE**: `GET /api/rtc/config` — STUN desde `STUN_URLS` o por defecto Google; TURN opcional vía `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
- **Estáticos**: `public/`; la raíz sirve `public/index.html`.
- **Base de datos**: Sequelize. Sin `DATABASE_URL` → **SQLite** en `data/app.sqlite`. Con `DATABASE_URL` → **PostgreSQL**.
- **Adjuntos de chat (archivos)**: `multer` escribe en `data/chat-adjuntos/<reunionId>/` (carpeta `data/` en `.gitignore`). **`POST /api/reuniones/room/:roomId/chat-adjunto`** con `multipart/form-data`, campo **`file`**, máximo **20 MB** y extensiones acotadas en `src/services/chatAdjuntos.js`. La subida **no** crea fila en `mensajes`: el cliente envía luego **`chat:message`** por Socket con `adjuntoRelPath`, `adjuntoNombreOriginal`, `adjuntoMime`, `adjuntoBytes`. Descarga autenticada: **`GET /api/mensajes/adjunto/:mensajeId`**.
- **Borrado de mensajes**: **`DELETE /api/mensajes/:mensajeId`** — autor o admin; elimina adjunto en disco si existe; emite por Socket **`chat:messageDeleted`** (`mensajeId`). Sala general: broadcast a la room; mensaje **privado**: solo sockets del autor y del destinatario.
- **`app.set('io', io)`** en `server.js` para que las rutas REST puedan emitir eventos Socket tras mutaciones (p. ej. borrado de chat).
- **Arranque BD**: tras `sequelize.sync()` se ejecuta **`ensureMensajeAdjuntoColumns()`** (añade columnas de adjunto en `mensajes` si faltan) para no depender de `sync({ alter: true })` global (evita errores con tablas auxiliares SQLite como backups).

### Persistencia y esquema

- Modelos en `src/models/`: `Usuario`, `Reunion`, `Participa`, `Mensaje`, `Tablero` y asociaciones en `src/models/index.js`.
- **Importante:** el esquema base se aplica con **`sequelize.sync()`** al iniciar (`server.js`); las columnas nuevas de adjuntos en `mensajes` se completan con el helper anterior. **No** hay carpeta de migraciones `sequelize-cli` versionada en este repo en el estado auditado.

### Cliente (`public/index.html`)

- Una sola página: **login/registro**, listado y creación de **reuniones**, **chat** (general y privado con reglas docente↔estudiante; **adjuntos** por botón 📎, pegar o arrastrar sobre la zona de chat; texto opcional si hay adjunto pendiente), **tablero** colaborativo (herramientas, zoom, minimapa, seguimiento de vista del docente, persistencia vía socket + debounce a BD), **videollamadas WebRTC** (oferta/respuesta/ICE por Socket.io).
- **Chat (UX reciente)**: compositor en columna (preview del adjunto pendiente arriba, fila Adjunto / mensaje / Enviar abajo) para evitar desbordes con imágenes grandes. Mensajes con preview y botón **×** para borrar (autor o admin). Menú contextual (clic derecho): copiar texto, nombre de archivo, enlace de API del adjunto, eliminar. Adjunto pendiente: **×** y menú contextual para quitar / copiar nombre. Escucha **`chat:messageDeleted`** para sincronizar borrados.
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
- **Agendamiento en modal**: creación y edición con título, inicio, duración, zona horaria, link compartible y copia al portapapeles. Modal con scroll interno + acciones sticky para mantener botones visibles en pantallas pequeñas.
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
- **Selección en tablero (puntero)**: con varios elementos seleccionados se dibuja un **marco de unión**. Las **flechas del teclado** mueven toda la multiselección, incluidos los **trazos** (todos los puntos), además de texto e imagen; se respeta `locked`.
- **Borrador del tablero**: al tocar un trazo/elemento, elimina el elemento completo (hit-test por segmento para strokes) en lugar de “pintar blanco”.
- **Exportación del tablero a PDF** en cliente con **jsPDF** (recorte al contenido).

### Cupo de sala

- Regla explícita: **1 docente (dueño de la reunión) + hasta 5 participantes que no son el docente** (en la práctica orientado a estudiantes). Implementado en `src/services/reunionParticipacion.js` (`MAX_ESTUDIANTES = 5`) y expuesto en API (`cupo` en `GET /reuniones/room/:roomId`).

---

## 2. Decisiones de negocio reflejadas en código

| Tema | Dónde / qué hace |
|------|------------------|
| Solo **docente** o **admin** crea reuniones | `POST /api/reuniones/` en `src/routes/reuniones.js` |
| Reunión nueva: estado **programada** si la fecha es futura (si no, **activa**), docente auto-inscrito y **Tablero** vacío creado | `src/routes/reuniones.js` |
| Edición y baja lógica de reuniones por dueño/admin | `PATCH /api/reuniones/:reunionId`, `DELETE /api/reuniones/:reunionId` |
| **Cupo** 5 no-docentes + docente | `puedeUnirseParticipar`, mensaje de error fijo en español |
| Chat **privado**: estudiante solo hacia docente; docente puede escribir a estudiante; reglas en Socket y REST | `src/socket/index.js`, `src/routes/mensajes.js` |
| **Adjuntos de chat**: subida HTTP; mensaje con metadatos vía Socket; comprobación de que el fichero exista en disco antes de persistir | `src/routes/reuniones.js`, `src/socket/index.js`, `src/services/chatAdjuntos.js`, `GET .../mensajes/adjunto/...` |
| **Reacciones de mensaje** (toggle por usuario/emoji, persistencia y broadcast) | `src/socket/index.js`, `src/models/mensajeReaccion.js`, `src/routes/mensajes.js`, `public/index.html` |
| **Reacción de sala** desde toolbar inferior | `room:reaction` en `src/socket/index.js`, menú `roomReactionMenu` en `public/index.html` |
| **Borrado de mensaje + adjunto en disco** | `DELETE /api/mensajes/:mensajeId`, emisión `chat:messageDeleted` usando `req.app.get('io')` |
| **room_id** único por reunión (UUID), búsqueda case-insensitive en sala | normalización `normRoomId` / SQL `lower(room_id)` |
| JWT en cabecera para API; token también para Socket (`auth` o `query`) | `src/middleware/auth.js`, `src/socket/index.js` |
| **Grabación** (vídeo + audio mezclado): solo el dueño de la sala (`docenteUsuarioId`); UI oculta para el resto; `recording:state` rechazado en socket si no es el docente | `public/index.html` (`isRoomDocente`, `updateTeacherRecordingControlsVisibility`), `recording:state` en `src/socket/index.js` |
| **Compartir pantalla por solicitud**: invitado solicita, presentador aprueba/rechaza en modal; grant temporal por sala y validación en socket para iniciar share | `public/index.html` (modal + cola + handlers), `src/socket/index.js` (`meet:screenShare:request/response/grant`, `meetScreenShareGrant`) |
| **Anotaciones en pantalla compartida** (estado en RAM, sanitizado, rebroadcast) | `screenshare-annotate:update`, `screenshare-annotate:state` en `src/socket/index.js`; overlay y herramientas en `public/index.html` |
| **API/Socket cross-origin en Render**: helper `toApiUrl`, fallback de origen, y conexión Socket.IO al backend público cuando frontend/backend están separados | `public/index.html` (`API_ORIGIN`, `inferApiOrigin`, `toApiUrl`, `connectSocketIfNeeded`) |
| **Registro público sin escalamiento de rol**: alta siempre como `estudiante`, sin confiar en `rol` del cliente | `src/routes/auth.js`, `public/index.html` |
| **Cambio de rol administrado**: promoción/degradación de rol solo por admin + auditoría básica | `PATCH /api/usuarios/:usuarioId/rol` en `src/routes/usuarios.js` |
| **Control de acceso en sala de espera**: entrada de invitado condicionada a aprobación del presentador (enforcement en socket) | `public/index.html` (wait modal + estado), `src/socket/index.js` (`roomEntryGrant`, `room:entry:*`, gate en `room:join`) |
| **Modelo de reacciones de mensaje**: entidad dedicada `MensajeReaccion` + asociaciones `Mensaje`/`Usuario`; corrige fallos de runtime en `chat:reaction:toggle` cuando el modelo no estaba declarado | `src/models/mensajeReaccion.js`, `src/models/index.js`, `src/socket/index.js` |
| Recurrencia persistida por API en `reuniones.recurrencia` (JSON serializado), validada en backend y consumida por calendario/listado del home | `src/routes/reuniones.js`, `public/index.html` |
| Campos de reunión para **agenda futura** (`fechaHoraFin`, `zonaHoraria`, `recurrencia`, `serieId`) en modelo | `src/models/reunion.js` |

---

## 3. Próximas etapas visibles en el esquema / producto

- **Chat**: pulir UX según feedback (flujo copiar/cortar, toasts, consistencia del borrado y reacciones en todos los clientes).
- **Recurrencia avanzada de serie**: actualmente se guarda/lee regla y se proyectan ocurrencias en cliente para calendario/lista; falta expansión persistida de instancias, excepciones por ocurrencia y edición granular de serie.
- **Migraciones explícitas**: pasar de `sync()` a **sequelize-cli** (o similar) para entornos compartidos y despliegues.
- **Mejoras opcionales**: endurecer reglas de cupo si entraran roles mixtos; export PDF también desde servidor; TURN en producción; tests automatizados.

*(La exportación PDF del tablero en el navegador ya está; las extensiones serían otro canal o formato.)*

---

## 4. Scripts NPM actuales

| Comando | Uso |
|---------|-----|
| `npm start` | Arranca `node server.js` |
| `npm run dev` | Mismo servidor con `node --watch` |

Variables útiles: `PORT`, `JWT_SECRET`, `DATABASE_URL`, `STUN_URLS`, `TURN_*`, `NODE_ENV`.

---

## 5. Sequelize CLI — estado y uso previsto

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

## 6. Buenas prácticas para sesiones en Cursor

- **Actualizar este `README-dev.md`** cuando: se añadan rutas o eventos de socket; cambien modelos o estrategia de BD; se añadan variables de entorno; cambie el cupo o las reglas de chat; cambie la grabación (audio/vídeo) o la mezcla Web Audio; se creen migraciones o scripts.
- Así el siguiente chat o sesión puede usar este archivo como **contexto inicial** (pegar resumen o `@README-dev.md`).

---

*Última actualización de este documento: mayo 2026 — anotaciones en pantalla compartida (sync Socket + RAM), selección múltiple con bbox unión/redimensionado/arrastre y nudge con flechas; tablero con marco de unión y flechas sobre multiselección y trazos.*