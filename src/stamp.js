import ClipperLib from "clipper-lib";
import { worldContours, shapeContours, pathData } from "./geometry.js";
import { SCALE, encode, decode, isClosed } from "./polygon.js";
// Stamp Mode (issue #12): a rubber stamp instead of cut lines. The board is
// the stamp face; every visible closed outline is ink (the raised rubber that
// prints). The export engraves the rest of the face and cuts the rubber's
// outline, mirrored so the print reads the right way round.
//
//   engrave = face − ink   (negative, the default: the characters print)
//   engrave = face ∩ ink   (positive: the characters are white in the print)
//
// A shoulder (肩・くびれ) makes the characters stand on a sloped base, so
// thin strokes do not snap off: the engraving is split into N passes, pass k
// removing the face minus the ink grown by width × k / N. A point at distance
// r from the ink is engraved by about N × r / width passes, so the floor
// rises in N steps towards the characters (a stepped slope, like Mt. Fuji).
//
// Everything is in millimetres with the board's origin at the top left.

export const FABRICATION_MODES = Object.freeze({
  cut: { label: "切り抜き", hint: "しおり・ステンシル（カット線）" },
  stamp: { label: "ハンコ", hint: "ゴム印（彫刻＋外形カット）" },
});
export const fabricationMode = (project) =>
  project?.fabrication === "stamp" ? "stamp" : "cut";
export const STAMP_SHAPES = Object.freeze({
  rectangle: "長方形",
  "rounded-rectangle": "角丸長方形",
  circle: "円形",
});
export const ENGRAVING_MODES = Object.freeze({
  negative: "背景を彫る（文字が押される）",
  positive: "文字を彫る（文字が白抜き）",
});
export const BOLD_PRESETS = Object.freeze([0, 0.1, 0.2, 0.3]);
export const STAMP_DEFAULTS = Object.freeze({
  shape: "rectangle",
  mirror: true,
  engravingMode: "negative",
  margin: 2,
  cornerRadius: 3,
  boldOffset: 0.1,
  guide: false,
  shoulderWidth: 0, // 0: no shoulder
  shoulderLevels: 4,
});
export const SHOULDER_PRESETS = Object.freeze([0, 0.3, 0.5, 1]);
// The face size is the board size, so it shares the board's 10 mm minimum.
export const STAMP_LIMITS = Object.freeze({
  size: [10, 200],
  margin: [0, 20],
  cornerRadius: [0, 100],
  boldOffset: [-0.5, 1],
  shoulderWidth: [0, 3],
  shoulderLevels: [2, 16],
});
export const STAMP_SIZE_DEFAULT = Object.freeze({ width: 60, height: 20 });

const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;
// Saved settings with defaults filled in; anything malformed is rejected so a
// project file cannot smuggle odd values into the geometry.
export function normalizeStamp(stamp = {}) {
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp))
    throw Error("ハンコ設定が不正です。");
  const o = { ...STAMP_DEFAULTS };
  for (const key of Object.keys(STAMP_DEFAULTS))
    if (stamp[key] !== undefined) o[key] = stamp[key];
  if (
    !(o.shape in STAMP_SHAPES) ||
    !(o.engravingMode in ENGRAVING_MODES) ||
    typeof o.mirror !== "boolean" ||
    typeof o.guide !== "boolean" ||
    !inRange(o.margin, STAMP_LIMITS.margin) ||
    !inRange(o.cornerRadius, STAMP_LIMITS.cornerRadius) ||
    !inRange(o.boldOffset, STAMP_LIMITS.boldOffset) ||
    !inRange(o.shoulderWidth, STAMP_LIMITS.shoulderWidth) ||
    !Number.isInteger(o.shoulderLevels) ||
    !inRange(o.shoulderLevels, STAMP_LIMITS.shoulderLevels)
  )
    throw Error("ハンコ設定が不正です。");
  return o;
}
// Settings plus the face size (the board).
export const stampOptions = (project) => ({
  ...normalizeStamp(project.stamp ?? {}),
  width: project.width,
  height: project.height,
});

