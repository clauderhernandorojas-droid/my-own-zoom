-- Rollback Fase C: reunion_asistencia_ms

DROP INDEX IF EXISTS idx_reunion_asistencia_ms_user;
DROP INDEX IF EXISTS idx_reunion_asistencia_ms_reunion_inicio;
DROP TABLE IF EXISTS reunion_asistencia_ms;
