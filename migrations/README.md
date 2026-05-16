# Migraciones SQL

El arranque del servidor también crea tablas nuevas vía `ensureReunionAsistenciaMsTable()` en `server.js` (idempotente).

## Aplicar manualmente (SQLite)

```bash
sqlite3 data/app.sqlite < migrations/2026_add_reunion_asistencia_ms.sql
```

## Rollback

```bash
sqlite3 data/app.sqlite < migrations/rollback_2026_add_reunion_asistencia_ms.sql
```

## Postgres

Usar el modelo Sequelize (`src/models/reunionAsistenciaMs.js`) como fuente de verdad; adaptar tipos (`UUID`, `TIMESTAMPTZ`, `BOOLEAN`) si se aplica el SQL a mano.
