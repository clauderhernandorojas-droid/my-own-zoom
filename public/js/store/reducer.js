/**

 * Reducer puro para AppState (sin DOM ni socket).

 */

(function (global) {

  const T = global.MojActionTypes || {};



  function defaultFlags() {

    return {

      enableChat: true,

      enableParticipantsPanel: true,

      enableScreenShare: true,

      enableModularLayout: true,

    };

  }



  function normUserId(id) {

    return id != null ? String(id).trim().toLowerCase() : "";

  }



  function defaultShare() {

    return {

      active: false,

      ownerId: null,

      pendingRequests: [],

      isLocalShareActive: false,

      isRemoteShareActive: false,

      remoteSharerUserId: "",

      localOwnerId: null,

      myRequestStatus: "none",

      grantedToMe: false,

    };

  }



  function syncShareMeta(share) {

    share.active = !!(share.isLocalShareActive || share.isRemoteShareActive);

    if (!share.active) {

      share.ownerId = null;

      return share;

    }

    if (share.isLocalShareActive && share.localOwnerId) {

      share.ownerId = share.localOwnerId;

    } else if (share.isRemoteShareActive && share.remoteSharerUserId) {

      share.ownerId = share.remoteSharerUserId;

    }

    return share;

  }



  function initialState() {

    return {

      ui: {

        isChatOpen: false,

        isParticipantsPanelVisible: false,

        participantsPanelState: "hidden",

        currentLayout: "gallery",

        explicitLayout: "gallery",

      },

      share: defaultShare(),

      flags: defaultFlags(),

    };

  }



  function recomputeLayout(ui, share) {

    if (share.isLocalShareActive || share.isRemoteShareActive) {

      const prev = ui.participantsPanelState;

      const panelState = prev === "minimized" ? "minimized" : "open";

      return {

        ...ui,

        currentLayout: "share",

        isParticipantsPanelVisible: true,

        participantsPanelState: panelState,

      };

    }

    return {

      ...ui,

      currentLayout: ui.explicitLayout || "gallery",

      isParticipantsPanelVisible: false,

      participantsPanelState: "hidden",

    };

  }



  function roomReducer(state, action) {

    if (!action || !action.type) return state;

    const ui = { ...state.ui };

    const share = { ...state.share, pendingRequests: [...(state.share.pendingRequests || [])] };

    let flags = { ...state.flags };



    switch (action.type) {

      case T.UI_TOGGLE_CHAT:
        return freezeState({
          ...state,
          ui: { ...state.ui, isChatOpen: !state.ui.isChatOpen },
        });

      case T.UI_SET_CHAT_OPEN:
        return freezeState({
          ...state,
          ui: { ...state.ui, isChatOpen: !!action.open },
        });

      case T.UI_SET_LAYOUT: {

        const layout = action.layout === "board" ? "board" : "gallery";

        ui.explicitLayout = layout;

        if (!share.isLocalShareActive && !share.isRemoteShareActive) {

          ui.currentLayout = layout;

        }

        break;

      }

      case T.SHARE_LOCAL_STARTED:

        share.isLocalShareActive = true;

        if (action.myUserId) {

          share.localOwnerId = normUserId(action.myUserId);

        }

        syncShareMeta(share);

        Object.assign(ui, recomputeLayout(ui, share));

        break;

      case T.SHARE_LOCAL_STOPPED:

        share.isLocalShareActive = false;

        share.localOwnerId = null;

        syncShareMeta(share);

        Object.assign(ui, recomputeLayout(ui, share));

        break;

      case T.SHARE_REMOTE_SET:

        share.isRemoteShareActive = !!action.active;

        share.remoteSharerUserId = action.active

          ? normUserId(action.userId)

          : "";

        syncShareMeta(share);

        Object.assign(ui, recomputeLayout(ui, share));

        break;

      case T.SHARE_OWNER_SET: {

        const uid = normUserId(action.userId);

        if (action.active && uid) {

          share.isRemoteShareActive = true;

          share.remoteSharerUserId = uid;

        } else if (!action.active) {

          if (share.remoteSharerUserId === uid || !uid) {

            share.isRemoteShareActive = false;

            share.remoteSharerUserId = "";

          }

        }

        syncShareMeta(share);

        Object.assign(ui, recomputeLayout(ui, share));

        break;

      }

      case T.SHARE_REQUEST_ADD: {

        const uid = normUserId(action.userId);

        if (uid && !share.pendingRequests.includes(uid)) {

          share.pendingRequests.push(uid);

        }

        break;

      }

      case T.SHARE_REQUEST_REMOVE: {

        if (action.userId === "*") {

          share.pendingRequests = [];

        } else {

          const uid = normUserId(action.userId);

          share.pendingRequests = share.pendingRequests.filter((id) => id !== uid);

        }

        break;

      }

      case T.SHARE_MY_REQUEST_SET:

        share.myRequestStatus = action.status || "none";

        break;

      case T.SHARE_GRANT_SET:

        share.grantedToMe = !!action.granted;

        if (action.granted) {

          share.myRequestStatus = "granted";

        } else if (action.rejected) {

          share.myRequestStatus = "rejected";

        }

        break;

      case T.PARTICIPANTS_PANEL_SET:

        if (action.state === "open" || action.state === "minimized") {

          ui.participantsPanelState = action.state;

          ui.isParticipantsPanelVisible = true;

        } else if (action.visible !== undefined) {

          ui.isParticipantsPanelVisible = !!action.visible;

          if (!ui.isParticipantsPanelVisible) {

            ui.participantsPanelState = "hidden";

          }

        }

        break;

      case T.FLAGS_SET:

        flags = { ...flags, ...(action.flags || {}) };

        break;

      case T.ROOM_RESET:

        return initialState();

      default:

        return state;

    }



    return { ui, share, flags };

  }



  function freezeState(state) {

    return Object.freeze({

      ui: Object.freeze({ ...state.ui }),

      share: Object.freeze({

        ...state.share,

        pendingRequests: Object.freeze([...(state.share.pendingRequests || [])]),

      }),

      flags: Object.freeze({ ...state.flags }),

    });

  }



  global.MojRoomReducer = {

    initialState,

    roomReducer,

    freezeState,

    recomputeLayout,

    syncShareMeta,

    defaultShare,

  };

})(typeof window !== "undefined" ? window : global);


