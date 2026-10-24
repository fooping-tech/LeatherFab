import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLeather, makePart, makeStitchLine, makeJoint, remapItems, emptyLeather, SCHEMA_VERSION } from "../src/leather/model.js";
import { deriveProject, resolveSource, checkParts } from "../src/leather/derive.js";
import { operationGeometry, applyKerf, exportLeatherSVG, checkManufacturing, selfIntersects, manufacturingSummary } from "../src/leather/manufacturing.js";
import { airtagCase, cardCase } from "../src/leather/templates.js";
import { shapeContours, worldContours, bounds } from "../src/geometry.js";
import { shapePath, pathContours } from "../src/path.js";
import { validateProject } from "../src/project.js";
import { totalLength } from "../src/leather/polyline.js";
import { hardwareContours, HARDWARE_PRESETS } from "../src/leather/hardware.js";

let n = 0;
const makeId = () => `id-${++n}`;
const layer = { id: "L", name: "L", visible: true, locked: false };
const rect = (id, x, y, w, h, radius = 0, extra = {}) => ({ id, type: "rect", name: id, x, y, w, h, radius, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("rect", w, h, radius), ...extra });
const project = (items, leather) => ({ version: 2, name: "t", width: 300, height: 200, layers: [layer], items, leather: { ...emptyLeather(), ...leather } });
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const nearestEdge = (rings, p) => Math.min(...rings.flatMap((r) => r.slice(1).map((b, i) => { const a = r[i]; const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy; const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0; return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); })));

test("model: validation, defaults and schema version", () => {
  const part = makePart("p", "item", { thickness: 2, stitchLines: [{ id: "s", source: { subpath: 0, from: null, to: null }, offset: 3, pattern: { pitch: 4 } }] });
  const clean = validateLeather({ schemaVersion: 1, parts: [part], joints: [], kerf: 0.2 });
  assert.equal(clean.schemaVersion, SCHEMA_VERSION);
  assert.equal(clean.parts[0].stitchLines[0].pattern.shape, "diamond");
  assert.equal(clean.kerf, 0.2);
  assert.throws(() => validateLeather({ schemaVersion: 99, parts: [] }), /新しい/);
  assert.throws(() => validateLeather({ schemaVersion: 1, parts: [{ id: "p", itemId: "x" }, { id: "p", itemId: "y" }] }), /ID/);
  assert.throws(() => makeStitchLine("s", { source: { from: 1, to: null } }), /両端/);
  assert.deepEqual(validateLeather(undefined), emptyLeather());
  // The TypeFab project validator keeps the leather block.
  const p = validateProject(project([rect("a", 0, 0, 10, 10)], { parts: [makePart("p", "a")] }));
  assert.equal(p.leather.parts.length, 1);
  assert.equal(JSON.parse(JSON.stringify(p)).leather.parts[0].itemId, "a");
});

test("derive: a whole-outline stitch line follows the outline when the item moves, resizes or rotates", () => {
  const item = rect("a", 10, 10, 40, 30);
  const part = makePart("p", "a", { stitchLines: [makeStitchLine("s", { offset: 3, pattern: { pitch: 4, spacing: "arc", corner: "apex" } })] });
  const run = (it) => deriveProject(project([it], { parts: [part] })).parts[0].stitch[0];
  const s1 = run(item);
  assert.equal(s1.closed, true);
  assert.ok(close(totalLength(s1.points), 2 * (34 + 24)), "offset ring perimeter");
  for (const h of s1.holes) assert.ok(close(nearestEdge(worldContours(item), h), 3, 1e-6), "every hole 3 mm from the edge");
  const moved = run({ ...item, x: 50, y: 70 });
  assert.equal(moved.holes.length, s1.holes.length);
  assert.ok(close(moved.holes[0].x - s1.holes[0].x, 40) && close(moved.holes[0].y - s1.holes[0].y, 60));
  const bigger = run({ ...item, w: 80, contours: shapeContours("rect", 80, 30) });
  assert.ok(bigger.holes.length > s1.holes.length);
  for (const h of bigger.holes) assert.ok(close(nearestEdge(worldContours({ ...item, w: 80, contours: shapeContours("rect", 80, 30) }), h), 3, 1e-6));
  const rotated = run({ ...item, rotation: 30 });
  for (const h of rotated.holes) assert.ok(close(nearestEdge(worldContours({ ...item, rotation: 30 }), h), 3, 1e-3));
  // Node-edited outline (fixed path) keeps the dependency alive.
  const path = shapePath("rect", 40, 30);
  path[0].nodes[2] = { x: 50, y: 40 };
  const edited = { ...item, type: "outline", path, contours: pathContours(path) };
  const e = run(edited);
  assert.ok(e.holes.length > 0 && !e.error);
  for (const h of e.holes) assert.ok(close(nearestEdge(worldContours(edited), h), 3, 1e-3));
});

