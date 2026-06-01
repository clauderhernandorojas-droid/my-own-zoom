/**

 * IPC de compartir pantalla: desktopCapturer en main (no expuesto al renderer).

 */

const { ipcMain, desktopCapturer, systemPreferences, session } = require('electron');



const DEFAULT_THUMB = { width: 280, height: 158 };

const DEBUG =

  process.env.MOJ_ELECTRON_DEBUG === '1' || process.env.MOJ_ELECTRON_DEBUG === 'true';



const CHANNEL_GET_SOURCES = 'moj:get-desktop-sources';

const CHANNEL_NOTIFY_SELECTED = 'moj:notify-screen-source-selected';



/** @type {Map<number, { sourceId: string, at: number }>} */

const pendingSourceByWebContentsId = new Map();

/** Última fuente elegida (fallback si el handler no resuelve webContents.id). */

let lastPendingSourceId = null;

let displayMediaHandlerRegistered = false;



function debugLog(...args) {

  if (DEBUG) console.log('[electron:screen-share]', ...args);

}



function webContentsIdFromDisplayRequest(request) {

  try {

    const frame = request?.frame;

    if (!frame) return null;

    const wc = frame.webContents;

    return wc?.id ?? null;

  } catch (_) {

    return null;

  }

}



function checkMacScreenPermission() {

  if (process.platform !== 'darwin') return null;

  try {

    const status = systemPreferences.getMediaAccessStatus('screen');

    if (status === 'denied' || status === 'restricted') {

      return {

        code: 'SCREEN_PERMISSION_DENIED',

        message:

          'Permiso de grabación de pantalla denegado. En macOS: Ajustes → Privacidad y seguridad → Grabación de pantalla → activa Electron.',

      };

    }

  } catch (e) {

    console.warn('[electron] No se pudo comprobar permiso de pantalla:', e?.message || e);

  }

  return null;

}



function serializeSource(source) {

  let thumbnailDataUrl = null;

  try {

    if (source.thumbnail && !source.thumbnail.isEmpty()) {

      thumbnailDataUrl = source.thumbnail.toDataURL();

    }

  } catch (_) {}

  return {

    id: source.id,

    name: source.name || 'Fuente sin nombre',

    display_id: source.display_id,

    type: source.id.startsWith('screen:') ? 'screen' : 'window',

    thumbnailDataUrl,

  };

}



async function getDesktopSources(opts = {}) {

  const permErr = checkMacScreenPermission();

  if (permErr) {

    const err = new Error(permErr.message);

    err.code = permErr.code;

    throw err;

  }



  const types = Array.isArray(opts.types) && opts.types.length ? opts.types : ['screen', 'window'];

  const thumb = opts.thumbnailSize || DEFAULT_THUMB;

  const sources = await desktopCapturer.getSources({

    types,

    thumbnailSize: thumb,

    fetchWindowIcons: opts.fetchWindowIcons !== false,

  });

  return sources.map(serializeSource);

}



async function resolveDesktopSourceById(sourceId) {

  const id = String(sourceId || '').trim();

  if (!id) return null;

  const sources = await desktopCapturer.getSources({

    types: ['screen', 'window'],

    thumbnailSize: DEFAULT_THUMB,

    fetchWindowIcons: false,

  });

  return sources.find((s) => s.id === id) || null;

}



function registerDisplayMediaHandler() {

  if (displayMediaHandlerRegistered) return;

  displayMediaHandlerRegistered = true;



  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {

    try {

      const wcId = webContentsIdFromDisplayRequest(request);

      const pending = wcId != null ? pendingSourceByWebContentsId.get(wcId) : null;

      const sourceId = pending?.sourceId || lastPendingSourceId;

      debugLog('setDisplayMediaRequestHandler', { wcId, sourceId });



      let videoSource = null;

      if (sourceId) {

        videoSource = await resolveDesktopSourceById(sourceId);

      }

      if (!videoSource) {

        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });

        videoSource = sources[0] || null;

      }

      if (!videoSource) {

        callback({});

        return;

      }

      const result = { video: videoSource };

      if (request.audioRequested) {

        result.audio = 'loopback';

      }

      callback(result);

    } catch (e) {

      console.error('[electron] setDisplayMediaRequestHandler:', e?.message || e);

      callback({});

    }

  });

  debugLog('setDisplayMediaRequestHandler registered');

}



function removeIpcHandler(channel) {

  try {

    if (typeof ipcMain.removeHandler === 'function') {

      ipcMain.removeHandler(channel);

    }

  } catch (_) {}

}



function register() {

  removeIpcHandler(CHANNEL_GET_SOURCES);

  removeIpcHandler(CHANNEL_NOTIFY_SELECTED);



  ipcMain.handle(CHANNEL_GET_SOURCES, async (_event, opts) => {

    try {

      debugLog('get-desktop-sources request');

      const list = await getDesktopSources(opts);

      debugLog('get-desktop-sources ok, count=', list.length);

      return list;

    } catch (e) {

      const code = e?.code ? ` [${e.code}]` : '';

      console.error('[electron] get-desktop-sources:' + code, e?.message || e);

      throw e;

    }

  });



  ipcMain.handle(CHANNEL_NOTIFY_SELECTED, async (event, payload) => {

    const sourceId = String(payload?.sourceId || '').trim();

    const wcId = event.sender?.id;

    if (sourceId) {

      lastPendingSourceId = sourceId;

      if (wcId != null) {

        pendingSourceByWebContentsId.set(wcId, { sourceId, at: Date.now() });

      }

      console.log('[electron] Screen share source selected:', sourceId, '(wc', wcId + ')');

    }

    return { ok: true, displayMediaHandler: displayMediaHandlerRegistered };

  });



  registerDisplayMediaHandler();

  console.log('[electron] screen share IPC registered');

}



module.exports = {

  register,

  getDesktopSources,

  registerDisplayMediaHandler,

};


