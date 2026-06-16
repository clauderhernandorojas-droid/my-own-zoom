/**
 * Regression tests: gallery video mosaic + share stage attach.
 * node scripts/test-gallery-video-mosaic.cjs
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const floatPanelJs = fs.readFileSync(
  path.join(root, "public", "js", "modules", "FloatPanelModule.js"),
  "utf8"
);
const participantsJs = fs.readFileSync(
  path.join(root, "public", "js", "modules", "participants", "ParticipantsModule.js"),
  "utf8"
);

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(msg);
    failed++;
  }
}

assert(
  indexHtml.includes("function isInShareContext"),
  "index.html: isInShareContext must exist"
);
assert(
  indexHtml.includes("function propagateLocalMediaToAllPeers"),
  "index.html: propagateLocalMediaToAllPeers must exist"
);
assert(
  /propagateLocalMediaToAllPeers\(\)/.test(indexHtml),
  "index.html: propagateLocalMediaToAllPeers must be invoked"
);
assert(
  indexHtml.includes("function refreshGalleryVideoMosaic"),
  "index.html: refreshGalleryVideoMosaic must exist"
);
assert(
  /if \(!isInShareContext\(\)\)[\s\S]*refreshGalleryVideoMosaic/.test(indexHtml),
  "index.html: updateRemoteScreenShareLayout uses isInShareContext for gallery branch"
);
assert(
  /function refreshGalleryVideoMosaic[\s\S]*if \(isInShareContext\(\)\) return/.test(indexHtml),
  "index.html: refreshGalleryVideoMosaic guards with isInShareContext"
);
assert(
  indexHtml.includes("closest(\"#roomRemoteScreenStage\")"),
  "index.html: refreshGalleryVideoMosaic must not reparent stage peers"
);
assert(
  !/if \(!isInShareContext\(\)\)[\s\S]{0,400}syncPanelVisibilityForTiles/.test(indexHtml),
  "index.html: must not syncPanelVisibilityForTiles outside share"
);
assert(
  indexHtml.includes("existing.isConnected"),
  "index.html: ensureRemotePeerUi must handle detached video elements"
);
assert(
  !/presence:join[\s\S]{0,200}negotiateOffer/.test(indexHtml),
  "index.html: presence:join must not call negotiateOffer (offer glare)"
);
assert(
  /propagateLocalMediaToAllPeers[\s\S]*signalingState === "stable"/.test(indexHtml),
  "index.html: propagateLocalMedia skips stable connected PCs"
);
assert(
  participantsJs.includes("shouldActivate(stateNow)"),
  "ParticipantsModule.js: onRemoteTrackMounted uses fresh stateNow"
);
assert(
  participantsJs.includes("scheduleRemoteScreenLayoutUpdate"),
  "ParticipantsModule.js: onRemoteTrackMounted schedules layout during share"
);
assert(
  participantsJs.includes("isInShareContext"),
  "ParticipantsModule.js: onRemoteTrackMounted guards share context"
);
assert(
  /sharerUid && peerUid === sharerUid[\s\S]*refreshSharerVideoFromReceivers/.test(indexHtml),
  "index.html: refreshSharerVideoFromReceivers only for share owner in ontrack"
);
assert(
  floatPanelJs.includes("resolveGalleryVideosParent"),
  "FloatPanelModule.js: defensive gallery repatriation for #videos"
);
assert(
  floatPanelJs.includes("tilesSyncTimer"),
  "FloatPanelModule.js: debounce destroyDom on empty tiles"
);

if (failed) process.exit(1);
console.log("test-gallery-video-mosaic: ok");