test("derive: edge ranges, inward side at concave corners, invalid references are reported not guessed", () => {
  const path = shapePath("rect", 60, 40, 8);
  const item = { ...rect("a", 0, 0, 60, 40, 8), type: "outline", path, contours: pathContours(path) };
  // Nodes of a rounded rect: 0 (rx,0) 1 (w-rx,0) 2 (w,ry) 3 (w,h-ry) ...; run 1→0 skips the top edge.
  const src = resolveSource(path, { subpath: 0, from: 1, to: 0 });
  assert.equal(src.closed, false);
  assert.ok(close(src.points[0].x, 52) && close(src.points[0].y, 0));
  assert.ok(close(src.points.at(-1).x, 8) && close(src.points.at(-1).y, 0));
  const part = makePart("p", "a", { stitchLines: [makeStitchLine("s", { source: { subpath: 0, from: 1, to: 0 }, offset: 3, pattern: { pitch: 4, spacing: "arc" } })] });
  const st = deriveProject(project([item], { parts: [part] })).parts[0].stitch[0];
  assert.ok(st.points.every((p) => p.y >= 3 - 0.01 && p.y <= 37 + 0.01 && p.x >= 3 - 0.01 && p.x <= 57 + 0.01), "offset run lies inside (ends within flattening error)");
  assert.ok(st.holes.every((h) => h.y > 2.9), "no holes on the open top edge");
  // Concave L: the edge at the inner corner still offsets inward.
  const L = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 40 }, { x: 0, y: 40 }];
  const lp = [{ closed: true, nodes: L.map((p) => ({ ...p })) }];
  const li = { id: "l", type: "outline", name: "l", x: 0, y: 0, rotation: 0, layerId: "L", path: lp, contours: pathContours(lp) };
  const lpart = makePart("lp", "l", { stitchLines: [makeStitchLine("ls", { source: { subpath: 0, from: 2, to: 3 }, offset: 3, pattern: { pitch: 4, spacing: "arc" } })] });
  const ls = deriveProject(project([li], { parts: [lpart] })).parts[0].stitch[0];
  assert.ok(ls.points.every((p) => close(p.y, 17, 1e-3)), "edge y=20 (x 40→20) offsets to y=17, inside the L: " + JSON.stringify(ls.points));
  assert.ok(close(ls.points[0].x, 37, 1e-3) && close(ls.points.at(-1).x, 20, 1e-3), "ends 3 mm short of the convex corner and at the foot of the concave one");
  // The rounded-rect run 1→0 is the inset ring minus its top stretch: it
  // starts and ends 3 mm below the top edge, not on the side edges.
  assert.ok(close(st.points[0].y, 3, 1e-3) && close(st.points.at(-1).y, 3, 1e-3), JSON.stringify([st.points[0], st.points.at(-1)]));
  assert.ok(st.points[0].x < 57 - 1e-6 && st.points.at(-1).x > 3 + 1e-6);
  // Invalid: node index beyond the path.
  const bad = makePart("b", "a", { stitchLines: [makeStitchLine("bs", { source: { subpath: 0, from: 1, to: 40 }, offset: 3 })] });
  const dp = deriveProject(project([item], { parts: [bad] }));
  assert.equal(dp.parts[0].stitch[0].holes.length, 0);
  assert.ok(dp.issues.some((i) => i.level === "error" && /ノード数/.test(i.message)));
  // Missing item.
  const gone = deriveProject(project([], { parts: [makePart("g", "nope")] }));
  assert.ok(gone.issues.some((i) => /見つかりません/.test(i.message)));
  // Offset too large collapses the ring.
  const big = makePart("c", "a", { stitchLines: [makeStitchLine("cs", { offset: 25 })] });
  assert.ok(deriveProject(project([item], { parts: [big] })).issues.some((i) => /消えました/.test(i.message)));
  // Material safety is never assumed.
  const unk = makePart("u", "a", { material: "unknown" });
  assert.ok(deriveProject(project([item], { parts: [unk] })).issues.some((i) => /不明/.test(i.message)));
  const pvc = makePart("v", "a", { material: "coated-pvc" });
  assert.ok(deriveProject(project([item], { parts: [pvc] })).issues.some((i) => i.level === "error" && /塩素/.test(i.message)));
});

