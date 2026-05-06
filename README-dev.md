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
- **Compartir pantalla y tablero**: se añadió selección desde menú (`Pantalla` / `Tablero`). Al compartir pantalla, se usa `getDisplayMedia`, se reemplaza la pista de vídeo enviada por WebRTC y al terminar se restaura la cámara automáticamente.
- **Grabación de la reunión (docente)**: solo el **dueño de la sala** (`reunion.docenteUsuarioId`) ve los controles; el servidor rechaza `recording:state` para otros. Un único botón **grabar vídeo** con `MediaRecorder` sobre canvas compuesto (1280×720 @ ~24 fps) + mezcla Web Audio. Se retiró la casilla “incluir tablero”; la composición prioriza **pantalla compartida** cuando está activa y usa cámaras como franja contextual (arriba o a la derecha según layout). **IndexedDB** y `recording:state` / `recording:notify`.
- **Tablero**: cuadrícula punteada sutil y vista sin borde final visible (experiencia “infinita” práctica). El minimapa pasó a marco dinámico basado en contenido + viewport en lugar de límites fijos.
- **Home/Lobby rediseñado**: estilo unificado negro/blanco/azul, acciones rápidas, calendario y lista de próximas reuniones. Se removió el flujo manual de `Room ID` y la entrada se hace por acciones directas por reunión (`Entrar`, `Editar`, `Cupo`, `Eliminar`, `Copiar link`).
- **Agendamiento en modal**: creación y edición con título, inicio, duración, zona horaria, link compartible y copia al portapapeles. Modal con scroll interno + acciones sticky para mantener botones visibles en pantallas pequeñas.
- **Recurrencia en UI**: `No repetir`, `Diario`, `Semanal`, `Mensual`, `Personalizado` (base diaria/semanal/mensual, intervalo y selección de días con chips). Fin de secuencia con modo `Nunca` o `Hasta fecha`, resumen legible de la regla y validación visual/funcional cuando la fecha fin queda antes del inicio.
- **Nombre obligatorio para entrar**: mini-modal para capturar nombre visible antes de unirse a reunión, con persistencia local por usuario.
- **Franja de vídeo en sala**: una fila con marca **My Own Zoom** + botón **Copiar enlace** (sin UUID visible bajo el título); vídeos a la derecha. `#btnToggleChat` y `#btnRoomViewToggle` existen ocultos solo para sincronizar JS con el panel azul de layout/chat.
- **Tablero**: menús laterales (colores, emojis, grosor, tamaño de texto, más) fuera de la barra vertical; posición **`fixed`** para evitar recortes y scroll fantasma; barra vertical acotada en altura (`max-height`) sin estirar vacío.
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
| **Borrado de mensaje + adjunto en disco** | `DELETE /api/mensajes/:mensajeId`, emisión `chat:messageDeleted` usando `req.app.get('io')` |
| **room_id** único por reunión (UUID), búsqueda case-insensitive en sala | normalización `normRoomId` / SQL `lower(room_id)` |
| JWT en cabecera para API; token también para Socket (`auth` o `query`) | `src/middleware/auth.js`, `src/socket/index.js` |
| **Grabación** (vídeo + audio mezclado): solo el dueño de la sala (`docenteUsuarioId`); UI oculta para el resto; `recording:state` rechazado en socket si no es el docente | `public/index.html` (`isRoomDocente`, `updateTeacherRecordingControlsVisibility`), `recording:state` en `src/socket/index.js` |
| Recurrencia persistida por API en `reuniones.recurrencia` (JSON serializado), validada en backend y consumida por calendario/listado del home | `src/routes/reuniones.js`, `public/index.html` |
| Campos de reunión para **agenda futura** (`fechaHoraFin`, `zonaHoraria`, `recurrencia`, `serieId`) en modelo | `src/models/reunion.js` |

---

## 3. Próximas etapas visibles en el esquema / producto

- **Chat**: pulir UX según feedback (flujo copiar/cortar, toasts, consistencia del borrado en todos los clientes).
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

*Última actualización de este documento: mayo 2026 — además de lo anterior: sala (franja vídeo + Copiar enlace sin texto de estado bajo el título), tablero con menús laterales en `fixed`, chat con compositor apilado, borrado de mensajes/adjuntos (`DELETE` + `chat:messageDeleted`), menú contextual y `log()` sin duplicar en strip de eventos.*