// ---- Clipper on integer paths (SCALE units) ----
const NONZERO = ClipperLib.PolyFillType.pftNonZero;
function boolean(subject, clip, type) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out = [];
  if (!c.Execute(type, out, NONZERO, NONZERO)) throw Error("印面の合成に失敗しました。");
  return out.filter((p) => p.length >= 3);
}
const union = (a, b) => boolean(a, b, ClipperLib.ClipType.ctUnion);
const difference = (a, b) => boolean(a, b, ClipperLib.ClipType.ctDifference);
const intersection = (a, b) => boolean(a, b, ClipperLib.ClipType.ctIntersection);
// Positive grows, negative thins; round joins keep the letter shapes.
function offset(paths, distance) {
  if (!distance || !paths.length) return paths;
  const co = new ClipperLib.ClipperOffset(2, 0.02 * SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, distance * SCALE);
  return out.filter((p) => p.length >= 3);
}
const area = (paths) =>
  paths.reduce((n, p) => n + ClipperLib.Clipper.Area(p), 0) / (SCALE * SCALE);

// The rubber's outline: the whole board as a rectangle, a rounded rectangle
// or the inscribed ellipse (a circle when the face is square).
export function stampBase({ width, height, shape, cornerRadius = 0 }) {
  if (shape === "circle") return shapeContours("circle", width, height);
  if (shape === "rounded-rectangle" && cornerRadius > 0)
    return shapeContours("rect", width, height, Math.min(cornerRadius, width / 2, height / 2));
  return shapeContours("rect", width, height);
}

// Union of the closed outlines of the given items. Each item is normalised on
// its own first (nonzero), so one item's counter (the hole of 口) is not
// filled or cut by the winding of another. Open lines have no width and
// bridges do not apply to a stamp; both are counted and skipped.
function inkOf(items) {
  let ink = [],
    open = 0,
    bridges = 0;
  for (const item of items) {
    if (item.type === "bridge") {
      bridges++;
      continue;
    }
    const world = worldContours(item),
      closed = world.filter(isClosed);
    open += world.length - closed.length;
    if (!closed.length) continue;
    const own = ClipperLib.Clipper.SimplifyPolygons(
      closed.map(encode).filter((p) => p.length >= 3),
      NONZERO,
    );
    ink = ink.length ? union(ink, own) : own;
  }
  return { ink, open, bridges };
}

// Stamp geometry in the stamp's own (unmirrored) orientation:
// - base: the rubber outline (CUT)
// - raised: what stays and prints
// - engrave: what the laser removes (ENGRAVE)
// - marginArea: the face inset by the margin (GUIDE)
// with checks: no ink, ink outside the face or the margin, skipped items.
export function stampGeometry(items, options) {
  const o = { ...normalizeStamp(options), width: options.width, height: options.height };
  const base = stampBase(o).map(encode),
    { ink, open, bridges } = inkOf(items),
    grown = offset(ink, o.boldOffset),
    inside = intersection(grown, base),
    raised = o.engravingMode === "positive" ? difference(base, grown) : inside,
    engrave = o.engravingMode === "positive" ? inside : difference(base, grown),
    marginArea = o.margin > 0 ? offset(base, -o.margin) : base,
    // The shoulder applies when the background is engraved around ink.
    shoulder = o.engravingMode === "negative" && o.shoulderWidth > 0 && ink.length > 0,
    passes = shoulder
      ? Array.from({ length: o.shoulderLevels }, (_, k) =>
          k ? difference(base, offset(grown, (o.shoulderWidth * k) / o.shoulderLevels)) : engrave,
        )
      : [engrave];
  const inkArea = area(inside),
    faceArea = Math.abs(area(base));
  return {
    options: o,
    base: base.map(decode),
    raised: raised.map(decode),
    engrave: engrave.map(decode),
    // Engraving passes, each inside the one before (passes[0] = engrave).
    passes: passes.map((p) => p.map(decode)),
    shoulder,
    marginArea: marginArea.map(decode),
    empty: !ink.length,
    // Ink thinned away entirely by a negative bold offset.
    vanished: ink.length > 0 && inkArea < 1e-6,
    inkArea,
    faceArea,
    outsideFace: grown.length > 0 && area(difference(grown, base)) > 1e-4,
    outsideMargin:
      grown.length > 0 && marginArea.length > 0 && area(difference(grown, marginArea)) > 1e-4,
    open,
    bridges,
  };
}

