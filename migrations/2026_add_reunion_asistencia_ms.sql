-- Fase C: métricas de sesión persistidas por participante
-- SQLite. Para Postgres usar el modelo Sequelize + ensureReunionAsistenciaMsTable en server.js

CREATE TABLE IF NOT EXISTS reunion_asistencia_ms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reunion_id TEXT NOT NULL,
  inicio_sesion TEXT NOT NULL,
  user_id TEXT NOT NULL,
  teacher_presence_ms INTEGER NOT NULL DEFAULT 0,
  copresence_ms INTEGER NOT NULL DEFAULT 0,
  umbral_ms INTEGER NOT NULL DEFAULT 0,
  fulfilled INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(reunion_id, inicio_sesion, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reunion_asistencia_ms_reunion_inicio
  ON reunion_asistencia_ms(reunion_id, inicio_sesion);

CREATE INDEX IF NOT EXISTS idx_reunion_asistencia_ms_user
  ON reunion_asistencia_ms(user_id);
