const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const { app, BrowserWindow, session, systemPreferences, dialog, ipcMain } = require('electron');

const DEBUG =
  process.env.MOJ_ELECTRON_DEBUG === '1' || process.env.MOJ_ELECTRON_DEBUG === 'true';
const PORT = Number(process.env.PORT) || 3000;
const APP_URL = (process.env.MOJ_APP_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const TRUST_HEALTH =
  process.env.MOJ_ELECTRON_DEV_TRUST_HEALTH === '1' ||
  process.env.MOJ_ELECTRON_DEV_TRUST_HEALTH === 'true';
const MEDIA_PERMISSIONS = new Set(['media', 'display-capture', 'mediaKeySystem']);

const NO_FORK =
  process.env.MOJ_ELECTRON_NO_FORK === '1' || process.env.MOJ_ELECTRON_NO_FORK === 'true';
const EMBED_SERVER =
  process.env.MOJ_ELECTRON_EMBED_SERVER === '1' ||
  process.env.MOJ_ELECTRON_EMBED_SERVER === 'true';

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
let serverStartedByElectron = false;
/** @type {BrowserWindow | null} */
let mainWindow = null;
let appBootstrapComplete = false;
/** @type {(() => void) | null} */
let cancelActiveLoad = null;

function debugLog(...args) {
  if (DEBUG) console.log('[electron:debug]', ...args);
}

function logElectronEnv() {
  const keys = Object.keys(process.env).filter((k) => k.startsWith('MOJ_ELECTRON'));
  if (keys.length) {
    console.log('[electron] Variables:', Object.fromEntries(keys.map((k) => [k, process.env[k]])));
  }
  debugLog('APP_URL=', APP_URL, 'NO_FORK=', NO_FORK, 'TRUST_HEALTH=', TRUST_HEALTH);
}

function bootstrapLoadTimeoutMs() {
  const n = Number(process.env.MOJ_ELECTRON_LOAD_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

function resolveElectronExecutable() {
  try {
    return require('electron');
  } catch (_) {
    const isWin = process.platform === 'win32';
    return path.join(__dirname, 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron');
  }
}

function setupElectronReload() {
  const noReload =
    process.env.MOJ_ELECTRON_NO_RELOAD === '1' || process.env.MOJ_ELECTRON_NO_RELOAD === 'true';
  const enableReload =
    process.env.MOJ_ELECTRON_RELOAD === '1' || process.env.MOJ_ELECTRON_RELOAD === 'true';
  if (app.isPackaged || noReload || !enableReload) return;

  try {
    const electronPath = resolveElectronExecutable();
    require('electron-reload')(
      [path.join(__dirname, 'main.js'), path.join(__dirname, 'preload.js')],
      {
        electron: electronPath,
        hardResetMethod: 'exit',
      }
    );
    console.log('[electron] electron-reload activo (solo main.js y preload.js)');
  } catch (e) {
    console.warn('[electron] electron-reload no disponible:', e?.message || e);
  }
}

setupElectronReload();
app.commandLine.appendSwitch('enable-media-stream');

function pingHealthHost(hostname) {
  return new Promise((resolve) => {
    const opts = {
      hostname,
      port: PORT,
      path: '/health',
      method: 'GET',
      family: 4,
    };
    debugLog('health ping', `${hostname}:${PORT}/health`);
    const req = http.get(opts, (res) => {
      res.resume();
      const ok = res.statusCode === 200;
      debugLog('health result', hostname, res.statusCode, ok);
      resolve(ok ? `http://${hostname}:${PORT}/health` : null);
    });
    req.on('error', (err) => {
      debugLog('health error', hostname, err?.message || err);
      resolve(null);
    });
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function anyHealthOk() {
  const hosts = ['127.0.0.1', 'localhost'];
  for (const host of hosts) {
    const ok = await pingHealthHost(host);
    if (ok) return ok;
  }
  return null;
}

async function waitForHealth(options = {}) {
  const maxMs = options.maxMs ?? 60000;
  const intervalMs = options.intervalMs ?? 500;
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < maxMs) {
    attempt += 1;
    const ok = await anyHealthOk();
    if (ok) {
      console.log(`[electron] /health OK (${ok}) en intento ${attempt}`);
      return ok;
    }
    if (attempt === 1 || attempt % 10 === 0) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(`[electron] Esperando /health… ${elapsed}s (intento ${attempt})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Servidor no disponible tras ${maxMs / 1000}s. Comprueba "npm start" en el puerto ${PORT}.`);
}

function shouldEmbedServer() {
  if (NO_FORK) return false;
  return EMBED_SERVER;
}

function healthWaitOptions() {
  if (TRUST_HEALTH) {
    return { maxMs: 3000, intervalMs: 500 };
  }
  const fromEnv = Number(process.env.MOJ_ELECTRON_HEALTH_WAIT_MS);
  return {
    maxMs: Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 15000,
    intervalMs: 300,
  };
}

async function ensureServerRunning() {
  const existing = await anyHealthOk();
  if (existing) {
    console.log(`[electron] Servidor detectado (${existing}), sin fork`);
    return;
  }

  if (shouldEmbedServer()) {
    console.log('[electron] Iniciando servidor embebido (fork server.js)…');
    serverProcess = fork(path.join(__dirname, 'server.js'), [], {
      stdio: 'inherit',
      env: process.env,
    });
    serverStartedByElectron = true;
    serverProcess.on('exit', (code) => {
      if (code && code !== 0) {
        console.error('[electron] Servidor embebido terminó con código', code);
      }
      serverProcess = null;
      serverStartedByElectron = false;
    });
    await waitForHealth({ maxMs: 120000 });
    return;
  }

  const opts = healthWaitOptions();
  console.log(
    `[electron] Reintentando /health (max ${opts.maxMs}ms${TRUST_HEALTH ? ', confianza dev' : ''})…`
  );
  try {
    await waitForHealth(opts);
    return;
  } catch (_) {
    throw new Error(
      `No hay servidor en ${APP_URL}/health. Ejecuta "npm start" o "npm run electron:dev". ` +
        '(Modo embebido: MOJ_ELECTRON_EMBED_SERVER=1)'
    );
  }
}

function isLocalOrigin(urlOrOrigin) {
  const s = String(urlOrOrigin || '');
  return (
    s.startsWith('http://localhost') ||
    s.startsWith('http://127.0.0.1') ||
    s.startsWith('https://localhost') ||
    s.startsWith('https://127.0.0.1')
  );
}

function normalizeLocalOrigin(origin) {
  return String(origin || '')
    .replace(/^http:\/\/127\.0\.0\.1/i, 'http://localhost')
    .replace(/^https:\/\/127\.0\.0\.1/i, 'https://localhost');
}

function localOriginsMatch(targetUrl, loadedUrl) {
  if (!loadedUrl || loadedUrl.startsWith('data:')) return false;
  try {
    const a = normalizeLocalOrigin(new URL(targetUrl).origin);
    const b = normalizeLocalOrigin(new URL(loadedUrl).origin);
    return a === b;
  } catch (_) {
    return String(loadedUrl).startsWith(String(targetUrl).replace(/\/$/, ''));
  }
}

function setupMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = details?.requestingUrl || webContents.getURL();
    if (!isLocalOrigin(url)) {
      callback(false);
      return;
    }
    if (MEDIA_PERMISSIONS.has(permission)) {
      callback(true);
      return;
    }
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (!isLocalOrigin(requestingOrigin)) return false;
    return MEDIA_PERMISSIONS.has(permission);
  });
}

async function requestOsMediaAccessIfNeeded() {
  if (process.platform !== 'darwin') return;
  try {
    const cam = systemPreferences.getMediaAccessStatus('camera');
    if (cam !== 'granted') await systemPreferences.askForMediaAccess('camera');
  } catch (e) {
    console.warn('[electron] Permiso cámara macOS:', e?.message || e);
  }
  try {
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    if (mic !== 'granted') await systemPreferences.askForMediaAccess('microphone');
  } catch (e) {
    console.warn('[electron] Permiso micrófono macOS:', e?.message || e);
  }
}

function waitingPageHtml(message, extraHtml = '') {
  const text = String(message || 'Esperando servidor…').replace(/</g, '&lt;');
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem;background:#0f172a;color:#e2e8f0"><h1>My Own Zoom</h1><p>${text}</p>${extraHtml}</body></html>`
  )}`;
}

function markBootstrapComplete(currentUrl) {
  if (!appBootstrapComplete) {
    appBootstrapComplete = true;
    console.log('[electron] Bootstrap completado:', currentUrl);
  }
}

async function showErrorInWindow(win, message) {
  console.error('[electron]', message);
  if (appBootstrapComplete) {
    dialog.showErrorBox('My Own Zoom — Electron', message);
    return;
  }
  if (cancelActiveLoad) {
    cancelActiveLoad();
    cancelActiveLoad = null;
  }
  const html = waitingPageHtml(message);
  try {
    await loadAppUrl(win, html, { isDataUrl: true, retries: 0, timeoutMs: 5000 });
  } catch (_) {
    try {
      await win.loadURL(html);
    } catch (_) {}
  }
  dialog.showErrorBox('My Own Zoom — Electron', message);
}

function loadAppUrl(win, targetUrl, options = {}) {
  const isDataUrl = options.isDataUrl ?? String(targetUrl).startsWith('data:');
  const isBootstrap = options.bootstrap === true;

  if (appBootstrapComplete && isBootstrap) {
    return Promise.resolve(win.webContents.getURL());
  }
  if (appBootstrapComplete && !options.forceNavigate) {
    return Promise.resolve(win.webContents.getURL());
  }

  const timeoutMs =
    options.timeoutMs ??
    (isDataUrl ? 5000 : isBootstrap ? bootstrapLoadTimeoutMs() : 10000);
  const retries = options.retries ?? (isBootstrap ? 1 : 0);

  if (cancelActiveLoad) {
    cancelActiveLoad();
    cancelActiveLoad = null;
  }

  const attemptLoad = (remainingRetries) =>
    new Promise((resolve, reject) => {
      const wc = win.webContents;
      let settled = false;
      let timer = null;

      const removeListeners = () => {
        wc.removeListener('did-finish-load', onFinish);
        wc.removeListener('did-fail-load', onFail);
        wc.removeListener('dom-ready', onDomReady);
      };

      const tryAcceptUrl = (current) => {
        if (isDataUrl && current.startsWith('data:')) {
          return current;
        }
        if (!isDataUrl && localOriginsMatch(targetUrl, current)) {
          if (isBootstrap) markBootstrapComplete(current);
          return current;
        }
        return null;
      };

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        removeListeners();
        if (cancelActiveLoad) cancelActiveLoad = null;

        if (err) {
          const current = wc.getURL();
          if (isBootstrap && localOriginsMatch(targetUrl, current)) {
            markBootstrapComplete(current);
            resolve(current);
            return;
          }
          if (appBootstrapComplete) {
            debugLog('error de carga ignorado tras bootstrap:', err.message);
            resolve(current);
            return;
          }
          reject(err);
          return;
        }
        resolve(result);
      };

      const onFinish = () => {
        const accepted = tryAcceptUrl(wc.getURL());
        if (accepted) finish(null, accepted);
      };

      const onDomReady = () => {
        const accepted = tryAcceptUrl(wc.getURL());
        if (accepted) finish(null, accepted);
      };

      const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame === false) return;
        console.error('[electron] did-fail-load', errorCode, errorDescription, validatedURL);
        const err = new Error(
          `${errorDescription || 'Error de carga'} (${errorCode}) — ${validatedURL}`
        );
        if (remainingRetries > 0) {
          debugLog('reintento loadURL', remainingRetries);
          settled = true;
          if (timer) clearTimeout(timer);
          removeListeners();
          if (cancelActiveLoad) cancelActiveLoad = null;
          setTimeout(() => {
            attemptLoad(remainingRetries - 1).then(resolve).catch(reject);
          }, 400);
          return;
        }
        finish(err);
      };

      cancelActiveLoad = () => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          removeListeners();
        }
      };

      timer = setTimeout(() => {
        const current = wc.getURL();
        const loading = wc.isLoading();
        debugLog('timeout load', {
          targetUrl,
          current,
          loading,
          appBootstrapComplete,
          timeoutMs,
        });
        if (tryAcceptUrl(current)) {
          finish(null, current);
          return;
        }
        if (appBootstrapComplete) {
          finish(null, current);
          return;
        }
        finish(new Error(`Timeout cargando URL tras ${timeoutMs}ms: ${targetUrl}`));
      }, timeoutMs);

      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
      wc.on('dom-ready', onDomReady);

      debugLog('loadURL →', targetUrl);
      wc.loadURL(targetUrl).catch((e) => finish(e));
    });

  return attemptLoad(retries);
}

function createBrowserWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  appBootstrapComplete = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
    if (isMainFrame) {
      console.error('[electron] did-fail-load (main)', code, desc, url);
    }
  });

  mainWindow.webContents.on('dom-ready', () => {
    debugLog('dom-ready', mainWindow?.webContents.getURL());
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[electron] render-process-gone', details?.reason, details?.exitCode);
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.on('closed', () => {
    if (cancelActiveLoad) {
      cancelActiveLoad();
      cancelActiveLoad = null;
    }
    mainWindow = null;
    appBootstrapComplete = false;
  });

  return mainWindow;
}

async function createWindow() {
  const win = createBrowserWindow();
  const skipWaitingPage = TRUST_HEALTH && (await anyHealthOk());

  if (!skipWaitingPage) {
    await loadAppUrl(win, waitingPageHtml('Comprobando servidor…'), {
      isDataUrl: true,
      retries: 0,
      timeoutMs: 5000,
    });
  }

  try {
    await ensureServerRunning();
  } catch (e) {
    const msg = e?.message || String(e);
    await showErrorInWindow(win, msg);
    return;
  }

  await requestOsMediaAccessIfNeeded();

  const target = `${APP_URL}/`;
  console.log('[electron] Cargando', target);
  try {
    await loadAppUrl(win, target, {
      bootstrap: true,
      retries: 1,
      timeoutMs: bootstrapLoadTimeoutMs(),
    });
  } catch (e) {
    const msg = e?.message || String(e);
    await showErrorInWindow(win, `No se pudo cargar ${target}\n\n${msg}`);
    return;
  }

  const openDevTools =
    !app.isPackaged &&
    (process.env.MOJ_ELECTRON_DEVTOOLS === '1' || process.env.MOJ_ELECTRON_DEVTOOLS === 'true');
  if (openDevTools) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function stopEmbeddedServer() {
  if (serverProcess && serverStartedByElectron) {
    try {
      serverProcess.kill();
    } catch (_) {}
    serverProcess = null;
    serverStartedByElectron = false;
  }
}

function registerContentProtectionIpc() {
  ipcMain.handle('moj:set-content-protection', (_event, payload) => {
    const enable = !!(payload && payload.enable);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setContentProtection(enable);
    }
    return { ok: true, enabled: enable };
  });
}

app.whenReady().then(async () => {
  try {
    require('./electron/screenShareIpc.cjs').register();
  } catch (e) {
    console.error('[electron] screen share IPC register failed:', e?.message || e);
  }
  registerContentProtectionIpc();
  logElectronEnv();
  setupMediaPermissions();
  try {
    await createWindow();
  } catch (e) {
    console.error('[electron]', e?.message || e);
    const win = createBrowserWindow();
    await showErrorInWindow(win, e?.message || String(e));
  }
});

app.on('window-all-closed', () => {
  stopEmbeddedServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopEmbeddedServer();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((e) => console.error('[electron]', e?.message || e));
  }
});
