/**
 * Unit tests: ScreenShareSocketBridge bind/unbind + meet:screenShare delegation.
 * node scripts/test-share-socket-bridge.cjs
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
  const sandbox = { window: {}, console };
  sandbox.window = sandbox;
  return vm.createContext(sandbox);
}

function makeMockSocket() {
  const listeners = new Map();
  return {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    off(event, fn) {
      const arr = listeners.get(event);
      if (!arr) arr;
      else {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) || []) fn(payload);
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
  };
}

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(msg);
    failed++;
  }
}

const ctx = makeSandbox();
load("modules/screenShare/ScreenShareSocketBridge.js", ctx);

const state = {
  pending: null,
  applied: [],
  trackRefresh: 0,
  overlayCleared: 0,
};

const socket = makeMockSocket();
ctx.ScreenShareSocketBridge.bind(socket, {
  getActiveRoomId: () => "room-1",
  sameActiveRoom: (a, b) => String(a) === String(b),
  setPendingMeetScreenShare: (p) => {
    state.pending = p;
  },
  applyMeetScreenShareFromServer: (roomId, active, uid) => {
    state.applied.push({ roomId, active, uid });
  },
  ScreenOverlay: { clear: () => state.overlayCleared++ },
  onTrackRefresh: () => {
    state.trackRefresh++;
  },
  onShareRequest: () => {},
  onShareGrant: () => {},
  onAnnotateUpdate: () => {},
  onAnnotateState: () => {},
});

assert(socket.listenerCount("meet:screenShare") === 1, "meet:screenShare bound");

socket.emit("meet:screenShare", { roomId: "room-1", active: true, userId: "User-A" });
assert(state.applied.length === 1, "applyFromServer called");
assert(state.applied[0].uid === "User-A", "uid forwarded");

socket.emit("meet:screenShare", { roomId: "room-1", active: false, userId: "User-A" });
assert(state.applied.length === 2, "stop invokes applyMeetScreenShareFromServer");
assert(state.applied[1].active === false, "stop payload active false");
assert(state.applied[1].uid === "User-A", "stop uid forwarded");
assert(state.overlayCleared === 1, "overlay cleared on stop");

socket.emit("meet:screenShare:trackRefresh", { roomId: "room-1" });
assert(state.trackRefresh === 1, "trackRefresh delegated");

ctx.ScreenShareSocketBridge.unbind(socket);
state.applied.length = 0;
socket.emit("meet:screenShare", { roomId: "room-1", active: true, userId: "x" });
assert(state.applied.length === 0, "unbound share handler");

const socket2 = makeMockSocket();
ctx.ScreenShareSocketBridge.bind(socket2, {
  getActiveRoomId: () => null,
  setPendingMeetScreenShare: (p) => {
    state.pending = p;
  },
});
socket2.emit("meet:screenShare", { roomId: "room-2", active: true, userId: "u" });
assert(state.pending?.roomId === "room-2", "pending when no active room");

if (failed) process.exit(1);
console.log("test-share-socket-bridge: ok");
