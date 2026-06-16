/**
 * Unit tests: ScreenShareModule store sync.
 * node scripts/test-screen-share.cjs
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
  const sandbox = {
    window: {},
    console,
    _layoutCalls: 0,
  };
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
load("modules/screenShare/ScreenShareModule.js", ctx);

const T = ctx.MojActionTypes;
const store = ctx.AppState;

ctx.ScreenShareModule.init({
  scheduleRemoteScreenLayoutUpdate() {
    ctx._layoutCalls++;
  },
});

ctx.ScreenShareModule.notifyLocalShareStarted();
assert(store.getState().share.isLocalShareActive === true, "local share in store");
assert(ctx._layoutCalls >= 1, "layout sync on share start");

ctx.ScreenShareModule.applyRemoteFromServer(true, "User-ABC");
assert(store.getState().share.remoteSharerUserId === "user-abc", "remote uid lowercased");

ctx.ScreenShareModule.notifyLocalShareStopped();
assert(store.getState().share.isLocalShareActive === false, "local share stopped");
assert(store.getState().ui.currentLayout === "share", "remote still active");

ctx.ScreenShareModule.applyRemoteFromServer(false, "");
assert(store.getState().ui.currentLayout === "gallery", "gallery after all share off");

ctx.ScreenShareModule.setMyRequestPending();
assert(store.getState().share.myRequestStatus === "pending", "my request pending via module");

ctx.ScreenShareModule.onShareGrantReceived(true);
assert(store.getState().share.grantedToMe === true, "grant via module");
assert(store.getState().share.myRequestStatus === "granted", "status granted");

ctx.ScreenShareModule.onShareRequestReceived("req-1", "sharer-1");
assert(store.getState().share.pendingRequests.length === 1, "request queued in store");

ctx.ScreenShareModule.onShareRequestRemoved("req-1");
assert(store.getState().share.pendingRequests.length === 0, "request removed from store");

ctx.ScreenShareModule.resetShareAuth();
assert(store.getState().share.grantedToMe === false, "reset share auth");

ctx.ScreenShareModule.notifyLocalShareStarted("guest-1");
assert(store.getState().share.ownerId === "guest-1", "guest owns share locally");
ctx.ScreenShareModule.onForcedLocalStop();
assert(store.getState().share.isLocalShareActive === false, "forced local stop clears local share");
assert(store.getState().share.grantedToMe === false, "forced local stop clears grant");
ctx.ScreenShareModule.applyRemoteFromServer(true, "presenter-9");
assert(store.getState().share.ownerId === "presenter-9", "ownerId follows presenter after takeover");

if (failed) process.exit(1);
console.log("test-screen-share: ok");
