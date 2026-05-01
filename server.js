require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const apiRoutes = require('./src/routes');
const { sequelize } = require('./src/models');
const { attachSocketIO } = require('./src/socket');

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
  res.status(500).json({ error: 'Error interno del servidor' });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

attachSocketIO(io);

async function main() {
  await sequelize.sync();
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
