require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { DataTypes } = require('sequelize');
const apiRoutes = require('./src/routes');
const { sequelize } = require('./src/models');
const { attachSocketIO } = require('./src/socket');
const { ensureChatAdjRoot } = require('./src/services/chatAdjuntos');
const { repairSqliteReunionGhostReferences } = require('./src/services/sqliteReunionSchemaRepair');

const PORT = Number(process.env.PORT) || 3000;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  const body = { ok: true, service: 'my-own-zoom' };
  if (process.env.NODE_ENV !== 'production') {
    const cop = require('./src/services/copresencia');
    const metricas = require('./src/services/metricasParticipacion');
    body.copresenciaUmbralMs = cop.getUmbralMs();
    body.asistenciaLiveEnabled = cop.isAsistenciaLiveEnabled();
    body.asistenciaMetricasEnabled = metricas.isAsistenciaMetricasEnabled();
  }
  res.json(body);
});

app.get('/api/rtc/config', (_req, res) => {
  const stun = process.env.STUN_URLS;
  const turnUrls = process.env.TURN_URLS;
  const turnUsername = process.env.TURN_USERNAME;
  const turnCredential = process.env.TURN_CREDENTIAL;

  const iceServers = [];
  if (stun) {
    stun.split(',').forEach((u) => iceServers.push({ urls: u.trim() }));
  } else {
    iceServers.push({ urls: 'stun:stun.l.google.com:19302' });
  }
  if (turnUrls && turnUsername && turnCredential) {
    turnUrls.split(',').forEach((u) => {
      iceServers.push({
        urls: u.trim(),
        username: turnUsername,
        credential: turnCredential,
      });
    });
  }
  res.json({ iceServers });
});

app.use('/api', apiRoutes);

