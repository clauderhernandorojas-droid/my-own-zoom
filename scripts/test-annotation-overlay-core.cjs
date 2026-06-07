/**
 * Unit tests for annotationCore (bounds, hit-test, transforms).
 * node scripts/test-annotation-overlay-core.cjs
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..", "public", "js");

function mockMeasureText(text) {
  const len = String(text).length;
  return {
    width: len * 8,
    actualBoundingBoxLeft: 0,
    actualBoundingBoxRight: len * 8,
    actualBoundingBoxAscent: 10,
    actualBoundingBoxDescent: 3,
  };
}

function makeCtx() {
  return {
    measureText: mockMeasureText,
    font: "",
  };
}

function runCore() {
  const sandbox = {
    window: {},
    TableroSeleccion: {
      getResizeTransform(handleId, ob, dx, dy, shiftKey, minSize) {
        if (!ob || !(ob.w > 0)) return null;
        const sx = (ob.w + dx) / ob.w;
        const sy = (ob.h + dy) / ob.h;
        return { anchor: { x: ob.x, y: ob.y }, sx, sy, newBounds: { x: ob.x, y: ob.y, w: ob.w + dx, h: ob.h + dy } };
      },
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "annotationCore.js"), "utf8"), ctx, {
    filename: "annotationCore.js",
  });
  return sandbox.AnnotationCore;
}

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  }
}

const Core = runCore();
const contentRect = { x: 0, y: 0, w: 800, h: 600 };
const ctx = makeCtx();

const shortText = {
  type: "text",
  text: "Hola",
  x: 0.2,
  y: 0.2,
  w: 0.25,
  h: 0.1,
  fontSize: 24,
};

const bShort = Core.measureTextContentNorm(shortText, contentRect, ctx);
assert(bShort.w < 0.25, "short text bbox width should be tighter than stored 0.25");
assert(bShort.h < 0.1, "short text bbox height should be tighter than stored 0.1");

const emoji = {
  type: "text",
  text: "😀",
  x: 0.4,
  y: 0.4,
  w: 0.08,
  h: 0.08,
  fontSize: 42,
};
assert(Core.isEmojiElement(emoji), "emoji element detected");
const bEmoji = Core.measureTextContentNorm(emoji, contentRect, ctx);
assert(bEmoji.w < 0.08, "emoji bbox should be smaller than default 0.08 w");
const emojiWPx = bEmoji.w * contentRect.w;
const emojiHPx = bEmoji.h * contentRect.h;
assert(Math.abs(emojiWPx - emojiHPx) < 2, "emoji bbox should be square in px");

const multi = {
  type: "text",
  text: "line1\nline2",
  x: 0.1,
  y: 0.1,
  w: 0.5,
  h: 0.2,
  fontSize: 22,
};
const bMulti = Core.measureTextContentNorm(multi, contentRect, ctx);
assert(bMulti.h > Core.measureTextContentNorm({ ...multi, text: "line1" }, contentRect, ctx).h, "multiline taller");

const storedBox = { x: 0.2, y: 0.2, w: 0.25, h: 0.1 };
const outside = { x: 0.45, y: 0.25 };
assert(
  !Core.hitTestTextNorm(outside, shortText, contentRect, ctx),
  "point outside measured glyph should not hit old inflated box"
);
const inside = { x: bShort.x + bShort.w * 0.5, y: bShort.y + bShort.h * 0.5 };
assert(
  Core.hitTestTextNorm(inside, shortText, contentRect, ctx),
  "point inside measured bbox should hit"
);

const emptyStub = { type: "text", text: " ", x: 0.2, y: 0.2, w: 0.25, h: 0.1, fontSize: 24 };
const bEmpty = Core.measureTextContentNorm(emptyStub, contentRect, ctx);
assert(bEmpty.w < 0.1, "empty/whitespace text must not use 0.25 default width");
assert(bEmpty.h < 0.08, "empty/whitespace text must not use 0.1 default height");
const bEmptySmall = Core.measureTextContentNorm({ ...emptyStub, fontSize: 12 }, contentRect, ctx);
const bEmptyLarge = Core.measureTextContentNorm({ ...emptyStub, fontSize: 48 }, contentRect, ctx);
assert(bEmptyLarge.h > bEmptySmall.h, "empty line height scales with fontSize");

const layoutShort = Core.measureTextLayoutNorm(shortText, contentRect, ctx);
assert(layoutShort && layoutShort.textOrigin, "measureTextLayoutNorm returns textOrigin");
assert(
  layoutShort.chromeBounds.x < layoutShort.textOrigin.x,
  "chrome left of text origin with symmetric pad"
);
assert(
  layoutShort.chromeBounds.y < layoutShort.textOrigin.y,
  "chrome above text origin with symmetric pad"
);
const fsShort = Core.textFontSizePx(shortText, contentRect);
const expectedLineHNorm = (fsShort * Core.TEXT_LINE_HEIGHT_FACTOR) / contentRect.h;
assert(
  layoutShort.textSize.h <= expectedLineHNorm + 0.001,
  "textSize height matches fs * line factor"
);
const layoutSmall = Core.measureTextLayoutNorm({ ...emptyStub, fontSize: 12 }, contentRect, ctx);
const layoutLarge = Core.measureTextLayoutNorm({ ...emptyStub, fontSize: 48 }, contentRect, ctx);
assert(layoutLarge.textSize.h > layoutSmall.textSize.h, "layout textSize height scales with fontSize");

const fillTexts = [];
const drawCtx = {
  measureText: mockMeasureText,
  font: "",
  fillStyle: "",
  textBaseline: "",
  fillText(text) {
    fillTexts.push(text);
  },
};
const textEls = [
  { type: "text", text: "SkipMe", x: 0.1, y: 0.1, w: 0.2, h: 0.1, fontSize: 24 },
  { type: "text", text: "DrawMe", x: 0.3, y: 0.3, w: 0.2, h: 0.1, fontSize: 24 },
];
Core.drawInkElementos(drawCtx, textEls, contentRect, { skipTextIndices: [0] });
assert(!fillTexts.includes("SkipMe"), "drawInkElementos skips text at given index");
assert(fillTexts.includes("DrawMe"), "drawInkElementos still draws other text");

const stroke = {
  type: "stroke",
  color: "#111",
  lw: 0.008,
  points: [
    { x: 0.1, y: 0.1 },
    { x: 0.3, y: 0.3 },
  ],
};
const textEl = { type: "text", text: "X", x: 0.5, y: 0.5, w: 0.05, h: 0.05, fontSize: 20 };
const draggedStroke = Core.applyDragTransform(stroke, 0.05, 0.05);
assert(Math.abs(draggedStroke.points[0].x - 0.15) < 0.001, "stroke drag dx");
const draggedText = Core.applyDragTransform(textEl, 0.02, -0.01);
assert(Math.abs(draggedText.x - 0.52) < 0.001, "text drag dx");
assert(Math.abs(draggedText.y - 0.49) < 0.001, "text drag dy");

assert(Core.shouldUseUniformTextResize(shortText), "all text uses uniform resize");
const textHandles = Core.getResizeHandleRects(bShort, shortText, contentRect, 14);
assert(textHandles.length === 8, "text has 8 resize handles");
const nwHandle = textHandles.find((h) => h.id === "nw");
const nwWPx = nwHandle.w * contentRect.w;
const nwHPx = nwHandle.h * contentRect.h;
assert(Math.abs(nwWPx - nwHPx) < 0.01, "resize handles square in px");
assert(Math.abs(nwWPx - 14) < 0.01, "hit handle size ~14px");

const local = Core.normToStackLocalPx(0.1, 0.2, contentRect);
assert(Math.abs(local.x - 80) < 0.1 && Math.abs(local.y - 120) < 0.1, "normToStackLocalPx");

const fpSrc = fs.readFileSync(path.join(root, "modules", "FloatPanelModule.js"), "utf8");
assert(
  !/suppressDesktopPresenterUi[\s\S]*UiFloatingDock\?\.deactivate/.test(fpSrc),
  "FloatPanelModule must not deactivate UiFloatingDock (Electron floating media bar)"
);
assert(fpSrc.includes("ensurePresenterMediaDock"), "FloatPanelModule re-activates presenter media dock");

const rssSrc = fs.readFileSync(path.join(root, "roomScreenShareLayout.js"), "utf8");
assert(
  rssSrc.includes("ensurePresenterMediaDock"),
  "roomScreenShareLayout exposes ensurePresenterMediaDock for floating dock"
);

const syncSrc = fs.readFileSync(path.join(root, "annotationSync.js"), "utf8");
assert(syncSrc.includes("isRemoteFromSelf"), "annotationSync exposes fromSelf guard");

const uiSrc = fs.readFileSync(path.join(root, "annotationUI.js"), "utf8");
assert(uiSrc.includes("HANDLE_VISUAL_PX"), "annotationUI defines visual handle size");
assert(uiSrc.includes("HANDLE_HIT_PX"), "annotationUI defines hit handle size");
assert(/HANDLE_VISUAL_PX\s*=\s*4/.test(uiSrc), "visual handles halved to 4px");
assert(/HANDLE_HIT_PX\s*=\s*14/.test(uiSrc), "hit handles halved to 14px");
assert(uiSrc.includes("stackEl"), "annotationUI mounts editor in stack");
assert(uiSrc.includes("drawTextEditorChrome"), "annotationUI exports drawTextEditorChrome");
assert(uiSrc.includes("onLayoutChange"), "inline text editor supports onLayoutChange");

const css = fs.readFileSync(path.join(__dirname, "..", "public", "css", "screenOverlay.css"), "utf8");
assert(/background:\s*transparent/.test(css), "text input transparent background");
assert(/border:\s*none/.test(css), "text input no border");
assert(/resize:\s*none/.test(css), "text input resize disabled");
assert(/\.screen-overlay-stack\s*>\s*\.screen-overlay-text-input/.test(css), "text input styled in stack");

if (failed) {
  process.exit(1);
}
console.log("test-annotation-overlay-core: ok");