// Left–right mirror inside the face; the point order is reversed so outer
// contours and holes keep their orientation.
export const mirrorContours = (contours, width) =>
  contours.map((c) => c.map((p) => ({ x: width - p.x, y: p.y })).reverse());

const num = (n) => Number(Number(n).toFixed(4));
const xml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
const layer = (id, body) =>
  `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${id}">${body}</g>`;
// Centre lines and the margin, drawn but not meant to be lasered.
function guidePaths(g) {
  const { width: w, height: h } = g.options;
  return [
    ...g.marginArea,
    [{ x: w / 2, y: 0 }, { x: w / 2, y: h }],
    [{ x: 0, y: h / 2 }, { x: w, y: h / 2 }],
  ];
}

// Laser SVG: mm units, viewBox, paths only. ENGRAVE is a black filled
// compound path (even-odd), CUT a red hairline, the optional GUIDE blue. The
// colours let LightBurn put them on separate layers; xTool Creative Space
// reads filled shapes as engraving and strokes as cutting. Group ids and
// Inkscape layer labels name the operation.
export function stampSVG(items, options) {
  const g = stampGeometry(items, options),
    o = g.options;
  if (g.empty) throw Error("印面に文字や図形がありません。閉じた輪郭を配置してください。");
  if (g.vanished || !g.raised.length)
    throw Error("太さ補正で文字が消えました。補正を大きくしてください。");
  if (!g.engrave.length) throw Error("彫刻する部分がありません。");
  const m = (c) => (o.mirror ? mirrorContours(c, o.width) : c);
  const fill = (contours, color) =>
      `<path d="${pathData(m(contours))}" fill="${color}" fill-rule="evenodd" stroke="none"/>`,
    // One layer per pass with its own colour, so laser software keeps the
    // passes apart instead of merging them into one fill.
    engrave = g.shoulder
      ? g.passes
          .map((p, k) => (p.length ? layer(`ENGRAVE-${k + 1}`, fill(p, PASS_COLORS[k])) : ""))
          .filter(Boolean)
          .join("\n")
      : layer("ENGRAVE", fill(g.engrave, "#000000")),
    cut = `<path d="${pathData(m(g.base))}" fill="none" stroke="#ff0000" stroke-width="0.1"/>`,
    guide = o.guide
      ? `\n${layer("GUIDE", `<path d="${pathData(m(guidePaths(g)))}" fill="none" stroke="#0000ff" stroke-width="0.05" stroke-dasharray="0.6 0.4"/>`)}`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${num(o.width)}mm" height="${num(o.height)}mm" viewBox="0 0 ${num(o.width)} ${num(o.height)}">\n<title>TypeFab rubber stamp</title>\n<desc>${xml(`Units: mm. ENGRAVE (black fill) is the area to engrave, CUT (red line) is the rubber outline${o.guide ? ", GUIDE (blue) is for reference only and is not meant to be processed" : ""}. ${o.mirror ? "Mirrored left to right for stamping." : "Not mirrored."} Shape: ${o.shape}. Bold offset: ${o.boldOffset} mm. Engraving: ${o.engravingMode}.${g.shoulder ? ` Shoulder: ${o.shoulderWidth} mm in ${o.shoulderLevels} steps; ENGRAVE-1 is the whole engraving area and each ENGRAVE-k layer is one pass inside the previous one, so run every layer with the same settings, each removing the total depth divided by ${o.shoulderLevels}.` : ""}`)}</desc>\n${engrave}\n${layer("CUT", cut)}${guide}\n</svg>\n`;
}

