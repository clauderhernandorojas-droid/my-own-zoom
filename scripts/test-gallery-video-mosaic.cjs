/**
 * Regression tests: gallery video mosaic + browser peer propagation.
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
  indexHtml.includes("function propagateLocalMediaToAllPeers"),
  "index.html: propagateLocalMediaToAllPeers must exist"
);
assert(
  /propagateLocalMediaToAllPeers\(\)/.test(indexHtml),
  "index.html: propagateLocalMediaToAllPeers must be invoked"
);
assert(
  indexHtml.includes("void propagateLocalMediaToAllPeers()") ||
    indexHtml.includes("await propagateLocalMediaToAllPeers()"),
  "index.html: propagateLocalMediaToAllPeers called after join/rejoin"
);
assert(
  indexHtml.includes("function refreshGalleryVideoMosaic"),
  "index.html: refreshGalleryVideoMosaic must exist"
);
assert(
  /if \(!shareActive\)[\s\S]*refreshGalleryVideoMosaic/.test(indexHtml),
  "index.html: updateRemoteScreenShareLayout must refresh gallery when !shareActive"
);
assert(
  !/if \(!shareActive\)[\s\S]{0,400}syncPanelVisibilityForTiles/.test(indexHtml),
  "index.html: must not syncPanelVisibilityForTiles outside share"
);
assert(
  indexHtml.includes("existing.isConnected"),
  "index.html: ensureRemotePeerUi must handle detached video elements"
);
assert(
  indexHtml.includes('presence:join negotiate') ||
    indexHtml.includes("presence:join") &&
      indexHtml.includes("negotiateOffer(socketId)"),
  "index.html: presence:join must backup negotiateOffer"
);
assert(
  participantsJs.includes("onRemoteTrackMounted"),
  "ParticipantsModule.js: onRemoteTrackMounted exported"
);
assert(
  participantsJs.includes("refreshGalleryVideoMosaic"),
  "ParticipantsModule.js: onRemoteTrackMounted calls refreshGalleryVideoMosaic in gallery"
);
assert(
  floatPanelJs.includes("resolveGalleryVideosParent"),
  "FloatPanelModule.js: defensive gallery repatriation for #videos"
);
assert(
  floatPanelJs.includes("tilesSyncTimer"),
  "FloatPanelModule.js: debounce destroyDom on empty tiles"
);
assert(
  !/track\.enabled !== false/.test(floatPanelJs),
  "FloatPanelModule.js: count tiles with camera off as present"
);

if (failed) process.exit(1);
console.log("test-gallery-video-mosaic: ok");
