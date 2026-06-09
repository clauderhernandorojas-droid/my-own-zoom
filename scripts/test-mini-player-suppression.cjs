/**
 * Unit tests: mini-player / PiP suppression during active room and share.
 * node scripts/test-mini-player-suppression.cjs
 */
const path = require("path");
const vm = require("vm");
const fs = require("fs");

const jsRoot = path.join(__dirname, "..", "public", "js");
const storeRoot = path.join(jsRoot, "store");

function load(rel, sandbox, root = jsRoot) {
  vm.runInContext(fs.readFileSync(path.join(root, rel), "utf8"), sandbox, {
    filename: rel,
  });
}

function makeSandbox() {
  const pip = { exitPictureInPicture: async () => {} };
  function makeEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      className: "",
      classList: { add() {}, remove() {}, contains: () => false },
      style: {},
      dataset: {},
      children: [],
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      querySelector() {
        return null;
      },
      addEventListener() {},
      setAttribute() {},
      getAttribute: () => null,
      play: async () => {},
      pause() {},
    };
    return el;
  }
  const sandbox = {
    window: {},
    document: {
      hidden: false,
      pictureInPictureEnabled: true,
      pictureInPictureElement: null,
      createElement: makeEl,
      getElementById: (id) => {
        if (id === "miniPlayerStyles") return { id };
        if (id === "miniPlayer") return null;
        if (id === "roomRemoteScreenStage") return { contains: () => false };
        return null;
      },
      head: { appendChild() {} },
      body: { appendChild() {} },
      addEventListener() {},
    },
    console,
    HTMLVideoElement: function HTMLVideoElement() {},
    CustomEvent: function CustomEvent(type, opts) {
      this.type = type;
      this.detail = opts?.detail;
    },
  };
  sandbox.document.exitPictureInPicture = pip.exitPictureInPicture;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  return vm.createContext(sandbox);
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(msg);
    failed++;
  }
}

const ctx = makeSandbox();
load("actions.js", ctx, storeRoot);
load("reducer.js", ctx, storeRoot);
load("AppState.js", ctx, storeRoot);
load("clientEnv.js", ctx);
load("uiMiniPlayer.js", ctx);

const T = ctx.MojActionTypes;
const store = ctx.AppState;

ctx.MiniPlayerControls.initMiniPlayer({
  getActiveRoomId: () => ctx._roomId || null,
  getRemoteVideos: () => new Map(),
  getLocalStream: () => null,
  setMicEnabled() {},
  setCamEnabled() {},
  syncMediaButtons() {},
});

assert(
  !ctx.MiniPlayerControls.shouldSuppressMiniPlayer(),
  "no suppression without active room"
);

ctx._roomId = "room-1";
assert(
  ctx.MiniPlayerControls.shouldSuppressMiniPlayer(),
  "suppress when in room and tab visible"
);

ctx._roomId = null;
ctx.document.hidden = true;
assert(
  !ctx.MiniPlayerControls.shouldSuppressMiniPlayer(),
  "no suppress when tab hidden and no room"
);

ctx._roomId = "room-1";
ctx.document.hidden = true;
assert(
  !ctx.MiniPlayerControls.shouldSuppressMiniPlayer(),
  "allow mini-player path when tab hidden in room"
);

ctx.document.hidden = false;
store.dispatch({ type: T.SHARE_LOCAL_STARTED });
assert(
  ctx.MiniPlayerControls.shouldSuppressMiniPlayer(),
  "suppress when currentLayout is share"
);

store.dispatch({ type: T.SHARE_LOCAL_STOPPED });
store.dispatch({ type: T.SHARE_REMOTE_SET, active: false, userId: "" });
ctx._roomId = "room-1";
store.dispatch({ type: T.SHARE_REMOTE_SET, active: true, userId: "peer-a" });
assert(
  ctx.MiniPlayerControls.shouldSuppressMiniPlayer(),
  "suppress when share active via AppState.isShareActive"
);

const mpSrc = fs.readFileSync(path.join(jsRoot, "uiMiniPlayer.js"), "utf8");
assert(mpSrc.includes("stage.contains(wrap)"), "pickBestRemoteStream skips stage peers");
assert(mpSrc.includes("suppressForActiveSession"), "suppressForActiveSession exported");

const rssSrc = fs.readFileSync(path.join(jsRoot, "roomScreenShareLayout.js"), "utf8");
assert(
  rssSrc.includes("MiniPlayerControls?.suppressForActiveSession"),
  "roomScreenShareLayout suppresses mini-player on layout update"
);

if (failed) process.exit(1);
console.log("test-mini-player-suppression: ok");
