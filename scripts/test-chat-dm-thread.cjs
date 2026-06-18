/**

 * Smoke: claves DM normalizadas + entrega socket privado.

 * node scripts/test-chat-dm-thread.cjs

 */

const path = require("path");

const vm = require("vm");

const fs = require("fs");



const jsRoot = path.join(__dirname, "..", "public", "js");

const socketSrc = fs.readFileSync(path.join(__dirname, "..", "src", "socket", "index.js"), "utf8");



let failed = 0;

function assert(cond, msg) {

  if (!cond) {

    console.error(msg);

    failed++;

  }

}



if (!/findLocalRoomSocketsForUser/.test(socketSrc)) {

  console.error("socket/index.js: private chat must resolve recipients via local sockets");

  failed++;

}

if (/destinatarioEsDocenteValido|Privado solo hacia el docente/.test(socketSrc)) {

  console.error("socket/index.js: private chat must not restrict student-to-student");

  failed++;

}

if (!/usuarioEnReunion\(destinatario/.test(socketSrc)) {

  console.error("socket/index.js: private chat must validate destinatario participates");

  failed++;

}

if (/resolveDocenteTargetUserId/.test(fs.readFileSync(path.join(jsRoot, "chat.js"), "utf8"))) {

  console.error("chat.js: picker must not restrict students to docente only");

  failed++;

}



function load(rel, sandbox) {

  vm.runInContext(fs.readFileSync(path.join(jsRoot, rel), "utf8"), sandbox, {

    filename: rel,

  });

}



const ctx = vm.createContext({

  window: {},

  document: {

    getElementById: () => ({ innerHTML: "", appendChild() {}, scrollTop: 0 }),

    dispatchEvent: () => {},

    addEventListener: () => {},

  },

  CustomEvent: class CustomEvent {

    constructor(type, opts) {

      this.type = type;

      this.detail = opts?.detail;

    }

  },

  console,

});

ctx.window = ctx;

ctx.$ = () => null;



load("chat.js", ctx);



const me = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

const peer = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";



ctx.ChatModule.initChatRoom({

  $: ctx.$,

  getCurrentUser: () => ({ usuarioId: me }),

  getParticipantsById: () => new Map(),

  getChatPanelHidden: () => false,

  normRoomKey: (x) => x,

});



ctx.ChatModule.openDmThreadByUserId(peer);

assert(

  ctx.ChatModule.getActiveChatThreadKey() === `dm:${peer.toLowerCase()}`,

  "openDmThreadByUserId normalizes thread key"

);



ctx.ChatModule.appendChatLine({

  mensaje: {

    mensajeId: "m1",

    tipo: "privado",

    contenido: "hola",

    destinatarioUsuarioId: peer.toUpperCase(),

    autor: { usuarioId: me, nombre: "Yo" },

    marcaTiempo: new Date().toISOString(),

  },

});



const thread = ctx.ChatModule.getChatThreads().get(`dm:${peer.toLowerCase()}`);

assert(thread && thread.messages.length === 1, "appendChatLine routes DM to normalized key");



if (failed) process.exit(1);

console.log("test-chat-dm-thread: ok");

