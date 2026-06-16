/**
 * Unit tests: chat toggle via AppState + ChatPanelModule.
 * node scripts/test-chat-toggle.cjs
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
  const shell = { classList: { toggle() {} } };
  const mockBtn = () => ({
    textContent: "",
    setAttribute() {},
    classList: { toggle() {} },
  });
  const sandbox = {
    window: {},
    document: {
      getElementById: () => null,
    },
    console: { log() {}, warn() {} },
    ChatModule: {
      getActiveChatThreadKey: () => "general",
      onActiveThreadChanged() {},
      openChatFromBar() {},
    },
    ChatRoomUiModule: {
      bindBottomBar() {},
    },
  };
  sandbox.window = sandbox;
  sandbox.$ = (id) => {
    if (id === "roomShell") return shell;
    if (id === "btnToggleChat" || id === "btnToggleChatInline") return mockBtn();
    return null;
  };
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
load("modules/chat/ChatPanel.js", ctx);
load("modules/chat/index.js", ctx);

const T = ctx.MojActionTypes;
const store = ctx.AppState;

ctx.RoomChatModule.init({
  $: ctx.$,
  legacySyncHidden(h) {
    ctx._legacyHidden = h;
  },
});

store.dispatch({ type: T.UI_SET_CHAT_OPEN, open: true });
assert(store.getState().ui.isChatOpen === true, "chat open via dispatch");

ctx.ChatPanelModule.toggleFromBar();
assert(store.getState().ui.isChatOpen === false, "toggle closes chat");

ctx.ChatModule.openChatFromBar = () => {
  store.dispatch({ type: T.UI_SET_CHAT_OPEN, open: true });
};
ctx.ChatPanelModule.toggleFromBar();
assert(store.getState().ui.isChatOpen === true, "toggle opens chat");

store.dispatch({
  type: T.FLAGS_SET,
  flags: { enableChat: false },
});
ctx.ChatPanelModule.update(null, store.getState().ui.isChatOpen);
assert(store.getState().flags.enableChat === false, "chat flag off");

if (failed) process.exit(1);
console.log("test-chat-toggle: ok");