// Fill colours of the shoulder passes: LightBurn palette colours other than
// red (CUT) and blue (GUIDE), so each pass imports as a layer of its own.
export const PASS_COLORS = Object.freeze([
  "#000000", "#00e000", "#d0d000", "#ff8000", "#00e0e0", "#ff00ff", "#b4b4b4", "#0000a0",
  "#a00000", "#00a000", "#a0a000", "#c08000", "#00a0ff", "#a000a0", "#808080", "#7d87b9",
]);
// Grey of each pass in a depth map (white = not engraved, black = deepest).
export const passShades = (n) =>
  Array.from({ length: n }, (_, k) => Math.round(255 * (1 - (k + 1) / n)));

// Small mock-ups for the inspector, in mm with a little padding.
// "laser": the export (mirrored when set) — engraving dark, cut line red.
// "print": the impression on paper, always the right way round.
export const STAMP_INK = "#c8332b";
// The engraving darker where it is deeper (one fill per pass).
export function passLayers(g, m = (c) => c) {
  const n = g.passes.length;
  return g.passes
    .map((p, k) => {
      const t = (k + 1) / n,
        mix = (a, b) => Math.round(a + (b - a) * t);
      return `<path d="${pathData(m(p))}" fill="rgb(${mix(0xc9, 0x4a)} ${mix(0xb8, 0x40)} ${mix(0xa3, 0x38)})" fill-rule="evenodd"/>`;
    })
    .join("");
}
export function stampPreviewSVG(g, view) {
  const o = g.options,
    pad = Math.max(o.width, o.height) * 0.06,
    box = `${num(-pad)} ${num(-pad)} ${num(o.width + 2 * pad)} ${num(o.height + 2 * pad)}`,
    m = (c) => (view === "laser" && o.mirror ? mirrorContours(c, o.width) : c);
  const body =
    view === "laser"
      ? `<path d="${pathData(m(g.base))}" fill="#f1e6d6"/>${passLayers(g, m)}<path d="${pathData(m(g.base))}" fill="none" stroke="#e0362b" stroke-width="${num(Math.max(o.width, o.height) * 0.008)}"/>`
      : `<path d="${pathData(g.base)}" fill="none" stroke="#d9d2c6" stroke-width="${num(Math.max(o.width, o.height) * 0.005)}" stroke-dasharray="${num(pad / 3)} ${num(pad / 4)}"/><path d="${pathData(g.raised)}" fill="${STAMP_INK}" fill-opacity=".92" fill-rule="evenodd"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" role="img" aria-label="${view === "laser" ? "加工データ" : "押印プレビュー"}">${body}</svg>`;
}

// Uniform scale and centre that fits a box of content into the margin area
// (less the bold offset):
// the inner rectangle, or for a circle the largest box of the same shape
// inside the inner ellipse. Returns { k, from, to } (scale about `from`, then
// move it to `to`).
export function fitTransform(box, options) {
  const o = { ...normalizeStamp(options), width: options.width, height: options.height };
  // The bold offset grows the ink after the fit, so it is kept inside too.
  const inset = o.margin + Math.max(0, o.boldOffset),
    w = Math.max(o.width - 2 * inset, 0.1),
    h = Math.max(o.height - 2 * inset, 0.1),
    bw = Math.max(box.w, 1e-6),
    bh = Math.max(box.h, 1e-6);
  const k =
    o.shape === "circle"
      ? 1 / Math.hypot(bw / w, bh / h)
      : Math.min(w / bw, h / bh);
  return {
    k,
    from: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
    to: { x: o.width / 2, y: o.height / 2 },
  };
}

// PNG with its physical size: a pHYs chunk (pixels per metre) after IHDR,
// so laser software opens a depth map at its real size in mm.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function withPhysicalSize(png, pxPerMm) {
  const bytes = new Uint8Array(png),
    signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((b, i) => bytes[i] !== b)) throw Error("PNGではありません。");
  const ppm = Math.round(pxPerMm * 1000),
    chunk = new Uint8Array(21),
    view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Signature (8) + IHDR (4 length + 4 type + 13 data + 4 CRC) = 33 bytes.
  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, 33));
  out.set(chunk, 33);
  out.set(bytes.subarray(33), 33 + chunk.length);
  return out;
}
// Depth map resolution: 20 px per mm (508 dpi).
export const DEPTH_MAP_PX_PER_MM = 20;
