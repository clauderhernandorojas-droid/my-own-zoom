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

### Persistencia y esquema

- Modelos en `src/models/`: `Usuario`, `Reunion`, `Participa`, `Mensaje`, `Tablero` y asociaciones en `src/models/index.js`.
- **Importante:** el esquema se aplica con **`sequelize.sync()`** al iniciar el servidor (`server.js`). **No** hay carpeta de migraciones `sequelize-cli` versionada en este repo en el estado auditado.

### Cliente (`public/index.html`)

- Una sola página: **login/registro**, listado y creación de **reuniones**, **chat** (general y privado con reglas docente↔estudiante), **tablero** colaborativo (herramientas, zoom, minimapa, seguimiento de vista del docente, persistencia vía socket + debounce a BD), **videollamadas WebRTC** (oferta/respuesta/ICE por Socket.io).
- **Grabación de audio de la reunión**: `MediaRecorder` sobre una mezcla construida con **Web Audio API**. Selector **«Mezcla grabación»**: reunión completa (local + remotos), solo micrófono local o solo audio remoto. Cada ruta pasa por un **`GainNode`** (~−5 dB por rama) y un **`DynamicsCompressor`** maestro suave antes del `MediaStreamDestination`. Las restricciones de captura del mic para esa ruta evitan AGC/NS/AEC agresivos (**conviene auriculares** para limitar acople si varios hablan). Estado de grabación notificado por socket (`recording:state` / `recording:notify`); copias locales respaldadas en **IndexedDB** (`recordings`).
- **Exportación del tablero a PDF** en cliente con **jsPDF** (recorte al contenido).

### Cupo de sala

- Regla explícita: **1 docente (dueño de la reunión) + hasta 5 participantes que no son el docente** (en la práctica orientado a estudiantes). Implementado en `src/services/reunionParticipacion.js` (`MAX_ESTUDIANTES = 5`) y expuesto en API (`cupo` en `GET /reuniones/room/:roomId`).

---

## 2. Decisiones de negocio reflejadas en código

| Tema | Dónde / qué hace |
|------|------------------|
| Solo **docente** o **admin** crea reuniones | `POST /api/reuniones/` en `src/routes/reuniones.js` |
| Reunión nueva en estado **activa** y docente auto-inscrito como participante; **Tablero** vacío creado en la misma transacción de flujo | mismo archivo |
| **Cupo** 5 no-docentes + docente | `puedeUnirseParticipar`, mensaje de error fijo en español |
| Chat **privado**: estudiante solo hacia docente; docente puede escribir a estudiante; reglas en Socket y REST | `src/socket/index.js`, `src/routes/mensajes.js` |
| **room_id** único por reunión (UUID), búsqueda case-insensitive en sala | normalización `normRoomId` / SQL `lower(room_id)` |
| JWT en cabecera para API; token también para Socket (`auth` o `query`) | `src/middleware/auth.js`, `src/socket/index.js` |
| Campos de reunión para **agenda futura** (`fechaHoraFin`, `zonaHoraria`, `recurrencia`, `serieId`) existen en modelo; comentarios «Etapa 2» | `src/models/reunion.js` |

---

## 3. Próximas etapas visibles en el esquema / producto

- **Recurrencia y series**: columnas `recurrencia`, `serie_id` y ventanas `fecha_hora_fin` / `zona_horaria` preparadas; falta lógica de negocio y UI (calendario, instancias de serie).
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

- **Actualizar este `README-dev.md`** cuando: se añadan rutas o eventos de socket; cambien modelos o estrategia de BD; se añadan variables de entorno; cambie el cupo o las reglas de chat; cambie la grabación de audio o la mezcla Web Audio; se creen migraciones o scripts.
- Así el siguiente chat o sesión puede usar este archivo como **contexto inicial** (pegar resumen o `@README-dev.md`).

---

*Última revisión del código descrita aquí: auditoría del repo “My Own Zoom” (Node ≥18, MVP videoconferencia pedagógica).*