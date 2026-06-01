/**

 * screenShare.js — compartir pantalla en Electron (desktopCapturer + modal propio).

 */

(function (global) {

  /** @type {{ setMediaStatus?: function, log?: function } | null} */

  let deps = null;

  let modalEl = null;

  let pickerResolve = null;



  const IPC_SOURCES_TIMEOUT_MS = 15000;



  function isScreenShareDebugEnabled() {

    try {

      if (global.localStorage?.getItem('MOJ_SCREEN_SHARE_DEBUG') === '1') return true;

    } catch (_) {}

    try {

      if (global.location?.search?.includes('MOJ_SCREEN_SHARE_DEBUG=1')) return true;

    } catch (_) {}

    return global.MOJ_SCREEN_SHARE_DEBUG === true;

  }



  function debugLog(...args) {

    if (!isScreenShareDebugEnabled()) return;

    console.debug('[screen-share]', ...args);

  }



  function status(msg) {

    deps?.setMediaStatus?.(msg);

  }



  function logMsg(msg) {

    deps?.log?.(msg);

  }



  function isAvailable() {

    const ok = !!(global.__MOJ_ELECTRON && global.mojElectron?.getDesktopSources);

    debugLog('isAvailable', ok, {

      electron: !!global.__MOJ_ELECTRON,

      api: typeof global.mojElectron?.getDesktopSources,

    });

    return ok;

  }



  function invokeWithTimeout(promise, ms, label) {

    return new Promise((resolve, reject) => {

      const timer = setTimeout(() => {

        const err = new Error('Tiempo de espera agotado al ' + label + ' (' + ms + ' ms)');

        err.code = 'SCREEN_IPC_TIMEOUT';

        reject(err);

      }, ms);

      Promise.resolve(promise)

        .then((v) => {

          clearTimeout(timer);

          resolve(v);

        })

        .catch((e) => {

          clearTimeout(timer);

          reject(e);

        });

    });

  }



  function buildVideoConstraints(sourceId) {

    return {

      mandatory: {

        chromeMediaSource: 'desktop',

        chromeMediaSourceId: sourceId,

      },

    };

  }



  function buildAudioConstraints(sourceId) {

    return {

      mandatory: {

        chromeMediaSource: 'desktop',

        chromeMediaSourceId: sourceId,

      },

    };

  }



  async function getUserMediaViaDisplayMedia(withAudio) {

    debugLog('getUserMediaViaDisplayMedia fallback', { withAudio });

    return navigator.mediaDevices.getDisplayMedia({

      video: { frameRate: { ideal: 30, max: 30 } },

      audio: withAudio,

    });

  }



  async function getUserMediaForSource(sourceId, withAudio) {

    const video = buildVideoConstraints(sourceId);

    try {

      if (!withAudio) {

        return await navigator.mediaDevices.getUserMedia({ video, audio: false });

      }

      try {

        return await navigator.mediaDevices.getUserMedia({

          video,

          audio: buildAudioConstraints(sourceId),

        });

      } catch (e) {

        logMsg('Audio de sistema no disponible; compartiendo solo vídeo. ' + (e?.message || e));

        status('Audio de sistema no disponible; solo vídeo compartido.');

        return navigator.mediaDevices.getUserMedia({ video, audio: false });

      }

    } catch (mandatoryErr) {

      debugLog('chromeMediaSource getUserMedia failed, trying getDisplayMedia', mandatoryErr);

      console.warn('[screen-share] Captura mandatory falló, reintentando con getDisplayMedia:', mandatoryErr?.message || mandatoryErr);

      try {

        return await getUserMediaViaDisplayMedia(withAudio);

      } catch (displayErr) {

        const err = new Error(

          'No se pudo capturar la pantalla: ' + (displayErr?.message || displayErr)

        );

        err.code = displayErr?.code || mandatoryErr?.code;

        err.cause = displayErr;

        throw err;

      }

    }

  }



  function closePickerModal(result) {

    const resolve = pickerResolve;

    pickerResolve = null;

    modalEl?.classList.add('hidden');

    debugLog('closePickerModal', result == null ? 'cancel' : result);

    if (resolve) resolve(result);

  }



  function renderSourceGrid(container, sources, filterType) {

    container.innerHTML = '';

    const list = filterType

      ? sources.filter((s) => s.type === filterType)

      : sources.slice();

    if (!list.length) {

      const p = document.createElement('p');

      p.className = 'screen-share-picker__empty';

      p.textContent = 'No hay fuentes en esta categoría.';

      container.appendChild(p);

      return;

    }

    for (const src of list) {

      const btn = document.createElement('button');

      btn.type = 'button';

      btn.className = 'screen-share-picker__item';

      btn.setAttribute('data-source-id', src.id);

      if (src.thumbnailDataUrl) {

        const img = document.createElement('img');

        img.className = 'screen-share-picker__thumb';

        img.src = src.thumbnailDataUrl;

        img.alt = '';

        btn.appendChild(img);

      } else {

        const ph = document.createElement('div');

        ph.className = 'screen-share-picker__thumb screen-share-picker__thumb--empty';

        ph.textContent = src.type === 'screen' ? 'Pantalla' : 'Ventana';

        btn.appendChild(ph);

      }

      const name = document.createElement('span');

      name.className = 'screen-share-picker__name';

      name.textContent = src.name;

      btn.appendChild(name);

      btn.addEventListener('click', () => closePickerModal(src.id));

      container.appendChild(btn);

    }

  }



  function ensurePickerModal() {

    if (modalEl) return modalEl;

    modalEl = document.createElement('div');

    modalEl.id = 'screenSharePickerModal';

    modalEl.className = 'profile-modal hidden';

    modalEl.setAttribute('role', 'dialog');

    modalEl.setAttribute('aria-modal', 'true');

    modalEl.setAttribute('aria-labelledby', 'screenSharePickerTitle');

    modalEl.innerHTML =

      '<div class="profile-modal__backdrop" data-action="cancel"></div>' +

      '<div class="profile-modal__card share-req-modal__card screen-share-picker__card">' +

      '<div class="share-req-modal__badge">Compartir pantalla</div>' +

      '<h3 id="screenSharePickerTitle">Elige qué compartir</h3>' +

      '<p class="share-req-modal__hint">Selecciona una pantalla completa o una ventana de aplicación.</p>' +

      '<div class="screen-share-picker__tabs" role="tablist">' +

      '<button type="button" class="screen-share-picker__tab" data-filter="all" aria-pressed="true">Todas</button>' +

      '<button type="button" class="screen-share-picker__tab" data-filter="screen" aria-pressed="false">Pantallas</button>' +

      '<button type="button" class="screen-share-picker__tab" data-filter="window" aria-pressed="false">Ventanas</button>' +

      '</div>' +

      '<div id="screenSharePickerGrid" class="screen-share-picker__grid"></div>' +

      '<div class="share-req-modal__actions">' +

      '<button type="button" id="btnScreenSharePickerCancel" class="btn-muted">Cancelar</button>' +

      '</div></div>';

    document.body.appendChild(modalEl);



    const grid = modalEl.querySelector('#screenSharePickerGrid');

    let currentSources = [];

    let currentFilter = 'all';



    const applyFilter = (filter) => {

      currentFilter = filter;

      modalEl.querySelectorAll('.screen-share-picker__tab').forEach((tab) => {

        const f = tab.getAttribute('data-filter');

        tab.setAttribute('aria-pressed', f === filter ? 'true' : 'false');

      });

      const type = filter === 'all' ? null : filter;

      renderSourceGrid(grid, currentSources, type);

    };



    modalEl.querySelectorAll('.screen-share-picker__tab').forEach((tab) => {

      tab.addEventListener('click', () => applyFilter(tab.getAttribute('data-filter') || 'all'));

    });

    modalEl.querySelector('[data-action="cancel"]')?.addEventListener('click', () => closePickerModal(null));

    modalEl.querySelector('#btnScreenSharePickerCancel')?.addEventListener('click', () =>

      closePickerModal(null)

    );

    modalEl.addEventListener('keydown', (e) => {

      if (e.key === 'Escape') closePickerModal(null);

    });



    modalEl._setSources = (sources) => {

      currentSources = sources;

      applyFilter(currentFilter);

    };



    return modalEl;

  }



  function showSourcePickerModal(sources) {

    return new Promise((resolve) => {

      if (pickerResolve) closePickerModal(null);

      pickerResolve = resolve;

      const modal = ensurePickerModal();

      modal._setSources(sources);

      modal.classList.remove('hidden');

      debugLog('showSourcePickerModal', sources.length, 'sources');

      const first = modal.querySelector('.screen-share-picker__item');

      if (first) first.focus();

    });

  }



  async function acquireDisplayStream(options = {}) {

    if (!isAvailable()) {

      return null;

    }

    const withAudio = !!options.withAudio;

    let sources;

    debugLog('acquireDisplayStream start', { withAudio });

    try {

      sources = await invokeWithTimeout(

        global.mojElectron.getDesktopSources({

          types: ['screen', 'window'],

          thumbnailSize: { width: 280, height: 158 },

          fetchWindowIcons: true,

        }),

        IPC_SOURCES_TIMEOUT_MS,

        'listar fuentes de escritorio'

      );

      debugLog('getDesktopSources returned', sources?.length);

    } catch (e) {

      const msg =

        e?.code === 'SCREEN_PERMISSION_DENIED'

          ? e.message

          : 'No se pudieron listar pantallas y ventanas: ' + (e?.message || e);

      status(msg);

      logMsg(msg);

      console.error('[screen-share]', msg, e);

      throw e;

    }

    if (!Array.isArray(sources) || sources.length === 0) {

      const msg = 'No hay pantallas ni ventanas disponibles para compartir.';

      status(msg);

      logMsg(msg);

      const err = new Error(msg);

      err.code = 'SCREEN_NO_SOURCES';

      throw err;

    }

    const sourceId = await showSourcePickerModal(sources);

    if (!sourceId) {

      debugLog('acquireDisplayStream cancelled by user');

      return null;

    }

    try {

      await global.mojElectron.notifyScreenSourceSelected(sourceId);

    } catch (notifyErr) {

      console.warn('[screen-share] notifyScreenSourceSelected:', notifyErr?.message || notifyErr);

    }

    try {

      return await getUserMediaForSource(sourceId, withAudio);

    } catch (e) {

      const msg = 'No se pudo capturar la fuente seleccionada: ' + (e?.message || e);

      status(msg);

      logMsg(msg);

      console.error('[screen-share]', msg, e);

      throw e;

    }

  }



  function init(options = {}) {

    deps = options;

  }



  const ScreenShareElectron = {

    init,

    isAvailable,

    acquireDisplayStream,

    isScreenShareDebugEnabled,

  };



  global.ScreenShareElectron = ScreenShareElectron;

})(typeof window !== 'undefined' ? window : global);


