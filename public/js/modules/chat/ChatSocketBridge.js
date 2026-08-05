/**

 * ChatSocketBridge — listeners chat:message, chat:messageDeleted, chat:messageReaction.

 */

(function (global) {

  /** @type {object | null} */

  let boundSocket = null;

  const handlers = {};



  function bind(socket, deps = {}) {

    if (!socket || typeof socket.on !== "function") return;

    unbind(socket);

    boundSocket = socket;



    const chat = deps.ChatModule;



    handlers.message = (payload) => {

      chat?.onIncomingMessage?.(payload);

    };



    handlers.messageDeleted = ({ mensajeId }) => {

      if (mensajeId) chat?.removeChatMessageEverywhere?.(String(mensajeId));

    };



    handlers.messageReaction = (payload) => {

      chat?.onIncomingReaction?.(payload);

    };



    socket.on("chat:message", handlers.message);

    socket.on("chat:messageDeleted", handlers.messageDeleted);

    socket.on("chat:messageReaction", handlers.messageReaction);

  }



  function unbind(socket) {

    const s = socket || boundSocket;

    if (!s || typeof s.off !== "function") return;

    if (handlers.message) s.off("chat:message", handlers.message);

    if (handlers.messageDeleted) s.off("chat:messageDeleted", handlers.messageDeleted);

    if (handlers.messageReaction) s.off("chat:messageReaction", handlers.messageReaction);

    boundSocket = null;

  }



  global.ChatSocketBridge = {

    bind,

    unbind,

  };

})(typeof window !== "undefined" ? window : global);

