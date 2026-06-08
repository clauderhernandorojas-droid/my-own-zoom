/**
 * Smoke: ScreenShareOverlayCursor (mapeo letterbox + start/stop).
 * node scripts/test-screen-share-overlay-cursor.cjs
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "public", "js");
let failed = 0;

function fail(msg) {
  console.error(msg);
  failed++;
}

const src = fs.readFileSync(path.join(root, "screenShareOverlayCursor.js"), "utf8");
if (!src.includes("ScreenShareOverlayCursor")) {
  fail("screenShareOverlayCursor.js missing export");
}

const sandbox = {
  window: {},
  document: {
    createElement: () => ({
      className: "",
      style: {},
      classList: { add() {}, remove() {} },
      setAttribute() {},
      appendChild() {},
      remove() {},
    }),
    querySelector: () => null,
  },
  localStorage: {
    _data: {},
    getItem(k) {
      return this._data[k] ?? null;
    },
  },
  addEventListener() {},
  removeEventListener() {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
  __MOJ_ELECTRON: false,
  mojElectron: {},
  console: { warn() {} },
};
sandbox.window = sandbox;

vm.runInContext(src, vm.createContext(sandbox), { filename: "screenShareOverlayCursor.js" });
const C = sandbox.ScreenShareOverlayCursor;
if (!C?.start || !C?.stop || !C?.isSupported) {
  fail("ScreenShareOverlayCursor API incomplete");
}

const { getVideoContentRect, clientToStackPointer, screenPointToNorm, normToStackPointer, shouldShowSyncPointer } =
  C._internals;

const videoEl = { videoWidth: 1920, videoHeight: 1080 };
const canvasEl = {
  width: 800,
  height: 450,
  getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 450 }),
};
const stackEl = { clientWidth: 800, clientHeight: 450 };

const cr = getVideoContentRect(videoEl, { width: 800, height: 450 });
if (cr.w <= 0 || cr.h <= 0) fail("getVideoContentRect invalid");

const mid = clientToStackPointer(500, 275, videoEl, canvasEl, stackEl);
if (!mid.visible) fail("clientToStackPointer should be visible at center");

const norm = screenPointToNorm(150, 150, { x: 100, y: 100, width: 1000, height: 800 });
if (!norm || norm.nx < 0 || norm.nx > 1) fail("screenPointToNorm expected in bounds");

const fromNorm = normToStackPointer(norm.nx, norm.ny, videoEl, canvasEl, stackEl);
if (!fromNorm.visible) fail("normToStackPointer should be visible");

const pointerStack = {
  classList: {
    contains(c) {
      return (
        c === "screen-overlay-stack--tool-pointer" || c === "screen-overlay-stack--toolbar-open"
      );
    },
  },
};
if (!shouldShowSyncPointer(pointerStack)) {
  fail("shouldShowSyncPointer must be true for pointer+toolbar without role gate");
}
if (shouldShowSyncPointer({ classList: { contains: () => false } })) {
  fail("shouldShowSyncPointer must be false without pointer tool classes");
}

if (!src.includes("mousemove")) {
  fail("screenShareOverlayCursor.js must listen to mousemove");
}
if (src.includes("isPresenterSharing?.()")) {
  fail("screenShareOverlayCursor.js must not gate visibility on isPresenterSharing");
}

sandbox.localStorage._data.MOJ_OVERLAY_SYNC_CURSOR = "0";
if (C.isSupported()) fail("isSupported must be false when MOJ_OVERLAY_SYNC_CURSOR=0");
delete sandbox.localStorage._data.MOJ_OVERLAY_SYNC_CURSOR;

const started = C.start({
  getShell: () => ({ classList: { toggle() {} } }),
  getStack: () => null,
  getVideoEl: () => null,
  getCanvasEl: () => null,
  getCaptureMapping: () => null,
  isPresenterSharing: () => false,
});
if (!started) fail("start should return true when supported");
C.stop();

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
if (!indexHtml.includes("screenShareOverlayCursor.js")) {
  fail("index.html must load screenShareOverlayCursor.js");
}
if (!indexHtml.includes("startOverlaySyncCursor")) {
  fail("index.html must wire startOverlaySyncCursor");
}

const overlayCss = fs.readFileSync(
  path.join(__dirname, "..", "public", "css", "screenOverlay.css"),
  "utf8"
);
if (!overlayCss.includes("room-shell--overlay-sync-cursor")) {
  fail("screenOverlay.css must include overlay-sync-cursor rules");
}
if (!/presenter-focus[\s\S]*screen-overlay-stack\s*>\s*video[\s\S]*cursor:\s*none/.test(overlayCss)) {
  fail("screenOverlay.css must hide cursor on presenter video");
}
if (!/remote-screen-dominant[\s\S]*screen-overlay-stack\s*>\s*video[\s\S]*cursor:\s*none/.test(overlayCss)) {
  fail("screenOverlay.css must hide cursor on remote-dominant video");
}

const screenShareJs = fs.readFileSync(path.join(root, "screenShare.js"), "utf8");
if (!screenShareJs.includes("verifyShareCaptureCursor")) {
  fail("screenShare.js must export verifyShareCaptureCursor");
}

if (failed) process.exit(1);
console.log("test-screen-share-overlay-cursor: ok");