test("joint: identical edges match exactly, different lengths are harmonised by count and reported", () => {
  const a = rect("a", 0, 0, 60, 40, 6), b = rect("b", 100, 0, 60, 40, 6);
  const line = (id) => makeStitchLine(id, { source: { subpath: 0, from: 1, to: 0 }, offset: 3, pattern: { pitch: 4, spacing: "chord" } });
  const pa = makePart("pa", "a", { stitchLines: [line("la")] }), pb = makePart("pb", "b", { stitchLines: [line("lb")] });
  const joint = makeJoint("j", { a: { partId: "pa", lineId: "la" }, b: { partId: "pb", lineId: "lb" } });
  const dj = deriveProject(project([a, b], { parts: [pa, pb], joints: [joint] })).joints[0];
  assert.equal(dj.adjusted, false);
  assert.ok(dj.maxDeviation < 1e-6 && dj.lengthDiff < 1e-6);
  assert.equal(dj.pairs.length, dj.count);
  for (const pr of dj.pairs) assert.ok(close(pr.a.x, pr.b.x - 100, 1e-6) && close(pr.a.y, pr.b.y, 1e-6));
  // Different edge length: slave gets the master's count, the mismatch is reported.
  const c = rect("c", 100, 0, 70, 40, 6);
  const pc = makePart("pc", "c", { stitchLines: [line("lc")] });
  const j2 = makeJoint("j2", { a: { partId: "pa", lineId: "la" }, b: { partId: "pc", lineId: "lc" } });
  const dd = deriveProject(project([a, c], { parts: [pa, pc], joints: [j2] }));
  const dj2 = dd.joints[0];
  assert.equal(dj2.adjusted, true);
  assert.equal(dd.parts[1].stitch[0].holes.length, dd.parts[0].stitch[0].holes.length, "harmonised in the derived part");
  assert.ok(dd.issues.some((i) => /長さが/.test(i.message)));
  // Reversed pairing maps the first hole to the last.
  const j3 = makeJoint("j3", { a: { partId: "pa", lineId: "la" }, b: { partId: "pb", lineId: "lb" }, reverse: true });
  const dj3 = deriveProject(project([a, b], { parts: [pa, pb], joints: [j3] })).joints[0];
  assert.ok(close(dj3.pairs[0].b.s, dj3.slave.result.length - dj3.pairs[0].a.s, 1e-6));
});

test("remap: deleted items drop their parts and joints, replaced items are re-pointed", () => {
  const leather = { ...emptyLeather(), parts: [makePart("p1", "a"), makePart("p2", "b")], joints: [makeJoint("j", { a: { partId: "p1", lineId: "x" }, b: { partId: "p2", lineId: "y" } })] };
  remapItems(leather, { replaced: { a: "a2" } });
  assert.equal(leather.parts[0].itemId, "a2");
  remapItems(leather, { removed: ["b"] });
  assert.equal(leather.parts.length, 1);
  assert.equal(leather.joints.length, 0);
});

