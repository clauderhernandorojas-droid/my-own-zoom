/**
 * Smoke: layout share modular (ClientEnv, fachada, syncShareLayout).
 * node scripts/test-web-layout-modules.cjs
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "public", "js");

function makeSandbox(extra = {}) {
  const shell = {
    classList: {
      contains: (c) => {
        if (extra._sharePresenterFocus) return c === "room-shell--presenter-focus";
        if (extra._shareRemote) return c === "room-shell--remote-screen-dominant";
        return false;
      },
    },
  };
  const sandbox = {
    window: {},
    document: {
      getElementById: (id) => {
        if (id === "roomShell") return shell;
        if (id === "roomRemoteScreenStage") return { querySelector: () => null };
        return null;
      },
      querySelector: () => null,
      readyState: "complete",
      addEventListener: () => {},
      documentElement: { classList: { contains: () => false } },
    },
    localStorage: {
      _data: {},
      getItem(k) {
        return this._data[k] ?? null;
      },
      setItem(k, v) {
        this._data[k] = v;
      },
    },
    console: { log: () => {}, warn: () => {} },
    requestAnimationFrame(fn) {
      fn();
    },
    ScreenOverlay: { syncWithStage() {} },
    ...extra,
  };
  sandbox.window = sandbox;
  return sandbox;
}

function run(file, sandbox) {
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx, {
    filename: file,
  });
}

let failed = 0;

const env = makeSandbox();
run("clientEnv.js", env);
if (!env.ClientEnv?.isWeb?.() || env.ClientEnv?.isElectron?.()) {
  console.error("clientEnv: isWeb base");
  failed++;
}
env.localStorage.setItem("moj_token", "x");
if (env.ClientEnv.isElectron()) {
  console.error("clientEnv: must not use localStorage for electron detection");
  failed++;
}

const envE = makeSandbox({
  __MOJ_ELECTRON: true,
  mojElectron: { getDesktopSources: () => [] },
});
run("clientEnv.js", envE);
if (!envE.ClientEnv?.isElectron?.()) {
  console.error("clientEnv: mojElectron defensive");
  failed++;
}

const share = makeSandbox({ _shareRemote: true });
run("clientEnv.js", share);
if (!share.ClientEnv?.isShareLayoutActive?.()) {
  console.error("clientEnv: isShareLayoutActive");
  failed++;
}

const stubLm = {
  init() {},
  isActive: () => false,
  syncShareLayout() {},
  onShareLayoutChange() {},
  onLeaveRoom() {},
  onEnterRoom() {},
};
const facade = makeSandbox({ LayoutModule: stubLm });
run("clientEnv.js", facade);
facade.LayoutModule = stubLm;
run("WebLayoutOverrides.js", facade);
if (typeof facade.WebLayoutOverrides?.syncShareLayout !== "function") {
  console.error("WebLayoutOverrides must expose syncShareLayout");
  failed++;
}

const facadeE = makeSandbox({ __MOJ_ELECTRON: true, LayoutModule: stubLm });
run("clientEnv.js", facadeE);
facadeE.LayoutModule = stubLm;
run("WebLayoutOverrides.js", facadeE);
if (typeof facadeE.WebLayoutOverrides?.syncShareLayout !== "function") {
  console.error("WebLayoutOverrides electron must delegate (no stubs)");
  failed++;
}

run("modules/FloatPanelModule.js", makeSandbox({ UiFloatClamp: {} }));
run("modules/ChatRoomUiModule.js", makeSandbox());
run("modules/ToolbarModule.js", makeSandbox());
const lmBox = makeSandbox({
  FloatPanelModule: {
    init() {},
    activate() {},
    deactivate() {},
    onShareLayoutChange() {},
    isActive: () => false,
  },
  ParticipantsModule: { init() {}, destroy() {}, update() {} },
  ChatRoomUiModule: { init() {} },
  ToolbarModule: { initWebLayerPolicy() {} },
  $: (id) => (id === "roomShell" ? lmBox._shell : null),
});
lmBox._shell = {
  classList: {
    _set: new Set(),
    contains(c) {
      return this._set.has(c);
    },
    toggle(c, on) {
      if (on) this._set.add(c);
      else this._set.delete(c);
    },
  },
};
run("store/actions.js", lmBox);
run("store/reducer.js", lmBox);
run("store/AppState.js", lmBox);
run("clientEnv.js", lmBox);
run("modules/LayoutModule.js", lmBox);
if (!lmBox.LayoutModule?.syncShareLayout) {
  console.error("LayoutModule.syncShareLayout missing");
  failed++;
}
lmBox.LayoutModule.init({
  $: lmBox.$,
  getActiveRoomId: () => "room1",
});
lmBox.AppState.dispatch({
  type: lmBox.MojActionTypes.SHARE_REMOTE_SET,
  active: true,
  userId: "u1",
});
lmBox.LayoutModule.syncShareLayout();
if (!lmBox._shell.classList.contains("room-shell--share-layout-modular")) {
  console.error("LayoutModule: share-layout-modular must apply when store layout is share");
  failed++;
}

const stubNotif = { initNotificaciones() {}, getTotalUnread: () => 3 };
const n = makeSandbox({ Notificaciones: stubNotif });
run("modules/NotificationsModule.js", n);
if (n.NotificationsModule?.getTotalUnread?.() !== 3) {
  console.error("NotificationsModule facade");
  failed++;
}

const overlayCssPath = path.join(__dirname, "..", "public", "css", "screenOverlay.css");
const overlayCss = fs.readFileSync(overlayCssPath, "utf8");
if (
  !/screen-overlay-stack--annotate-active\s+\.screen-overlay-canvas[\s\S]*?pointer-events:\s*auto\s*!important/.test(
    overlayCss
  )
) {
  console.error("screenOverlay.css: annotate-active canvas must allow pointer-events auto");
  failed++;
}
if (
  !/screen-overlay-stack--tool-pointer\.screen-overlay-stack--toolbar-open\s+\.screen-overlay-canvas[\s\S]*?pointer-events:\s*auto\s*!important/.test(
    overlayCss
  )
) {
  console.error("screenOverlay.css: pointer tool + toolbar-open canvas must allow pointer-events auto");
  failed++;
}
if (!overlayCss.includes("--screen-overlay-pointer-cursor")) {
  console.error("screenOverlay.css: yellow arrow pointer cursor required");
  failed++;
}
if (
  /\.screen-overlay-stack--annotate-active\s+\.screen-overlay-canvas\s*\{[^}]*cursor:\s*crosshair/.test(
    overlayCss
  )
) {
  console.error("screenOverlay.css: crosshair must not apply to all annotate-active tools");
  failed++;
}

const layoutShellCss = fs.readFileSync(
  path.join(__dirname, "..", "public", "css", "modules", "layoutShell.css"),
  "utf8"
);
if (/object-fit:\s*cover\s*!important/.test(layoutShellCss)) {
  console.error("layoutShell.css: share video should use object-fit contain for ink alignment");
  failed++;
}
if (!layoutShellCss.includes("html.moj-web-client") || !layoutShellCss.includes("presenter-focus .room-bottom-toolbar")) {
  console.error("layoutShell.css: web-only presenter bottom toolbar override required");
  failed++;
}

const lmSrc = fs.readFileSync(path.join(root, "modules", "LayoutModule.js"), "utf8");
if (!/if\s*\(\s*!initialized\s*&&\s*deps\s*\)\s*init\s*\(\s*deps\s*\)/.test(lmSrc)) {
  console.error("LayoutModule.js: syncShareLayout must call init(deps) when !initialized");
  failed++;
}
if (!lmSrc.includes("onEnterRoom") || !/resyncScreenOverlay/.test(lmSrc)) {
  console.error("LayoutModule.js: onEnterRoom must resync overlay");
  failed++;
}
if (!lmSrc.includes("SHARE_MODULAR_CLASS") || !lmSrc.includes("applyShareModularClass")) {
  console.error("LayoutModule.js: must apply SHARE_MODULAR_CLASS during share");
  failed++;
}
if (!lmSrc.includes("updateFromStore") || !/AppState/.test(lmSrc)) {
  console.error("LayoutModule.js: must observe AppState via updateFromStore");
  failed++;
}
if (!lmSrc.includes("ParticipantsModule")) {
  console.error("LayoutModule.js: must delegate participants panel to ParticipantsModule");
  failed++;
}
if (/syncParticipantsPanel[\s\S]{0,400}activate[\s\S]{0,120}deactivate/.test(lmSrc)) {
  console.error("LayoutModule.js: must not activate+deactivate participants in same frame");
  failed++;
}
if (/ChatRoomUiModule\?\.\onShareLayoutEnter/.test(lmSrc)) {
  console.error("LayoutModule.js: must not call onShareLayoutEnter directly (use AppState effects)");
  failed++;
}
if (!lmSrc.includes("resyncScreenOverlay") || !/ScreenOverlay\.syncWithStage/.test(lmSrc)) {
  console.error("LayoutModule.js: resyncScreenOverlay must call ScreenOverlay.syncWithStage");
  failed++;
}
if (!lmSrc.includes("initParticipantsPanel") && !lmSrc.includes("ParticipantsModule")) {
  console.error("LayoutModule.js: participants init missing");
  failed++;
}
if (!lmSrc.includes("deactivateShareLayoutUi")) {
  console.error("LayoutModule.js: must use deactivateShareLayoutUi on leave/stop share");
  failed++;
}
if (/syncParticipantsPanel[\s\S]{0,400}activate[\s\S]{0,120}deactivate/.test(lmSrc)) {
  console.error("LayoutModule.js: syncParticipantsPanel must not deactivate immediately after activate");
  failed++;
}

const cruSrc = fs.readFileSync(path.join(root, "modules", "ChatRoomUiModule.js"), "utf8");
if (/isWebEnv\(\)\s*&&\s*!chatHidden/.test(cruSrc)) {
  console.error("ChatRoomUiModule.js: toggleFromBar must close chat in all environments, not only web");
  failed++;
}
if (!layoutShellCss.includes("display: flex !important") || !layoutShellCss.includes("flex-direction: column")) {
  console.error("layoutShell.css: chat overlay must override presenterFocus display:none during share");
  failed++;
}

const cruBox = makeSandbox({ ChatModule: { openChatFromBar() {} } });
run("modules/ChatRoomUiModule.js", cruBox);
let chatHiddenProbe = true;
cruBox.ChatRoomUiModule.init({
  getChatPanelHidden: () => chatHiddenProbe,
  setChatPanelHidden: (h) => {
    chatHiddenProbe = !!h;
  },
});
cruBox.ChatModule.openChatFromBar = () => {
  chatHiddenProbe = false;
};
cruBox.ChatRoomUiModule.toggleFromBar();
if (chatHiddenProbe !== false) {
  console.error("ChatRoomUiModule: toggleFromBar should open chat when hidden");
  failed++;
}
cruBox.ChatRoomUiModule.toggleFromBar();
if (chatHiddenProbe !== true) {
  console.error("ChatRoomUiModule: toggleFromBar should close chat when visible");
  failed++;
}

const soSrc = fs.readFileSync(path.join(root, "screenOverlay.js"), "utf8");
if (!soSrc.includes("ensureFab") || !/ensureOverlayUiLayer|screenOverlayUiLayer/.test(soSrc)) {
  console.error("screenOverlay.js: ensureFab must mount in screenOverlayUiLayer");
  failed++;
}
if (!soSrc.includes("isFabStageReady") || !soSrc.includes("isOverlayInkReady")) {
  console.error("screenOverlay.js: FAB stage gate must be separate from ink gate");
  failed++;
}
if (!/fabHostEl\.isConnected/.test(soSrc)) {
  console.error("screenOverlay.js: ensureFab must reset disconnected fabHostEl");
  failed++;
}
if (!/scheduleFabPositionWhenReady/.test(soSrc)) {
  console.error("screenOverlay.js: deferred FAB reposition when layout not ready");
  failed++;
}
if (!soSrc.includes("fabConnected") || !soSrc.includes("fabVisible")) {
  console.error("screenOverlay.js: inspectLayout must expose fabConnected/fabVisible");
  failed++;
}

if (!/min-height:\s*100%/.test(overlayCss) || !/z-index:\s*1900/.test(overlayCss)) {
  console.error("screenOverlay.css: share ui-layer min-height and FAB z-index 1900 required");
  failed++;
}
if (!/\.screen-overlay-fab-host[\s\S]*position:\s*absolute/.test(overlayCss)) {
  console.error("screenOverlay.css: fab-host must use position absolute");
  failed++;
}

const fpSrc = fs.readFileSync(path.join(root, "modules", "FloatPanelModule.js"), "utf8");
if (!fpSrc.includes("room-shell--presenter-focus") || !fpSrc.includes("room-shell--remote-screen-dominant")) {
  console.error("FloatPanelModule.js: avoidStageOverlap must handle presenter-focus and remote-dominant");
  failed++;
}
if (!fpSrc.includes("screen-overlay-fab-host") || !fpSrc.includes("fabZone")) {
  console.error("FloatPanelModule.js: avoidStageOverlap must respect FAB zone");
  failed++;
}
if (!fpSrc.includes('addEventListener("dblclick"') || !fpSrc.includes("pillSuppressClickUntil")) {
  console.error("FloatPanelModule.js: minimized pill must expand on dblclick, not after drag click");
  failed++;
}
if (!fpSrc.includes("countVisiblePeerTiles") || !fpSrc.includes("syncPanelVisibilityForTiles")) {
  console.error("FloatPanelModule.js: must expose tile visibility guards");
  failed++;
}

const presenterCss = fs.readFileSync(
  path.join(__dirname, "..", "public", "css", "presenterFocus.css"),
  "utf8"
);
if (!/presenter-focus[\s\S]*room-bottom-toolbar[\s\S]*display:\s*none/.test(presenterCss)) {
  console.error("presenterFocus.css: must hide room-bottom-toolbar for Electron floating dock");
  failed++;
}

if (/suppressDesktopPresenterUi[\s\S]*UiFloatingDock\?\.deactivate/.test(fpSrc)) {
  console.error("FloatPanelModule.js: must not deactivate UiFloatingDock in suppressDesktopPresenterUi");
  failed++;
}

const rssSrcDock = fs.readFileSync(path.join(root, "roomScreenShareLayout.js"), "utf8");
if (!rssSrcDock.includes("ensurePresenterMediaDock")) {
  console.error("roomScreenShareLayout.js: ensurePresenterMediaDock required");
  failed++;
}
if (/isModularShareLayoutEligible\?\(\)\)\s*\{[\s\S]{0,80}UiFloatingDock\?\.activate/.test(rssSrcDock)) {
  console.error("roomScreenShareLayout.js: UiFloatingDock must not be gated by isModularShareLayoutEligible");
  failed++;
}

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
if (!indexHtml.includes("screenOverlay.js?v=20250617b")) {
  console.error("index.html: screenOverlay.js cache-bust missing");
  failed++;
}
if (!indexHtml.includes("annotationCore.js?v=20250617a")) {
  console.error("index.html: annotationCore.js cache-bust missing");
  failed++;
}
if (!indexHtml.includes("onEnterRoom")) {
  console.error("index.html: showRoom must call WebLayoutOverrides.onEnterRoom");
  failed++;
}

const rssSrc = fs.readFileSync(path.join(root, "roomScreenShareLayout.js"), "utf8");
if (!rssSrc.includes("scheduleAttachRemoteRetry") || !rssSrc.includes("ATTACH_REMOTE_MAX_RETRIES")) {
  console.error("roomScreenShareLayout.js: attach remote retry missing");
  failed++;
}

if (failed) {
  process.exit(1);
}
console.log("test-web-layout-modules: ok");
