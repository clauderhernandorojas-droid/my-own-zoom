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
    console: { log: () => {} },
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
  ChatRoomUiModule: { init() {}, onShareLayoutEnter() {} },
  ToolbarModule: { initWebLayerPolicy() {} },
  $: (id) => (id === "roomShell" ? lmBox._shell : null),
});
lmBox._shell = {
  classList: {
    contains: (c) => c === "room-shell--presenter-focus",
  },
};
run("clientEnv.js", lmBox);
run("modules/LayoutModule.js", lmBox);
if (!lmBox.LayoutModule?.syncShareLayout) {
  console.error("LayoutModule.syncShareLayout missing");
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

const layoutShellCss = fs.readFileSync(
  path.join(__dirname, "..", "public", "css", "modules", "layoutShell.css"),
  "utf8"
);
if (/object-fit:\s*cover\s*!important/.test(layoutShellCss)) {
  console.error("layoutShell.css: share video should use object-fit contain for ink alignment");
  failed++;
}

const lmSrc = fs.readFileSync(path.join(root, "modules", "LayoutModule.js"), "utf8");
if (!/if\s*\(\s*!initialized\s*\)[\s\S]*init\s*\(\s*deps\s*\)/.test(lmSrc)) {
  console.error("LayoutModule.js: syncShareLayout must call init(deps) when !initialized");
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
