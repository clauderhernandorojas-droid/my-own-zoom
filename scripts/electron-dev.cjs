/**
 * Desarrollo Electron: un solo servidor, sin concurrently -k.
 * 1) Si /health responde → no arranca npm start
 * 2) Si no → npm start y espera health
 * 3) electron . con MOJ_ELECTRON_NO_FORK=1, TRUST_HEALTH, NO_RELOAD
 *
 * Uso: npm run electron:dev
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const HEALTH_HOSTS = ['127.0.0.1', 'localhost'];
const POLL_MS = 500;
const MAX_WAIT_MS = Number(process.env.MOJ_ELECTRON_DEV_WAIT_MS) || 120000;
const ROOT = path.join(__dirname, '..');

function pingHealthHost(hostname) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname,
        port: PORT,
        path: '/health',
        family: 4,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200 ? `http://${hostname}:${PORT}` : null);
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function anyHealthOk() {
  for (const host of HEALTH_HOSTS) {
    const base = await pingHealthHost(host);
    if (base) return `${base}/health`;
  }
  return null;
}

async function waitForHealth() {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < MAX_WAIT_MS) {
    attempt += 1;
    const ok = await anyHealthOk();
    if (ok) {
      console.log(`[electron:dev] Servidor listo (${ok}), intento ${attempt}`);
      return ok;
    }
    if (attempt === 1 || attempt % 10 === 0) {
      console.log(`[electron:dev] Esperando /health… intento ${attempt}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`Timeout: sin /health en ${MAX_WAIT_MS}ms (¿npm start falló?)`);
}

function startNpmServer() {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'npm.cmd' : 'npm', ['start'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: isWin,
      env: process.env,
    });
    let settled = false;
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('exit', (code) => {
      if (settled) return;
      if (code != null && code !== 0) {
        settled = true;
        reject(Object.assign(new Error(`npm start terminó con código ${code}`), { code }));
      }
    });
    setImmediate(() => {
      if (!settled) {
        settled = true;
        resolve(child);
      }
    });
  });
}

function resolveElectronExecutable() {
  try {
    return require('electron');
  } catch (_) {
    const isWin = process.platform === 'win32';
    return path.join(ROOT, 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron');
  }
}

function runElectron(healthUrl) {
  const appBase = String(healthUrl || '').replace(/\/health\/?$/, '') || `http://127.0.0.1:${PORT}`;
  const electronBin = resolveElectronExecutable();
  const env = {
    ...process.env,
    MOJ_ELECTRON_NO_FORK: '1',
    MOJ_ELECTRON_NO_RELOAD: '1',
    MOJ_ELECTRON_DEV_TRUST_HEALTH: '1',
    MOJ_APP_URL: appBase,
  };
  if (process.env.MOJ_ELECTRON_LOAD_TIMEOUT_MS) {
    env.MOJ_ELECTRON_LOAD_TIMEOUT_MS = process.env.MOJ_ELECTRON_LOAD_TIMEOUT_MS;
  }
  const child = spawn(electronBin, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env,
  });
  child.on('error', (err) => {
    console.error('[electron:dev] No se pudo lanzar electron:', err.message);
    process.exit(1);
  });
  return child;
}

function killServerChild(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore', shell: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch (_) {}
}

async function main() {
  let serverChild = null;
  let startedServerHere = false;
  let healthUrl = await anyHealthOk();

  if (healthUrl) {
    console.log(`[electron:dev] Servidor ya activo (${healthUrl}), no se ejecuta npm start`);
  } else {
    console.log('[electron:dev] Iniciando npm start…');
    try {
      serverChild = await startNpmServer();
      startedServerHere = true;
    } catch (e) {
      const retry = await anyHealthOk();
      if (retry) {
        console.warn('[electron:dev] npm start falló pero /health responde; continuando:', e.message);
        healthUrl = retry;
      } else {
        throw e;
      }
    }
    if (!healthUrl) {
      healthUrl = await waitForHealth();
    }
  }

  const electronChild = runElectron(healthUrl);

  const keepServer =
    process.env.MOJ_ELECTRON_DEV_KEEP_SERVER === '1' ||
    process.env.MOJ_ELECTRON_DEV_KEEP_SERVER === 'true';

  const cleanup = () => {
    if (startedServerHere && serverChild && !keepServer) {
      console.log('[electron:dev] Deteniendo servidor iniciado por este script…');
      killServerChild(serverChild);
    } else if (startedServerHere && keepServer) {
      console.log('[electron:dev] Servidor dejado en marcha (MOJ_ELECTRON_DEV_KEEP_SERVER=1)');
    }
  };

  electronChild.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => {
    cleanup();
    try {
      electronChild.kill();
    } catch (_) {}
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[electron:dev]', e.message || e);
  process.exit(1);
});
