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
  res.json({ ok: true, service: 'my-own-zoom' });
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

async function main() {
  ensureChatAdjRoot();
  await repairSqliteReunionGhostReferences(sequelize);
  await ensureReunionExceptionColumns();
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
