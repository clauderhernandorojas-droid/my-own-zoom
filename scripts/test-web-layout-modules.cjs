/**
 * Smoke: módulos de layout web exportan API esperada (sin DOM).
 * node scripts/test-web-layout-modules.cjs
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "public", "js");
const files = [
  "clientEnv.js",
  "modules/NotificationsModule.js",
  "modules/FloatPanelModule.js",
  "modules/ChatRoomUiModule.js",
  "modules/ToolbarModule.js",
  "modules/LayoutModule.js",
  "WebLayoutOverrides.js",
];

function loadInSandbox(file, extra = {}) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  const sandbox = {
    window: {},
    document: { getElementById: () => null, querySelector: () => null },
    localStorage: { getItem: () => null, setItem: () => {} },
    ...extra,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox, { filename: file });
  return sandbox;
}

let failed = 0;

const env = loadInSandbox("clientEnv.js");
if (!env.ClientEnv?.isWeb?.() || env.ClientEnv?.isElectron?.()) {
  console.error("clientEnv: isWeb/isElectron");
  failed++;
}

const stubNotif = { initNotificaciones() {}, getTotalUnread: () => 3 };
const n = loadInSandbox("modules/NotificationsModule.js", { Notificaciones: stubNotif });
if (n.NotificationsModule?.getTotalUnread?.() !== 3) {
  console.error("NotificationsModule facade");
  failed++;
}

const web = loadInSandbox("WebLayoutOverrides.js");
if (!web.WebLayoutOverrides?.init || web.WebLayoutOverrides?.isActive?.() !== false) {
  console.error("WebLayoutOverrides web facade");
  failed++;
}

const electron = loadInSandbox("WebLayoutOverrides.js", { __MOJ_ELECTRON: true });
if (electron.WebLayoutOverrides?.isActive?.() !== false) {
  console.error("WebLayoutOverrides electron stubs");
  failed++;
}

if (failed) {
  process.exit(1);
}
console.log("test-web-layout-modules: ok");