app.get('/js/historialAcciones.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'services', 'historialAcciones.js'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const payload = { error: 'Error interno del servidor' };
  if (process.env.NODE_ENV !== 'production' && err && typeof err.message === 'string' && err.message) {
    payload.detail = err.message;
  }
  res.status(500).json(payload);
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

attachSocketIO(io);
app.set('io', io);

async function ensureReunionExceptionColumns() {
  const qi = sequelize.getQueryInterface();
  const tryAdd = async (col, def) => {
    try {
      await qi.addColumn('reuniones', col, def);
    } catch (e) {
      const m = String(e?.message || e?.parent?.message || '');
      if (!/duplicate|already exists|Duplicate column/i.test(m)) {
        console.warn('ensureReunionExceptionColumns:', col, m);
      }
    }
  };
  await tryAdd('parent_reunion_id', { type: DataTypes.UUID, allowNull: true });
  await tryAdd('es_excepcion', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await tryAdd('occurrence_day_key', { type: DataTypes.STRING(12), allowNull: true });

  if (sequelize.getDialect() === 'sqlite') {
    try {
      const quoteIdx = (name) => `"${String(name).replace(/"/g, '""')}"`;
      const [idxRows] = await sequelize.query(
        `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='reuniones'`
      );
      for (const row of idxRows || []) {
        const sql = String(row.sql || '');
        if (!/unique/i.test(sql) || !/room_id/i.test(sql)) continue;
        const iname = String(row.name || '').replace(/"/g, '""');
        await sequelize.query(`DROP INDEX IF EXISTS "${iname}"`);
      }
      const [idxList] = await sequelize.query(`PRAGMA index_list('reuniones')`);
      for (const ix of idxList || []) {
        if (!Number(ix.unique)) continue;
        const nm = ix.name;
        if (!nm) continue;
        const [cols] = await sequelize.query(`PRAGMA index_info(${quoteIdx(nm)})`);
        const hasRoom = (cols || []).some((c) => String(c.name || '').toLowerCase() === 'room_id');
        if (hasRoom) {
          await sequelize.query(`DROP INDEX IF EXISTS ${quoteIdx(nm)}`);
          console.log('[migrate] Eliminado índice único en room_id:', nm);
        }
      }
    } catch (e) {
      console.warn('ensureReunionExceptionColumns: índice room_id', e?.message || e);
    }
  }
}

async function ensureMensajeAdjuntoColumns() {
  const qi = sequelize.getQueryInterface();
  const tryAdd = async (col, def) => {
    try {
      await qi.addColumn('mensajes', col, def);
    } catch (e) {
      const m = String(e?.message || e?.parent?.message || '');
      if (!/duplicate|already exists|Duplicate column/i.test(m)) {
        console.warn('ensureMensajeAdjuntoColumns:', col, m);
      }
    }
  };
  await tryAdd('adjunto_rel_path', { type: DataTypes.STRING(1024), allowNull: true });
  await tryAdd('adjunto_nombre_original', { type: DataTypes.STRING(512), allowNull: true });
  await tryAdd('adjunto_mime', { type: DataTypes.STRING(255), allowNull: true });
  await tryAdd('adjunto_bytes', { type: DataTypes.INTEGER, allowNull: true });
}

function tableDescHasColumn(desc, colName) {
  const n = String(colName).toLowerCase();
  return Object.keys(desc || {}).some((k) => String(k).toLowerCase() === n);
}

/** SQLite: tablas creadas antes con otro esquema; `sync()` intenta índices sobre columnas que aún no existen. */
async function ensureReunionInvitadosColumns() {
  const qi = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  const has = tables.some((t) => String(t).toLowerCase() === 'reunion_invitados');
  if (!has) return;
  const desc = await qi.describeTable('reunion_invitados');
  const tryAdd = async (col, def) => {
    if (tableDescHasColumn(desc, col)) return;
    try {
      await qi.addColumn('reunion_invitados', col, def);
      desc[col] = {};
    } catch (e) {
      const m = String(e?.message || e?.parent?.message || '');
      if (!/duplicate|already exists|Duplicate column/i.test(m)) {
        console.warn('ensureReunionInvitadosColumns:', col, m);
      }
    }
  };
  await tryAdd('reunion_id', { type: DataTypes.UUID, allowNull: true });
  await tryAdd('email', { type: DataTypes.STRING(320), allowNull: true });
  await tryAdd('token_invitacion', { type: DataTypes.STRING(128), allowNull: true });
  await tryAdd('invitado_por_usuario_id', { type: DataTypes.UUID, allowNull: true });
  await tryAdd('estado', {
    type: DataTypes.STRING(32),
    allowNull: true,
    defaultValue: 'pendiente',
  });
  await tryAdd('creado_en', { type: DataTypes.DATE, allowNull: true });
}

async function ensureReunionSolicitudesAccesoColumns() {
  const qi = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  const has = tables.some((t) => String(t).toLowerCase() === 'reunion_solicitudes_acceso');
  if (!has) return;
  const desc = await qi.describeTable('reunion_solicitudes_acceso');
  const tryAdd = async (col, def) => {
    if (tableDescHasColumn(desc, col)) return;
    try {
      await qi.addColumn('reunion_solicitudes_acceso', col, def);
      desc[col] = {};
    } catch (e) {
      const m = String(e?.message || e?.parent?.message || '');
      if (!/duplicate|already exists|Duplicate column/i.test(m)) {
        console.warn('ensureReunionSolicitudesAccesoColumns:', col, m);
      }
    }
  };
  await tryAdd('reunion_id', { type: DataTypes.UUID, allowNull: true });
  await tryAdd('usuario_id', { type: DataTypes.UUID, allowNull: true });
  await tryAdd('estado', {
    type: DataTypes.STRING(32),
    allowNull: true,
    defaultValue: 'pendiente',
  });
  await tryAdd('respondido_por_usuario_id', { type: DataTypes.UUID, allowNull: true });
  await tryAdd('creado_en', { type: DataTypes.DATE, allowNull: true });
}

/** Si quedó un esquema viejo de asistencias, eliminar para que `sync()` recree la tabla. */
async function ensureReunionAsistenciasSchema() {
  const qi = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  const has = tables.some((t) => String(t).toLowerCase() === 'reunion_asistencias');
  if (!has) return;
  let desc;
  try {
    desc = await qi.describeTable('reunion_asistencias');
  } catch {
    return;
  }
  const needed = [
    'reunion_asistencia_id',
    'reunion_id',
    'usuario_id',
    'inicio_sesion',
    'entrada_at',
    'salida_at',
    'presente',
    'asistio',
  ];
  const ok = needed.every((c) => tableDescHasColumn(desc, c));
  if (ok) return;
  try {
    await qi.dropTable('reunion_asistencias');
    console.warn('ensureReunionAsistenciasSchema: esquema incompleto; tabla eliminada para recrearla en sync.');
  } catch (e) {
    console.warn('ensureReunionAsistenciasSchema:', e?.message || e);
  }
}

async function main() {
  ensureChatAdjRoot();
  await repairSqliteReunionGhostReferences(sequelize);
  await ensureReunionExceptionColumns();
  await ensureReunionInvitadosColumns();
  await ensureReunionSolicitudesAccesoColumns();
  await ensureReunionAsistenciasSchema();
  await sequelize.sync();
  await ensureMensajeAdjuntoColumns();

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(
        `Puerto ${PORT} en uso. Cierra el otro proceso (PowerShell: netstat -ano | findstr :${PORT}) o usa otro puerto: $env:PORT=3001; npm start`
      );
      process.exit(1);
      return;
    }
    throw err;
  });

  server.listen(PORT, () => {
    console.log(`Servidor en http://localhost:${PORT}`);
    console.log(`API: http://localhost:${PORT}/api`);
    console.log(`Socket.io adjunto al mismo puerto`);
    console.log(`Cliente: http://localhost:${PORT}/`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
