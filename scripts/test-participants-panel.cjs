/**
 * Unit tests: ParticipantsModule + AppState.
 * node scripts/test-participants-panel.cjs
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
  const calls = {
    activate: 0,
    deactivate: 0,
    onShare: 0,
    floatInit: 0,
    lastDeactivateOpts: null,
  };
  const sandbox = {
    window: {},
    document: { getElementById: () => null },
    console,
    requestAnimationFrame(fn) {
      fn();
    },
    FloatPanelModule: {
      init() {
        calls.floatInit++;
      },
      activate() {
        calls.activate++;
      },
      deactivate(opts) {
        calls.deactivate++;
        calls.lastDeactivateOpts = opts || null;
      },
      onShareLayoutChange() {
        calls.onShare++;
      },
    },
    UiFloatClamp: {},
    _calls: calls,
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
load("modules/participants/ParticipantsModule.js", ctx);

const T = ctx.MojActionTypes;
const store = ctx.AppState;

assert(store.getState().ui.currentLayout === "gallery", "initial gallery layout");
assert(store.getState().ui.participantsPanelState === "hidden", "initial panel state hidden");
assert(
  ctx.AppState.isShareActive(store.getState()) === false,
  "isShareActive false without share"
);

ctx.ParticipantsModule.init({ $: () => null, getActiveRoomId: () => "r1" });
assert(ctx._calls.floatInit === 0, "no FloatPanelModule.init in gallery on boot");
assert(ctx._calls.activate === 0, "no activate in gallery on boot");
assert(
  !ctx.ParticipantsModule.shouldActivate(store.getState()),
  "shouldActivate false in gallery"
);

store.dispatch({ type: T.UI_SET_LAYOUT, layout: "board" });
assert(
  !ctx.ParticipantsModule.shouldActivate(store.getState()),
  "shouldActivate false on board without share"
);

const actBefore = ctx._calls.activate;
const deactBefore = ctx._calls.deactivate;
store.dispatch({ type: T.SHARE_REMOTE_SET, active: true, userId: "u1" });
assert(ctx._calls.floatInit === 1, "FloatPanelModule.init on first share");
assert(ctx._calls.activate > actBefore, "activate on remote share");
assert(ctx._calls.deactivate === deactBefore, "no deactivate when share starts");
assert(
  ctx.AppState.isShareActive(store.getState()) === true,
  "isShareActive true during remote share"
);
assert(
  store.getState().ui.participantsPanelState === "open",
  "panel state open on share"
);

const deactBeforeMin = ctx._calls.deactivate;
store.dispatch({ type: T.PARTICIPANTS_PANEL_SET, state: "minimized" });
assert(
  store.getState().ui.participantsPanelState === "minimized",
  "panel minimized in store"
);
assert(
  ctx._calls.deactivate === deactBeforeMin,
  "minimize does not deactivate panel"
);

const beforeDeact = ctx._calls.deactivate;
store.dispatch({ type: T.SHARE_REMOTE_SET, active: false, userId: "" });
assert(ctx._calls.deactivate > beforeDeact, "deactivate when share ends");
assert(ctx._calls.lastDeactivateOpts?.destroyDom === true, "destroyDom on share end");
assert(ctx._calls.lastDeactivateOpts?.force === true, "force deactivate on share end");
assert(
  ctx.AppState.isShareActive(store.getState()) === false,
  "isShareActive false after share ends"
);

ctx.ParticipantsModule.teardownPanel();
assert(ctx._calls.lastDeactivateOpts?.destroyDom === true, "teardownPanel uses destroyDom");

ctx.ParticipantsModule.destroy();
store.dispatch({
  type: T.FLAGS_SET,
  flags: { enableParticipantsPanel: false },
});
ctx.ParticipantsModule.init({ $: () => null, getActiveRoomId: () => "r1" });
const actBeforeFlag = ctx._calls.activate;
const floatInitBeforeFlag = ctx._calls.floatInit;
store.dispatch({ type: T.SHARE_REMOTE_SET, active: true, userId: "u2" });
assert(ctx._calls.activate === actBeforeFlag, "flag off: no activate");
assert(ctx._calls.floatInit === floatInitBeforeFlag, "flag off: no float init");

if (failed) process.exit(1);
console.log("test-participants-panel: ok");
