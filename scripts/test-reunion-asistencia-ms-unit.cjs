/**
 * Tests unitarios Fase C: upsert reunion_asistencia_ms + selectPersistedSessionMetrics.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

process.env.ASISTENCIA_PERSISTENCE_ENABLED = 'true';

const { v4: uuidv4 } = require('uuid');
const { sequelize, ReunionAsistenciaMs } = require('../src/models');
const persist = require('../src/services/asistenciaMsPersistencia');

const DOCENTE_ID = uuidv4();
const EST1_ID = uuidv4();
const EST2_ID = uuidv4();
const ADMIN_ID = uuidv4();
const REUNION_ID = uuidv4();

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  OK ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${msg}`);
  }
}

function row(userId, copresenceMs, teacherMs = 1000) {
  return {
    reunionId: REUNION_ID,
    inicioSesion: new Date('2026-05-05T19:00:00.000Z'),
    userId,
    teacherPresenceMs: teacherMs,
    copresenceMs,
    umbralMs: 3600000,
    fulfilled: copresenceMs >= 3600000,
    creadoEn: new Date(),
    actualizadoEn: new Date(),
  };
}

async function main() {
  await sequelize.sync();
  const inicio = new Date('2026-05-05T19:00:00.000Z');

  const r1 = await ReunionAsistenciaMs.upsertSessionMetrics({
    reunionId: REUNION_ID,
    inicioSesion: inicio,
    userId: DOCENTE_ID,
    teacherPresenceMs: 5000,
    copresenceMs: 4000,
    umbralMs: 3000,
    fulfilled: true,
  });
  assert(!!r1.id, 'upsert insert devuelve fila');

  await ReunionAsistenciaMs.upsertSessionMetrics({
    reunionId: REUNION_ID,
    inicioSesion: inicio,
    userId: DOCENTE_ID,
    teacherPresenceMs: 9000,
    copresenceMs: 8000,
    umbralMs: 3000,
    fulfilled: true,
  });
  const updated = await ReunionAsistenciaMs.findBySessionUser(REUNION_ID, inicio, DOCENTE_ID);
  assert(updated.copresenceMs === 8000, 'upsert update misma clave UNIQUE');

  const all = await ReunionAsistenciaMs.findAllForSession(REUNION_ID, inicio);
  assert(all.length === 1, 'una fila por usuario');

  await ReunionAsistenciaMs.upsertSessionMetrics({
    reunionId: REUNION_ID,
    inicioSesion: inicio,
    userId: EST1_ID,
    teacherPresenceMs: 9000,
    copresenceMs: 2000,
    umbralMs: 3000,
    fulfilled: false,
  });
  await ReunionAsistenciaMs.upsertSessionMetrics({
    reunionId: REUNION_ID,
    inicioSesion: inicio,
    userId: EST2_ID,
    teacherPresenceMs: 9000,
    copresenceMs: 7000,
    umbralMs: 3000,
    fulfilled: true,
  });

  const rows = await ReunionAsistenciaMs.findAllForSession(REUNION_ID, inicio);

  const pickDocente = persist.selectPersistedSessionMetrics({
    rows,
    docenteUsuarioId: DOCENTE_ID,
    requesterId: EST1_ID,
    requesterRole: 'estudiante',
    asRequester: false,
  });
  assert(pickDocente.session?.selectedBy === 'docente', 'prioridad fila docente');

  const pickAdminMax = persist.selectPersistedSessionMetrics({
    rows: [row(EST1_ID, 1000), row(EST2_ID, 9000)],
    docenteUsuarioId: uuidv4(),
    requesterId: ADMIN_ID,
    requesterRole: 'admin',
    asRequester: false,
  });
  assert(
    pickAdminMax.session?.selectedBy === 'max_copresence' && pickAdminMax.session?.adminView === true,
    'admin sin docente → max copresence'
  );

  const pickAdminReq = persist.selectPersistedSessionMetrics({
    rows: [row(EST1_ID, 1000), row(EST2_ID, 9000)],
    docenteUsuarioId: uuidv4(),
    requesterId: EST1_ID,
    requesterRole: 'admin',
    asRequester: true,
  });
  assert(
    pickAdminReq.session?.adminOverride === true && pickAdminReq.session?.copresenceMs === 1000,
    'admin asRequester → fila requester'
  );

  const pickUser = persist.selectPersistedSessionMetrics({
    rows: [row(EST1_ID, 5000), row(EST2_ID, 1000)],
    docenteUsuarioId: uuidv4(),
    requesterId: EST1_ID,
    requesterRole: 'estudiante',
    asRequester: false,
  });
  assert(pickUser.session?.selectedBy === 'requester', 'no admin → fila requester');

  console.log(`\nResumen: ${passed} OK, ${failed} FAIL`);
  await sequelize.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