test("manufacturing: operation groups, kerf signs, checks and SVG output in mm", () => {
  const item = rect("a", 10, 10, 60, 40, 5);
  const text = { id: "t", type: "text", name: "t", x: 100, y: 100, rotation: 0, layerId: "L", text: "x", font: "zen", size: 10, spacing: 0, contours: [[{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 0 }]] };
  const part = makePart("p", "a", {
    stitchLines: [makeStitchLine("s", { offset: 3, pattern: { pitch: 4, shape: "round", width: 1 } })],
    foldLines: [{ id: "f", source: { subpath: 0, from: 1, to: 2 }, offset: 10, kind: "valley" }],
    hardware: [{ id: "h", presetId: "rivet-m", x: 30, y: 20 }],
  });
  const prj = project([item, text], { parts: [part], kerf: 0 });
  const derived = deriveProject(prj);
  const groups = operationGeometry(prj, derived);
  assert.equal(groups.CUT.length, 1);
  assert.equal(groups.ENGRAVE.length, 1, "text engraves by default");
  assert.equal(groups.SCORE.length, 1);
  assert.equal(groups.PUNCH.length, derived.parts[0].stitch[0].holes.length + 1);
  const k = applyKerf(groups, 0.2);
  assert.ok(close(bounds([k.CUT[0].points]).w, 60.2, 1e-3), "outer cut grows by kerf/2 each side");
  const hole = groups.PUNCH.at(-1).points, kh = k.PUNCH.at(-1).points;
  assert.ok(close(bounds([kh]).w, bounds([hole]).w - 0.2, 2e-3), "holes shrink by kerf");
  assert.equal(k.SCORE[0].points, groups.SCORE[0].points);
  const svg = exportLeatherSVG(prj, derived, { kerf: 0 });
  assert.match(svg, /width="300mm" height="200mm" viewBox="0 0 300 200"/);
  for (const op of ["CUT", "PUNCH", "SCORE", "ENGRAVE"]) assert.match(svg, new RegExp(`<g id="${op}" data-operation="${op}"`));
  assert.ok(svg.indexOf('id="ENGRAVE"') < svg.indexOf('id="SCORE"') && svg.indexOf('id="PUNCH"') < svg.indexOf('id="CUT"'), "cut last");
  assert.ok(!/<text|<circle|<rect/.test(svg), "paths only");
  // Independent re-parse: every path's numbers are finite and holes are closed.
  const ds = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ds.length, groups.CUT.length + groups.PUNCH.length + groups.SCORE.length + groups.ENGRAVE.length);
  for (const dd of ds) assert.ok(dd.split(/[ML ]+/).filter(Boolean).every((v) => v === "Z" || Number.isFinite(Number(v))));
  const punchPaths = svg.slice(svg.indexOf('id="PUNCH"'), svg.indexOf('id="CUT"')).match(/<path/g).length;
  assert.equal(punchPaths, groups.PUNCH.length);
  const checks = checkManufacturing(prj, groups, derived);
  assert.equal(checks.length, 0);
  const out = checkManufacturing(project([rect("o", 290, 190, 30, 30)], {}), operationGeometry(project([rect("o", 290, 190, 30, 30)], {}), deriveProject(project([], {}))), { parts: [] });
  assert.ok(out.some((i) => i.code === "OUTSIDE_BOARD"));
  const dup = project([rect("a", 0, 0, 10, 10), rect("b", 0, 0, 10, 10)], {});
  assert.ok(checkManufacturing(dup, operationGeometry(dup, deriveProject(dup)), deriveProject(dup)).some((i) => i.code === "DUPLICATE_CUT"));
  assert.ok(selfIntersects([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 0 }]));
  assert.ok(!selfIntersects(shapeContours("rect", 10, 10)[0]));
  const summary = manufacturingSummary(groups);
  assert.ok(summary.punch > 10 && summary.cutLength > 150);
});

test("design rules: holes too close to the edge and hardware near the edge are reported", () => {
  const item = rect("a", 0, 0, 60, 40);
  const part = makePart("p", "a", { stitchLines: [makeStitchLine("s", { offset: 0.5, pattern: { pitch: 4 } })], hardware: [{ id: "h", presetId: "eyelet-8", x: 2, y: 20 }] });
  const issues = checkParts(deriveProject(project([item], { parts: [part] })));
  assert.ok(issues.some((i) => /外形から/.test(i.message)));
  assert.ok(issues.some((i) => /金具/.test(i.message)));
  for (const p of HARDWARE_PRESETS) assert.ok(hardwareContours(p).length >= 1, p.id);
});

test("templates: the AirTag case derives matching holes on both pieces and exports a laser SVG", () => {
  const tpl = airtagCase(makeId, "L");
  const prj = project(tpl.items, { parts: tpl.parts, joints: tpl.joints });
  const derived = deriveProject(prj);
  assert.equal(derived.issues.filter((i) => i.level === "error").length, 0, JSON.stringify(derived.issues));
  const [front, back] = derived.parts;
  assert.equal(front.outline.length, 2, "front has the window hole");
  assert.equal(front.stitch[0].holes.length, back.stitch[0].holes.length);
  assert.ok(front.stitch[0].holes.length >= 30);
  assert.ok(derived.joints[0].maxDeviation < 1e-6);
  // Every hole is 3.5 mm inside the edge and the pocket clears Ø 31.9 mm.
  for (const h of front.stitch[0].holes) assert.ok(close(nearestEdge([front.outline[0]], h), 3.5, 0.01), `hole ${h.x},${h.y} is ${nearestEdge([front.outline[0]], h)} from the edge`);
  assert.ok(42 - 2 * 3.5 > 31.9);
  assert.equal(back.hardware.length, 1);
  const svg = exportLeatherSVG(prj, derived);
  assert.match(svg, /PUNCH \(\d+ holes\)/);
  const groups = operationGeometry(prj, derived);
  assert.equal(checkManufacturing(prj, groups, derived).length, 0);
  const card = cardCase(makeId, "L");
  const cd = deriveProject(project(card.items, { parts: card.parts, joints: card.joints }));
  assert.equal(cd.issues.filter((i) => i.level === "error").length, 0);
  assert.equal(cd.parts[0].stitch[0].holes.length, cd.parts[1].stitch[0].holes.length);
});
