/**
 * Unit tests: remote viewer teardown when meet:screenShare stops.
 * node scripts/test-share-stop-remote-viewer.cjs
 */
const path = require("path");
const vm = require("vm");
const fs = require("fs");

const jsRoot = path.join(__dirname, "..", "public", "js");

function load(rel, sandbox) {
  vm.runInContext(fs.readFileSync(path.join(jsRoot, rel), "utf8"), sandbox, {
    filename: rel,
  });
}

function makeSandbox() {
  const sandbox = { window: {}, console, _calls: {} };
  sandbox.window = sandbox;
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
load("store/actions.js", ctx);
load("store/reducer.js", ctx);
load("store/AppState.js", ctx);
load("store/shareState.js", ctx);
load("modules/screenShare/ScreenShareModule.js", ctx);
load("modules/screenShare/ScreenShareOrchestrator.js", ctx);

const T = ctx.MojActionTypes;
const store = ctx.AppState;

ctx.ScreenShareModule.init({
  scheduleRemoteScreenLayoutUpdate() {},
});

function makeOrchestratorDeps(overrides = {}) {
  const calls = {
    teardownPanel: 0,
    refreshGallery: 0,
    ensureGallery: 0,
    forcedStop: 0,
    layoutUpdates: 0,
  };
  const deps = {
    getActiveRoomId: () => "room-1",
    sameActiveRoom: (a, b) => String(a) === String(b),
    normMyUserId: () => "viewer-id",
    isLocallySharingScreen: () => false,
    AppState: store,
    ScreenShareModule: ctx.ScreenShareModule,
    clearShareVideoPoll: () => {},
    setPendingTrackRefresh: () => {},
    scheduleRemoteScreenLayoutUpdate: () => {
      calls.layoutUpdates++;
    },
    onForcedRemoteStop: () => {
      calls.forcedStop++;
    },
    ParticipantsModule: {
      teardownPanel: () => {
        calls.teardownPanel++;
      },
    },
    RoomScreenShareLayout: {
      onStopScreenShare: () => {},
    },
    refreshGalleryVideoMosaic: () => {
      calls.refreshGallery++;
    },
    ensureGalleryLayoutAfterShareStop: () => {
      calls.ensureGallery++;
      if (!store.isShareActive()) {
        const state = store.getState();
        if (state.ui.currentLayout !== "gallery") {
          store.dispatch({ type: T.UI_SET_LAYOUT, layout: "gallery" });
        }
      }
    },
    ...overrides,
  };
  ctx.ScreenShareOrchestrator.init(deps);
  return calls;
}

async function runStop(roomId, uid) {
  ctx.ScreenShareOrchestrator.resetQueue();
  await ctx.ScreenShareOrchestrator.applyFromServerInner(roomId, false, uid);
}

async function main() {
  // Viewer watching remote share — full teardown on stop
  store.dispatch({
    type: T.SHARE_REMOTE_SET,
    active: true,
    userId: "sharer-id",
  });
  assert(store.getState().ui.currentLayout === "share", "baseline layout share");

  const calls1 = makeOrchestratorDeps();
  await runStop("room-1", "sharer-id");
  assert(store.getState().share.active === false, "share inactive after stop");
  assert(store.getState().ui.currentLayout === "gallery", "gallery after remote stop");
  assert(calls1.teardownPanel >= 1, "teardownPanel on remote stop");
  assert(calls1.refreshGallery >= 1, "refreshGallery on remote stop");
  assert(calls1.forcedStop >= 1, "onForcedRemoteStop for viewer");
  assert(calls1.ensureGallery >= 1, "ensureGalleryLayoutAfterShareStop called");

  // Stale layout: share.active false but layout still share — must still teardown
  store.dispatch({ type: T.SHARE_REMOTE_SET, active: true, userId: "sharer-id" });
  store.dispatch({ type: T.SHARE_REMOTE_SET, active: false, userId: "sharer-id" });
  assert(store.getState().share.active === false, "stale scenario share inactive");
  assert(store.getState().ui.currentLayout === "gallery", "store layout after remote off");

  const staleAppState = {
    isShareActive: () => false,
    getState: () => {
      const base = store.getState();
      return {
        ...base,
        ui: { ...base.ui, currentLayout: "share" },
      };
    },
    dispatch: (...args) => store.dispatch(...args),
  };

  const calls2 = makeOrchestratorDeps({ AppState: staleAppState });
  await runStop("room-1", "sharer-id");
  assert(store.getState().ui.currentLayout === "gallery", "gallery after stale layout stop");
  assert(calls2.teardownPanel >= 1, "teardownPanel when layout stale");

  // Owner match — must not early-return before applyRemoteFromServer
  store.dispatch({ type: T.SHARE_REMOTE_SET, active: true, userId: "sharer-id" });
  const calls3 = makeOrchestratorDeps();
  await runStop("room-1", "sharer-id");
  assert(store.getState().share.active === false, "stop when currentOwner matches oid");

  // Unrelated stop when share already fully off — noop path
  store.dispatch({ type: T.UI_SET_LAYOUT, layout: "gallery" });
  const calls4 = makeOrchestratorDeps();
  await runStop("room-1", "other-sharer");
  assert(calls4.teardownPanel === 0, "no teardown for unrelated stop when share off");

  if (failed) process.exit(1);
  console.log("test-share-stop-remote-viewer: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
