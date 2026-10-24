// Pattern templates (Phase 1: ordinary editable parts). Each template returns
// { items, parts, joints } for a board, positioned to fit the board size.
import { shapeContours } from "../geometry.js";
import { booleanContours } from "../operations.js";
import { pathFromContours, shapePath, pathContours } from "../path.js";
import { makePart, makeStitchLine, makeJoint, makeHardware } from "./model.js";
import { DEFAULT_PATTERN } from "./stitch.js";

const roundedRectItem = (id, name, x, y, w, h, radius, layerId) => ({ id, type: "rect", name, x, y, rotation: 0, w, h, radius, layerId, ratioLocked: false, contours: shapeContours("rect", w, h, radius) });

// AirTag holder: two stadium-shaped pieces (42 × 60 mm, R 15). The front has
// a Ø 24 mm window; the back carries the key-ring hole. Both are stitched
// 3.5 mm inside the edge on every side except the top, where the AirTag
// (Ø 31.9 × 8 mm) slides in. Rounded-rect path nodes run clockwise from the
// top-left end of the top edge, so the run from node 1 forward to node 0 is
// everything but the top edge.
export function airtagCase(makeId, layerId, { x = 20, y = 20 } = {}) {
  const w = 42, h = 60, r = 15, offset = 3.5;
  const front = roundedRectItem(makeId(), "AirTag 表", x, y, w, h, r, layerId);
  // Window: subtract a circle; the result is a fixed path with a hole.
  const windowItem = { id: "tmp", type: "circle", name: "窓", x: x + w / 2 - 12, y: y + 34 - 12, w: 24, h: 24, rotation: 0, layerId, contours: shapeContours("circle", 24, 24) };
  const contours = booleanContours([front, windowItem], "difference");
  // Keep the outer ring as the exact rounded-rect path so edge indices stay
  // meaningful; the window becomes a second (fitted) subpath.
  const outerPath = shapePath("rect", w, h, r);
  const local = contours.map((c) => c.map((p) => ({ x: p.x - x, y: p.y - y })));
  const holeRings = local.filter((c) => Math.abs(c.reduce((s, p, i, a) => s + (a[i - 1] ? a[i - 1].x * p.y - p.x * a[i - 1].y : 0), 0)) < w * h * 0.9);
  const frontPath = [...outerPath, ...pathFromContours(holeRings)];
  const frontOutline = { id: front.id, type: "outline", name: front.name, x, y, rotation: 0, layerId, ratioLocked: false, path: frontPath, contours: pathContours(frontPath) };
  const back = roundedRectItem(makeId(), "AirTag 裏", x + w + 15, y, w, h, r, layerId);
  const pattern = { ...DEFAULT_PATTERN, shape: "diamond", pitch: 3.85, spacing: "chord", corner: "auto" };
  const lineA = makeStitchLine(makeId(), { name: "外周（上辺を除く）", source: { subpath: 0, from: 1, to: 0 }, offset, pattern });
  const lineB = makeStitchLine(makeId(), { name: "外周（上辺を除く）", source: { subpath: 0, from: 1, to: 0 }, offset, pattern });
  const partA = makePart(makeId(), frontOutline.id, { name: "AirTag 表（窓あり）", thickness: 1.5, material: "veg-tan", stitchLines: [lineA] });
  const partB = makePart(makeId(), back.id, {
    name: "AirTag 裏（キーリング穴）",
    thickness: 1.5,
    material: "veg-tan",
    stitchLines: [lineB],
    hardware: [makeHardware(makeId(), { presetId: "key-ring-5", x: w / 2, y: 7 })],
  });
  const joint = makeJoint(makeId(), { name: "表 × 裏", a: { partId: partA.id, lineId: lineA.id }, b: { partId: partB.id, lineId: lineB.id }, reverse: false, master: "a" });
  return { items: [frontOutline, back], parts: [partA, partB], joints: [joint], name: "AirTag ケース" };
}
// Card case: a 95 × 65 mm back and a 95 × 40 mm pocket whose bottom and
// sides coincide with the back's. Both outlines are explicit paths so the
// stitched run is node-to-node on each: the pocket's run is its three closed
// sides (node 1 → 0, square top corners, R 6 bottom corners); the back has
// extra side nodes at y = 25 + offset, i.e. where the pocket's inset stitch
// line ends, so the two runs are the same length and the holes pair 1:1.
function cardPath(w, h, r, sideNodeY = null) {
  const K = 0.5522847498307936 * r;
  const nodes = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    ...(sideNodeY !== null ? [{ x: w, y: sideNodeY }] : []),
    { x: w, y: h - r, out: { x: w, y: h - r + K } },
    { x: w - r, y: h, in: { x: w - r + K, y: h } },
    { x: r, y: h, out: { x: r - K, y: h } },
    { x: 0, y: h - r, in: { x: 0, y: h - r + K } },
    ...(sideNodeY !== null ? [{ x: 0, y: sideNodeY }] : []),
  ];
  return [{ closed: true, nodes }];
}
const pathItem = (id, name, x, y, path, layerId) => ({ id, type: "outline", name, x, y, rotation: 0, layerId, ratioLocked: false, path, contours: pathContours(path) });
export function cardCase(makeId, layerId, { x = 20, y = 20 } = {}) {
  const w = 95, hBack = 65, hPocket = 40, r = 6, offset = 3;
  const back = pathItem(makeId(), "カードケース 本体", x, y, cardPath(w, hBack, r, hBack - hPocket + offset), layerId);
  const pocket = pathItem(makeId(), "カードケース ポケット", x, y + hBack + 15, cardPath(w, hPocket, r), layerId);
  const pattern = { ...DEFAULT_PATTERN, shape: "diamond", pitch: 4, spacing: "chord" };
  // Back nodes: 0 (0,0) 1 (w,0) 2 (w,28) 3 (w,59) 4 (89,65) 5 (6,65) 6 (0,59) 7 (0,28): run 2 → 7.
  const lineBack = makeStitchLine(makeId(), { name: "ポケット縫合線", source: { subpath: 0, from: 2, to: 7 }, offset, pattern });
  const linePocket = makeStitchLine(makeId(), { name: "外周（上辺を除く）", source: { subpath: 0, from: 1, to: 0 }, offset, pattern });
  const partBack = makePart(makeId(), back.id, { name: "本体", thickness: 1.2, stitchLines: [lineBack] });
  const partPocket = makePart(makeId(), pocket.id, { name: "ポケット", thickness: 1.0, stitchLines: [linePocket] });
  const joint = makeJoint(makeId(), { name: "本体 × ポケット", a: { partId: partPocket.id, lineId: linePocket.id }, b: { partId: partBack.id, lineId: lineBack.id }, master: "a" });
  return { items: [back, pocket], parts: [partBack, partPocket], joints: [joint], name: "カードケース" };
}
export const TEMPLATES = Object.freeze([
  { id: "airtag", label: "AirTag ケース", build: airtagCase, note: "表（窓）・裏（キーリング穴）の2枚。上辺以外を 3.85 mm ピッチの菱目で縫合。" },
  { id: "card", label: "カードケース", build: cardCase, note: "本体とポケットの2枚。ポケットの3辺を縫合、上辺は開口。" },
]);
