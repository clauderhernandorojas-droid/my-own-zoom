/**
 * Unit tests: AppState store + reducer.
 * node scripts/test-app-state.cjs
 */
const path = require("path");
const vm = require("vm");
const fs = require("fs");

const root = path.join(__dirname, "..", "public", "js", "store");

function load(file, sandbox) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox, {
    filename: file,
  });
}

function makeSandbox() {
  const sandbox = { window: {}, console };
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
load("actions.js", ctx);
load("reducer.js", ctx);
load("AppState.js", ctx);

const T = ctx.MojActionTypes;
const store = ctx.createMojAppStore();

assert(store.getState().ui.currentLayout === "gallery", "initial layout gallery");
assert(store.getState().ui.participantsPanelState === "hidden", "initial panel hidden");
assert(store.getState().ui.isChatOpen === false, "initial chat closed");

store.dispatch({ type: T.UI_TOGGLE_CHAT });
assert(store.getState().ui.isChatOpen === true, "toggle chat open");

store.dispatch({ type: T.UI_SET_CHAT_OPEN, open: false });
assert(store.getState().ui.isChatOpen === false, "set chat closed");

store.dispatch({ type: T.SHARE_LOCAL_STARTED });
assert(store.getState().share.isLocalShareActive === true, "local share started");
assert(store.getState().ui.currentLayout === "share", "layout share on local start");
assert(store.getState().ui.isParticipantsPanelVisible === true, "participants visible on share");
assert(store.getState().ui.participantsPanelState === "open", "panel open on share start");

store.dispatch({ type: T.PARTICIPANTS_PANEL_SET, state: "minimized" });
assert(store.getState().ui.participantsPanelState === "minimized", "panel minimized via action");
assert(store.getState().ui.isParticipantsPanelVisible === true, "still visible when minimized");

store.dispatch({ type: T.PARTICIPANTS_PANEL_SET, state: "open" });
assert(store.getState().ui.participantsPanelState === "open", "panel restored to open");

store.dispatch({ type: T.SHARE_REMOTE_SET, active: true, userId: "abc" });
assert(store.getState().share.isRemoteShareActive === true, "remote share set");
assert(store.getState().share.remoteSharerUserId === "abc", "remote uid normalized");

store.dispatch({ type: T.SHARE_LOCAL_STOPPED });
assert(store.getState().share.isLocalShareActive === false, "local share stopped");
assert(store.getState().ui.currentLayout === "share", "still share while remote active");

store.dispatch({ type: T.SHARE_REMOTE_SET, active: false, userId: "" });
assert(store.getState().ui.currentLayout === "gallery", "back to gallery");
assert(store.getState().ui.participantsPanelState === "hidden", "panel hidden after share ends");

store.dispatch({ type: T.UI_SET_LAYOUT, layout: "board" });
assert(store.getState().ui.explicitLayout === "board", "explicit board layout");
assert(store.getState().ui.currentLayout === "board", "current board when no share");

let notifyCount = 0;
store.subscribe((s) => s.ui.isChatOpen, () => {
  notifyCount++;
});
store.dispatch({ type: T.UI_TOGGLE_CHAT });
store.dispatch({ type: T.UI_TOGGLE_CHAT });
assert(notifyCount === 2, "slice subscribe fires on change");

store.dispatch({ type: T.SHARE_OWNER_SET, active: true, userId: "User-A" });
assert(store.getState().share.active === true, "share owner set active");
assert(store.getState().share.ownerId === "user-a", "ownerId normalized");

store.dispatch({ type: T.SHARE_REQUEST_ADD, userId: "User-B" });
assert(store.getState().share.pendingRequests.length === 1, "share request add");
assert(store.getState().share.pendingRequests[0] === "user-b", "pending uid normalized");

store.dispatch({ type: T.SHARE_REQUEST_REMOVE, userId: "User-B" });
assert(store.getState().share.pendingRequests.length === 0, "share request remove");

store.dispatch({ type: T.SHARE_MY_REQUEST_SET, status: "pending" });
assert(store.getState().share.myRequestStatus === "pending", "my request pending");

store.dispatch({ type: T.SHARE_GRANT_SET, granted: true });
assert(store.getState().share.grantedToMe === true, "grant set");
assert(store.getState().share.myRequestStatus === "granted", "my request granted");

store.dispatch({ type: T.SHARE_GRANT_SET, granted: false, rejected: true });
assert(store.getState().share.grantedToMe === false, "grant cleared");
assert(store.getState().share.myRequestStatus === "rejected", "my request rejected");

store.dispatch({ type: T.SHARE_REQUEST_ADD, userId: "x" });
store.dispatch({ type: T.SHARE_REQUEST_REMOVE, userId: "*" });
assert(store.getState().share.pendingRequests.length === 0, "clear all pending");

store.dispatch({ type: T.ROOM_RESET });
assert(store.getState().ui.currentLayout === "gallery", "room reset");
assert(store.getState().share.myRequestStatus === "none", "share auth reset on room reset");

const frozen = store.getState();
try {
  frozen.ui.isChatOpen = true;
} catch (_) {}
assert(store.getState().ui.isChatOpen === false, "state snapshot frozen");

if (failed) process.exit(1);
console.log("test-app-state: ok");
