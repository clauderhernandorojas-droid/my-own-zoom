/**
 * Smoke: ScreenSharePreviewSanitizer (feature detect, create/stop, internals).
 * node scripts/test-screen-share-preview-sanitizer.cjs
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

class MockWritableStream {
  constructor() {
    this.getWriter = () => ({
      write: async () => {},
      close: async () => {},
    });
  }
}

class MockMediaStreamTrackGenerator {
  constructor() {
    this.track = { kind: "video", readyState: "live", stop() {} };
    this.writable = new MockWritableStream();
  }
}

class MockMediaStreamTrackProcessor {
  constructor() {
    this.readable = {
      getReader: () => ({
        read: async () => ({ done: true, value: null }),
        releaseLock() {},
      }),
    };
  }
}

function makeSandbox(extra = {}) {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: () => ({ data: new Uint8ClampedArray(28 * 28 * 4) }),
      putImageData() {},
    }),
    captureStream: () => ({ getVideoTracks: () => [{ kind: "video", stop() {} }] }),
    remove() {},
  };
  const sandbox = {
    window: {},
    document: {
      createElement(tag) {
        if (tag === "canvas") return { ...canvas, style: {} };
        if (tag === "video") {
          return {
            muted: false,
            style: {},
            videoWidth: 1280,
            videoHeight: 720,
            readyState: 2,
            play: async () => {},
            setAttribute() {},
            remove() {},
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
          };
        }
        return { style: {} };
      },
      body: { appendChild() {} },
    },
    MediaStream: function (tracks) {
      this._tracks = tracks || [];
      this.getVideoTracks = () => this._tracks.filter((t) => t.kind === "video");
    },
    MediaStreamTrackProcessor: MockMediaStreamTrackProcessor,
    MediaStreamTrackGenerator: MockMediaStreamTrackGenerator,
    VideoFrame: function () {
      this.close = () => {};
    },
    OffscreenCanvas: undefined,
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
    console: { warn() {} },
    ...extra,
  };
  sandbox.window = sandbox;
  return sandbox;
}

const src = fs.readFileSync(path.join(root, "screenSharePreviewSanitizer.js"), "utf8");
if (!src.includes("ScreenSharePreviewSanitizer")) {
  fail("screenSharePreviewSanitizer.js missing export");
}

const sb = makeSandbox();
vm.runInContext(src, vm.createContext(sb), { filename: "screenSharePreviewSanitizer.js" });
const S = sb.ScreenSharePreviewSanitizer;
if (!S?.isSupported || !S?.create || !S?.isEnabled) {
  fail("ScreenSharePreviewSanitizer API incomplete");
}

sb.localStorage._data.MOJ_PREVIEW_SANITIZER = "0";
if (S.isSupported()) fail("isSupported must be false when MOJ_PREVIEW_SANITIZER=0");
delete sb.localStorage._data.MOJ_PREVIEW_SANITIZER;
if (!S.isSupported()) fail("isSupported should be true with mocks");

const track = { kind: "video", readyState: "live", addEventListener() {}, removeEventListener() {} };
const session = S.create(track, {});
if (!session?.previewStream || typeof session.stop !== "function") {
  fail("create must return previewStream and stop");
}
if (session.mode !== "processor") {
  fail("expected processor mode with insertable stream mocks");
}
session.stop();

const sbCanvas = makeSandbox({
  MediaStreamTrackProcessor: undefined,
  MediaStreamTrackGenerator: undefined,
  VideoFrame: undefined,
});
vm.runInContext(src, vm.createContext(sbCanvas), { filename: "screenSharePreviewSanitizer.js" });
const S2 = sbCanvas.ScreenSharePreviewSanitizer;
const session2 = S2.create(track, {});
if (!session2 || session2.mode !== "canvas") {
  fail("expected canvas fallback mode");
}
session2.stop();

const { clientToFramePixels, clampPatchRect } = S._internals;
const fakeVideo = {
  videoWidth: 1920,
  videoHeight: 1080,
  getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 450 }),
};
const mapped = clientToFramePixels(500, 300, fakeVideo);
if (!mapped || mapped.x < 0 || mapped.y < 0) {
  fail("clientToFramePixels should map inside frame");
}
const rect = clampPatchRect(100, 100, 1920, 1080, 28, 28);
if (rect.w !== 28 || rect.h !== 28) fail("clampPatchRect size");

const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
if (!indexHtml.includes("screenSharePreviewSanitizer.js")) {
  fail("index.html must load screenSharePreviewSanitizer.js");
}
if (!indexHtml.includes("startPreviewSanitizer(track)")) {
  fail("index.html must start preview sanitizer on share");
}
if (!indexHtml.includes("stopPreviewSanitizer()")) {
  fail("index.html must stop preview sanitizer");
}

if (failed) process.exit(1);
console.log("test-screen-share-preview-sanitizer: ok");
