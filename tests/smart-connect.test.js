import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import { layoutGlyphs, layoutText, makeShapingFont } from "../src/typography.js";
import {
  analyze,
  generate,
  rebuild,
  textInput,
  outlineInput,
  normalizeSettings,
  nextCandidate,
  setConnector,
  removeConnector,
  moveEnd,
  moveConnector,
  addConnector,
  finalize,
  pieceCount,
  polylinePath,
  connectorShape,
  DEFAULT_SETTINGS,
  STYLES,
} from "../src/smart-connect.js";
import { unionRegions, intersectionArea, polygonArea, segmentsIntersect, offsetContours } from "../src/polygon.js";
import { shapeContours, worldContours, exportSVG, bounds, transform } from "../src/geometry.js";
import { splitParts } from "../src/grouping.js";
import { pathContours } from "../src/path.js";
import { validateProject } from "../src/project.js";
import { FONT_CATALOG } from "../src/fonts.js";

// ---- helpers
const rect = (x, y, w, h) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
  { x, y },
];
// A hole is wound the other way, as in glyph outlines (nonzero fill).
const hole = (x, y, w, h) => rect(x, y, w, h).reverse();
const outline = (id, contours, extra = {}) => ({
  id,
  type: "outline",
  name: id,
  x: 0,
  y: 0,
  rotation: 0,
  layerId: "L",
  contours,
  ...extra,
});
const area = (contours) => contours.reduce((n, c) => n + polygonArea(c), 0);
const materialArea = (analysis) => analysis.components.reduce((n, c) => n + c.area, 0);
function selfIntersections(contours) {
  let count = 0;
  for (const c of contours)
    for (let i = 1; i < c.length; i++)
      for (let j = i + 2; j < c.length; j++) {
        if (i === 1 && j === c.length - 1) continue;
        if (segmentsIntersect(c[i - 1], c[i], c[j - 1], c[j])) count++;
      }
  return count;
}
// The union must keep every bit of the original material.
function keepsMaterial(analysis, plan) {
  const kept = intersectionArea(plan.union, analysis.material);
  return kept >= materialArea(analysis) - 1e-3;
}
const read = (file) => {
  const b = fs.readFileSync(new URL(`../public/fonts/${file}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const fontCache = new Map();
function fontOf(id) {
  if (!fontCache.has(id)) {
    const entry = FONT_CATALOG.find((f) => f.id === id),
      bytes = read(entry.file);
    fontCache.set(id, { font: opentype.parse(bytes), shaping: makeShapingFont(bytes) });
  }
  return fontCache.get(id);
}
function textItem(text, fontId, extra = {}) {
  const { font, shaping } = fontOf(fontId);
  const item = { id: `t-${text}`, type: "text", name: text, text, font: fontId, size: 20, spacing: 0.5, vertical: false, x: 5, y: 5, rotation: 0, layerId: "L", ...extra };
  item.contours = layoutText(item, font, shaping);
  return { item, glyphs: layoutGlyphs(item, font, shaping) };
}
const textAnalysis = (text, fontId, extra) => {
  const { item, glyphs } = textItem(text, fontId, extra);
  return { analysis: analyze([textInput(item, glyphs)]), item };
};

// ---- settings
test("settings: defaults, validation of width / max gap, whole-piece implies both connection kinds", () => {
  const s = normalizeSettings();
  assert.deepEqual({ ...s, nearestOnly: undefined }, { ...DEFAULT_SETTINGS, nearestOnly: undefined });
  assert.equal(s.width, 1.5);
  assert.equal(s.maxGap, 10);
  assert.equal(s.style, "auto");
  for (const bad of [NaN, 0, -1, "abc", 51, Infinity]) assert.throws(() => normalizeSettings({ width: bad }), /接続幅/);
  for (const bad of [NaN, 0, 201]) assert.throws(() => normalizeSettings({ maxGap: bad }), /最大距離/);
  assert.throws(() => normalizeSettings({ style: "zigzag" }), /スタイル/);
  assert.equal(normalizeSettings({ wholePiece: true, withinCharacters: false }).withinCharacters, true);
  const partial = normalizeSettings({ wholePiece: false, adjacentCharacters: false });
  assert.equal(partial.wholePiece, false);
  assert.equal(partial.adjacentCharacters, false);
  assert.ok(Object.keys(STYLES).includes("straight"));
});

// ---- stage 1: components
test("components: none, one, several; overlapping parts merge; holes and islands inside holes", () => {
  assert.equal(analyze([outlineInput(outline("e", []))]).components.length, 0);
  const one = analyze([outlineInput(outline("a", [rect(0, 0, 10, 10)]))]);
  assert.equal(one.components.length, 1);
  assert.equal(one.components[0].items[0], "a");
  const overlapping = analyze([outlineInput(outline("a", [rect(0, 0, 10, 10)])), outlineInput(outline("b", [rect(5, 5, 10, 10)]))]);
  assert.equal(overlapping.components.length, 1, "overlap is one part");
  assert.deepEqual(overlapping.components[0].items.sort(), ["a", "b"]);
  // 回: frame with a hole, and an island inside the hole.
  const frame = analyze([outlineInput(outline("k", [rect(0, 0, 20, 20), hole(4, 4, 12, 12), rect(8, 8, 4, 4)]))]);
  assert.equal(frame.components.length, 2);
  assert.equal(frame.components.find((c) => c.holes.length).holes.length, 1);
  assert.equal(frame.holesBefore, 1);
  const apart = analyze([outlineInput(outline("p", [rect(0, 0, 5, 5), rect(20, 0, 5, 5), rect(40, 0, 5, 5)]))]);
  assert.equal(apart.components.length, 3);
  assert.deepEqual(apart.components.map((c) => c.bounds.x), [0, 20, 40], "sorted left to right");
});

test("components: a point contact is not a connection, a shared edge and a hairline overlap are (the hairline is reported)", () => {
  const point = analyze([outlineInput(outline("p", [rect(0, 0, 10, 10), rect(10, 10, 10, 10)]))]);
  assert.equal(point.components.length, 2, "corner touch stays two parts");
  const edge = analyze([outlineInput(outline("e", [rect(0, 0, 10, 10), rect(10, 0, 10, 10)]))]);
  assert.equal(edge.components.length, 1, "shared edge is one part");
  const hair = analyze([outlineInput(outline("h", [rect(0, 0, 10, 10), rect(9.9, 4, 10, 2)]))]);
  assert.equal(hair.components.length, 1, "a finite overlap is one part");
  // With glyph membership the thin contact is named in the diagnostics.
  const glyphs = [
    { text: "A", line: 0, contours: [rect(0, 0, 10, 10)] },
    { text: "B", line: 0, contours: [rect(9.95, 0, 0.1, 10), rect(10, 0, 10, 10)] },
  ];
  const a = analyze([{ id: "t", contours: [rect(0, 0, 10, 10), rect(9.95, 0, 0.1, 10), rect(10, 0, 10, 10)], glyphs }]);
  assert.equal(a.components.length, 1);
  const plan = generate(a, { width: 1.5 });
  assert.equal(plan.warnings.length, 0, "a 10 mm wide seam is wider than the connector");
  const thinGlyphs = [
    { text: "A", line: 0, contours: [rect(0, 0, 10, 10)] },
    { text: "B", line: 0, contours: [rect(9.9, 4, 0.5, 0.4), rect(10.3, 0, 10, 10)] },
  ];
  const thin = analyze([{ id: "t", contours: thinGlyphs.flatMap((g) => g.contours), glyphs: thinGlyphs }]);
  assert.equal(thin.components.length, 1);
  const thinPlan = generate(thin, { width: 1.5 });
  assert.deepEqual(thinPlan.warnings, ["AB"]);
  assert.match(thinPlan.messages.join(" "), /接続幅より狭い接触/);
  assert.equal(thinPlan.ok, true, "a warning does not block");
});

test("components: glyph membership survives rotation and warp (world coordinates)", () => {
  const { item, glyphs } = textItem("iT", "zen", { rotation: 30, x: 40, y: 20 });
  const analysis = analyze([textInput(item, glyphs)]);
  assert.equal(analysis.glyphs.length, 2);
  const dot = analysis.components.find((c) => c.area < 5);
  assert.ok(dot, "the dot of i is a small separate part");
  assert.equal(analysis.glyphs[dot.glyphs[0]].text, "i");
  const world = bounds(worldContours(item));
  for (const c of analysis.components) {
    assert.ok(c.bounds.x >= world.x - 1e-3 && c.bounds.x + c.bounds.w <= world.x + world.w + 1e-3, "inside the rotated item");
  }
  // Warped text: every glyph lands in a component and the union of glyph
  // outlines is the item outline.
  const { font, shaping } = fontOf("zen");
  const warped = { ...item, rotation: 0, warp: { preset: "arc", bend: 0.5, envelope: [
    { x: 0, y: 0.2 }, { x: 0.33, y: -0.1 }, { x: 0.66, y: -0.1 }, { x: 1, y: 0.2 },
    { x: 1, y: 0.5 }, { x: 1, y: 0.8 }, { x: 1, y: 1 }, { x: 0.66, y: 1 }, { x: 0.33, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0.8 }, { x: 0, y: 0.5 },
  ] } };
  warped.contours = layoutText(warped, font, shaping);
  const w = analyze([textInput(warped, layoutGlyphs(warped, font, shaping))]);
  assert.ok(w.glyphs.every((g) => g.components.length >= 1), "every glyph belongs to a part");
  assert.ok(Math.abs(intersectionArea(w.material, w.glyphs.flatMap((g) => g.contours)) - materialArea(w)) < 1e-3);
});

// ---- stage 2: candidates
test("candidates: a stroke-end candidate beats a slightly nearer side-to-side one; distance-only scoring picks the side", () => {
  // A: horizontal bar; B: a parallel bar below joined to a vertical bar to the right.
  const A = rect(0, 0, 10, 2),
    B = [rect(0, 4, 10, 2), rect(10, 4, 2.5, 2), rect(12.5, -6, 2, 14)];
  const analysis = analyze([outlineInput(outline("a", [A])), outlineInput(outline("b", B))]);
  assert.equal(analysis.components.length, 2);
  const plan = generate(analysis, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.connectors.length, 1);
  const c = plan.connectors[0];
  const ends = [c.a, c.b];
  assert.ok(ends.some((e) => e.tip > 0.5 && Math.abs(e.p.x - 10) < 1e-6), `attached at the bar end: ${JSON.stringify(ends.map((e) => e.p))}`);
  const nearest = generate(analysis, { nearestOnly: true });
  assert.equal(nearest.connectors.length, 1);
  assert.ok(nearest.connectors[0].a.tip < 0.5 && nearest.connectors[0].b.tip < 0.5, "distance-only uses the sides");
  assert.ok(Math.abs(nearest.connectors[0].a.p.y - nearest.connectors[0].b.p.y) - 2 < 1e-6);
});

test("candidates: connections never cross other material, and blocked pairs are diagnosed", () => {
  // A and C face each other across B; a straight A–C line would cross B.
  const analysis = analyze([outlineInput(outline("x", [rect(0, 0, 4, 10), rect(6, 0, 4, 10), rect(12, 0, 4, 10)]))]);
  const plan = generate(analysis, { maxGap: 20 });
  assert.equal(plan.ok, true);
  assert.equal(plan.connectors.length, 2);
  for (const c of plan.connectors) assert.ok(Math.abs(c.pair[0] - c.pair[1]) === 1, "neighbours only");
  // Two parts that cannot see each other: everything between is blocked.
  const wall = analyze([
    outlineInput(outline("w", [rect(0, 0, 4, 4), rect(5, -20, 1, 44), rect(7, 0, 4, 4)])),
  ]);
  const blocked = generate(wall, { maxGap: 3, wholePiece: true });
  // A→wall and wall→C are within 3 mm, so the whole becomes one piece.
  assert.equal(blocked.ok, true);
  const far = generate(analyze([outlineInput(outline("f", [rect(0, 0, 4, 4), rect(20, 0, 4, 4)]))]), { maxGap: 5 });
  assert.equal(far.ok, false);
  assert.equal(far.connectors.length, 0);
  assert.equal(far.unconnected.length, 2);
  assert.match(far.messages[0], /最大距離 5 mm 以内に相手がない/);
  const edge = generate(analyze([outlineInput(outline("g", [rect(0, 0, 4, 4), rect(9, 0, 4, 4)]))]), { maxGap: 5 });
  assert.equal(edge.ok, true, "a gap exactly at the limit connects");
  const over = generate(analyze([outlineInput(outline("g", [rect(0, 0, 4, 4), rect(9.2, 0, 4, 4)]))]), { maxGap: 5 });
  assert.equal(over.ok, false, "a gap beyond the limit does not");
});

test("candidates: deterministic output for the same input", () => {
  const make = () => generate(analyze([outlineInput(outline("d", [rect(0, 0, 5, 5), rect(8, 1, 5, 5), rect(3, 9, 5, 5)]))]), {});
  const strip = (plan) => JSON.stringify(plan.connectors.map((c) => [c.pair, c.a.p, c.b.p, c.resolvedStyle]));
  assert.equal(strip(make()), strip(make()));
});

// ---- stage 3: connector shapes and minimal selection
test("connectors: every style yields a closed band that overlaps both parts; tapered is wider at the roots", () => {
  const analysis = analyze([outlineInput(outline("s", [rect(0, 0, 10, 4), rect(16, 0, 10, 4)]))]);
  for (const style of ["smooth", "tapered", "rounded", "straight"]) {
    const plan = generate(analysis, { style });
    assert.equal(plan.ok, true, style);
    const c = plan.connectors[0];
    assert.equal(c.resolvedStyle, style);
    assert.equal(c.fallback, false);
    assert.ok(c.polygon.length >= 1);
    assert.ok(intersectionArea(c.polygon, [rect(0, 0, 10, 4)]) > 0.1, `${style} overlaps the left part`);
    assert.ok(intersectionArea(c.polygon, [rect(16, 0, 10, 4)]) > 0.1, `${style} overlaps the right part`);
    assert.equal(pieceCount(plan.union), 1);
  }
  const tapered = connectorShape({ a: { p: { x: 10, y: 2 }, nout: { x: 1, y: 0 }, depth: 10, tip: 1 }, b: { p: { x: 16, y: 2 }, nout: { x: -1, y: 0 }, depth: 10, tip: 1 }, width: 1.5, style: "tapered" });
  const ys = (x) => tapered[0].filter((p) => Math.abs(p.x - x) < 0.3).map((p) => p.y);
  const spread = (list) => Math.max(...list) - Math.min(...list);
  assert.ok(spread(ys(13)) < spread(ys(10.5)), "narrower in the middle than at the root");
  assert.ok(Math.abs(spread(ys(13)) - 1.5) < 0.3, "the middle is the design width");
});

test("selection: N parts get N−1 connectors, already-joined parts get none, and the union is one clean piece", () => {
  const parts = [rect(0, 0, 5, 5), rect(8, 0, 5, 5), rect(16, 0, 5, 5), rect(24, 0, 5, 5), rect(8, 8, 5, 5)];
  const analysis = analyze([outlineInput(outline("n", parts))]);
  assert.equal(analysis.components.length, 5);
  const plan = generate(analysis, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.connectors.length, 4);
  assert.equal(plan.before, 5);
  assert.equal(plan.after, 1);
  assert.equal(pieceCount(plan.union), 1);
  assert.equal(selfIntersections(plan.union), 0);
  assert.ok(keepsMaterial(analysis, plan));
  const joined = generate(analyze([outlineInput(outline("j", [rect(0, 0, 5, 5), rect(4, 0, 5, 5)]))]), {});
  assert.equal(joined.connectors.length, 0);
  assert.equal(joined.ok, true);
  assert.equal(joined.after, 1);
});

test("selection: holes are kept; an island in a hole connects to its frame without filling the hole", () => {
  const analysis = analyze([outlineInput(outline("k", [rect(0, 0, 20, 20), hole(4, 4, 12, 12), rect(8, 8, 4, 4)]))]);
  const plan = generate(analysis, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.connectors.length, 1);
  assert.equal(plan.holesAfter, 1);
  assert.equal(plan.after, 1);
  const remaining = unionRegions(plan.union)[0].holes[0];
  assert.ok(polygonArea(remaining) > 144 - 16 - 3 * 12, "the hole keeps most of its area");
});

test("selection: partial modes connect only within or between characters and report remaining pieces", () => {
  const glyphs = [
    { text: "i", line: 0, contours: [rect(0, 4, 2, 10), rect(0, 0, 2, 2)] },
    { text: "j", line: 0, contours: [rect(5, 4, 2, 10), rect(5, 0, 2, 2)] },
    { text: "k", line: 0, contours: [rect(10, 4, 2, 10)] },
  ];
  const analysis = analyze([{ id: "t", contours: glyphs.flatMap((g) => g.contours), glyphs }]);
  assert.equal(analysis.components.length, 5);
  const within = generate(analysis, { wholePiece: false, withinCharacters: true, adjacentCharacters: false });
  assert.equal(within.connectors.length, 2, "one per dotted letter");
  assert.equal(within.after, 3);
  assert.equal(within.ok, true, "partial mode succeeds with pieces left");
  assert.equal(within.unconnected.length, 3);
  const between = generate(analysis, { wholePiece: false, withinCharacters: false, adjacentCharacters: true });
  const glyphOf = (k) => analysis.components[k].glyphs[0];
  assert.ok(between.connectors.length >= 2);
  assert.ok(between.connectors.every((c) => glyphOf(c.pair[0]) !== glyphOf(c.pair[1])), "never inside one character");
  assert.ok(between.connectors.every((c) => Math.abs(glyphOf(c.pair[0]) - glyphOf(c.pair[1])) === 1), "only neighbouring characters");
  const whole = generate(analysis, {});
  assert.equal(whole.connectors.length, 4);
  assert.equal(whole.after, 1);
  // Fixed outlines have no characters: only the whole-piece mode connects.
  const plain = analyze([outlineInput(outline("p", [rect(0, 0, 2, 2), rect(5, 0, 2, 2)]))]);
  assert.equal(plain.hasGlyphInfo, false);
  assert.equal(generate(plain, { wholePiece: false, withinCharacters: true }).connectors.length, 0);
  assert.equal(generate(plain, {}).connectors.length, 1);
});

// ---- stage 4: manual adjustment
test("manual: next candidate, width, style, curvature, move, end move, delete, add; deleting breaks the whole-piece check", () => {
  const analysis = analyze([outlineInput(outline("m", [rect(0, 0, 10, 10), rect(14, 0, 10, 10)]))]);
  let plan = generate(analysis, {});
  assert.equal(plan.connectors.length, 1);
  const id = plan.connectors[0].id,
    first = plan.connectors[0];
  assert.ok(first.candidates.length > 1, "several candidates along the facing sides");
  plan = nextCandidate(analysis, plan, id);
  assert.notDeepEqual(plan.connectors[0].a.p, first.a.p);
  assert.equal(plan.connectors[0].manual, true);
  assert.equal(plan.ok, true);
  plan = setConnector(analysis, plan, id, { width: 3, style: "rounded", curvature: 0.8 });
  assert.equal(plan.connectors[0].width, 3);
  assert.equal(plan.connectors[0].resolvedStyle, "rounded");
  assert.ok(area(plan.connectors[0].polygon) > area(first.polygon), "wider band");
  assert.throws(() => setConnector(analysis, plan, id, { width: 0 }), /接続幅/);
  assert.throws(() => setConnector(analysis, plan, id, { curvature: 5 }), /曲率/);
  plan = moveConnector(analysis, plan, id, { x: 0, y: 6 });
  assert.ok(plan.connectors[0].a.p.y > first.a.p.y, "slid down along the sides");
  assert.ok(Math.abs(plan.connectors[0].a.p.x - 10) < 1e-6 && Math.abs(plan.connectors[0].b.p.x - 14) < 1e-6, "ends stay on the boundaries");
  plan = moveEnd(analysis, plan, id, "a", { x: 10, y: 1 });
  assert.ok(Math.abs(plan.connectors[0].a.p.y - 1) < 0.5);
  assert.equal(plan.ok, true);
  // Moving an end to the far side makes the band cross the part: rejected with a reason.
  const bad = moveEnd(analysis, plan, id, "a", { x: 0, y: 5 });
  assert.equal(bad.ok, false);
  assert.ok(bad.connectors[0].problem, "problem is reported");
  const removed = removeConnector(analysis, plan, id);
  assert.equal(removed.connectors.length, 0);
  assert.equal(removed.ok, false);
  assert.match(removed.messages[0], /全体を1つにできません/);
  assert.throws(() => finalize(analysis, removed), /全体を1つにできません/);
  const added = addConnector(analysis, removed, { x: 10, y: 8 }, { x: 14, y: 8 });
  assert.equal(added.connectors.length, 1);
  assert.equal(added.ok, true);
  assert.throws(() => addConnector(analysis, removed, { x: 1, y: 1 }, { x: 2, y: 2 }), /別々の部品/);
  // Regeneration with new settings replaces manual work but is valid again.
  const regenerated = generate(analysis, { width: 2 });
  assert.equal(regenerated.connectors[0].manual, false);
  assert.equal(rebuild(analysis, regenerated).ok, true);
});

// ---- stage 5: result
test("finalize: closed line-node path with the same contours, project-valid and exportable without the font", () => {
  const { analysis } = textAnalysis("i", "zen");
  const plan = generate(analysis, {});
  assert.equal(plan.ok, true);
  const result = finalize(analysis, plan);
  assert.equal(pieceCount(result.contours), 1);
  assert.ok(result.path.every((s) => s.closed && s.nodes.every((n) => !n.in && !n.out)));
  assert.equal(result.path.length, result.contours.length);
  const flat = pathContours(result.path);
  assert.equal(flat.length, result.contours.length);
  flat.forEach((c, i) => assert.equal(c.length, result.contours[i].length));
  const item = outline("r", result.contours, { path: result.path, layerId: "layer-default" });
  const project = validateProject({ version: 2, width: 240, height: 160, layers: [{ id: "layer-default", name: "L", visible: true, locked: false }], items: [item] });
  assert.equal(project.items[0].path.length, result.path.length);
  const svg = exportSVG(project);
  assert.match(svg, /<path d="M/);
  assert.doesNotMatch(svg, /<text|NaN/);
  assert.equal(splitParts(item).length, 1, "one part after connecting");
  assert.deepEqual(polylinePath([[{ x: 0, y: 0 }, { x: 1, y: 0 }]]), []);
});

// ---- stage 6: real fonts
const CASES = [
  ["TypeFab", "zen"], ["TypeFab", "shippori"], ["i", "zen"], ["i", "shippori"], ["A B C", "zen"], ["A B C", "shippori"],
  ["ここまで読んだ", "zen"], ["ここまで読んだ", "shippori"], ["ありがとう", "zen"], ["ありがとう", "shippori"],
  ["タイプファブ", "zen"], ["タイプファブ", "shippori"], ["文字", "zen"], ["文字", "shippori"], ["加工", "zen"], ["加工", "shippori"], ["設計", "zen"], ["設計", "shippori"],
];
test("real fonts: Latin, hiragana, katakana and kanji become one piece with N−1 connectors, holes kept, no self-intersection", () => {
  for (const [text, fontId] of CASES) {
    const { analysis } = textAnalysis(text, fontId);
    const plan = generate(analysis, { maxGap: 14 });
    assert.equal(plan.ok, true, `${text} ${fontId}: ${plan.messages.join(" ")}`);
    assert.equal(plan.after, 1, `${text} ${fontId} is one piece`);
    assert.equal(plan.connectors.length, analysis.components.length - 1, `${text} ${fontId} uses N−1 connectors`);
    assert.ok(plan.holesAfter >= analysis.holesBefore, `${text} ${fontId} keeps holes`);
    assert.ok(keepsMaterial(analysis, plan), `${text} ${fontId} keeps the material`);
    if (analysis.material.flat().length < 4000) assert.equal(selfIntersections(plan.union), 0, `${text} ${fontId} union is simple`);
    const result = finalize(analysis, plan);
    assert.equal(pieceCount(result.contours), 1);
  }
});

test("real fonts: Japanese text prefers stroke ends and differs from distance-only scoring; wide spacing fails with a distance reason", () => {
  const { analysis } = textAnalysis("ここまで読んだ", "zen");
  const plan = generate(analysis, {}),
    nearest = generate(analysis, { nearestOnly: true });
  const tips = plan.connectors.filter((c) => c.a.tip > 0.5 || c.b.tip > 0.5);
  assert.ok(tips.length >= 3, `stroke-end connections: ${tips.length}`);
  const key = (p) => p.connectors.map((c) => `${c.a.p.x.toFixed(1)},${c.a.p.y.toFixed(1)}-${c.b.p.x.toFixed(1)},${c.b.p.y.toFixed(1)}`).sort().join("|");
  assert.notEqual(key(plan), key(nearest), "scoring changes the chosen connections");
  const failing = textAnalysis("ありがとう", "shippori", { spacing: 3 });
  const fail = generate(failing.analysis, { maxGap: 6 });
  assert.equal(fail.ok, false);
  assert.ok(fail.unconnected.length > 1);
  assert.match(fail.messages.join(" "), /最大距離|超える/);
});

test("real fonts: vertical text across columns connects only as a whole piece; the other bundled fonts run without errors", () => {
  const { analysis } = textAnalysis("文字\n設計", "shippori", { vertical: true });
  assert.ok(new Set(analysis.glyphs.map((g) => g.line)).size === 2, "two columns");
  const columnsOnly = generate(analysis, { wholePiece: false, withinCharacters: true, adjacentCharacters: true });
  assert.equal(columnsOnly.after, 2, "columns stay apart without the whole-piece option");
  const whole = generate(analysis, { maxGap: 14 });
  assert.equal(whole.ok, true, whole.messages.join(" "));
  assert.equal(whole.after, 1);
  for (const f of FONT_CATALOG.filter((f) => !["zen", "shippori"].includes(f.id))) {
    const { analysis } = textAnalysis("文字Ab", f.id);
    const plan = generate(analysis, { maxGap: 12 });
    assert.ok(plan.union.length > 0, f.id);
    assert.ok(plan.connectors.every((c) => c.polygon.length > 0), f.id);
    assert.ok(keepsMaterial(analysis, plan), f.id);
  }
});

test("regression: existing stencil bridges and part splitting are unchanged by the shared polygon helpers", () => {
  const item = outline("k", [rect(0, 0, 20, 20), hole(4, 4, 12, 12), rect(8, 8, 4, 4)]);
  const parts = splitParts(item);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].contours.length + parts[1].contours.length, 3);
  const grown = offsetContours([rect(0, 0, 10, 10)], 1);
  assert.ok(Math.abs(polygonArea(grown[0]) - 144) < 0.5);
});
