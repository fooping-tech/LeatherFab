import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorItems, axisThrough } from "../src/cad.js";
import { shapeContours, worldContours, bounds } from "../src/geometry.js";
import { shapePath, pathContours } from "../src/path.js";
import { makePart, makeStitchLine, makeJoint, emptyLeather, remapItems } from "../src/leather/model.js";
import { deriveProject } from "../src/leather/derive.js";

const layer = { id: "L", name: "L", visible: true, locked: false };
const project = (items, leather) => ({ version: 2, name: "m", width: 300, height: 200, layers: [layer], items, leather: { ...emptyLeather(), ...leather } });
let n = 0;
const uid = () => `m-${++n}`;
// 0.02 mm: Clipper rounds the inset ring to 1e-4 mm and the chord march is
// solved numerically, so the two sides differ by about 0.01 mm at most.
const close = (a, b, eps = 0.02) => Math.abs(a - b) < eps;

test("a mirrored part with flipped slant has mirror-image holes and stays joined hole for hole", () => {
  // Asymmetric outline (rounded rect with one notch) so the mirror is a real test.
  const path = shapePath("rect", 60, 40, 6);
  path[0].nodes.splice(2, 0, { x: 60, y: 10 }, { x: 52, y: 14 }, { x: 60, y: 18 });
  const item = { id: "a", type: "outline", name: "a", x: 20, y: 20, rotation: 0, layerId: "L", ratioLocked: false, path, contours: pathContours(path) };
  const line = makeStitchLine("s", { source: { subpath: 0, from: 1, to: 0 }, offset: 3, pattern: { pitch: 4, spacing: "chord", shape: "diamond", angle: 30 } });
  const part = makePart("p", "a", { stitchLines: [line] });
  const box = bounds(worldContours(item));
  const axisX = box.x + box.w + 5;
  const [A, B] = axisThrough({ x: axisX, y: 0 }, "vertical");
  const [copy] = mirrorItems([item], A, B, uid);
  const mline = makeStitchLine("ms", { ...line, pattern: { ...line.pattern, flip: true } });
  const mpart = makePart("mp", copy.id, { ...part, stitchLines: [mline] });
  const joint = makeJoint("j", { a: { partId: "p", lineId: "s" }, b: { partId: "mp", lineId: "ms" }, reverse: false });
  const d = deriveProject(project([item, copy], { parts: [part, mpart], joints: [joint] }));
  assert.equal(d.issues.filter((i) => i.level === "error").length, 0, JSON.stringify(d.issues));
  const h1 = d.parts[0].stitch[0].holes, h2 = d.parts[1].stitch[0].holes;
  assert.equal(h1.length, h2.length);
  assert.ok(h1.length > 20);
  // Hole i of the copy is the reflection of hole i of the original…
  for (let i = 0; i < h1.length; i++) {
    assert.ok(close(h2[i].x, 2 * axisX - h1[i].x) && close(h2[i].y, h1[i].y), `hole ${i} mirrored`);
    // …and its slit is the reflected slit: the reflection of each contour point is on the copy's contour.
    // Slit outline within 0.05 mm (a 0.01 mm shift along the line near a
    // corner changes the tangent by a degree or two over a 2 mm slit).
    for (const p of h1[i].contour.slice(0, -1)) assert.ok(h2[i].contour.some((q) => close(q.x, 2 * axisX - p.x, 0.05) && close(q.y, p.y, 0.05)), `slant of hole ${i} mirrored`);
  }
  assert.ok(d.joints[0].maxDeviation < 0.01 && !d.joints[0].adjusted, `joint deviation ${d.joints[0].maxDeviation}`);
  // Without the flip the slants would NOT be mirror images (orientation differs by 2 × 30°).
  const plain = makePart("mp2", copy.id, { ...part, stitchLines: [makeStitchLine("ms2", { ...line })] });
  const d2 = deriveProject(project([item, copy], { parts: [part, plain] }));
  const g = d2.parts[1].stitch[0].holes[3], f = d2.parts[0].stitch[0].holes[3];
  assert.ok(!f.contour.slice(0, -1).every((p) => g.contour.some((q) => close(q.x, 2 * axisX - p.x) && close(q.y, p.y))));
});

test("editing the mirror side only: the copy's holes follow its own outline, the original keeps its holes", () => {
  const item = { id: "a", type: "rect", name: "a", x: 20, y: 20, w: 60, h: 40, radius: 0, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("rect", 60, 40) };
  const [copy] = mirrorItems([item], { x: 100, y: 0 }, { x: 100, y: 1 }, uid);
  const mk = (id, itemId) => makePart(id, itemId, { stitchLines: [makeStitchLine(id + "s", { offset: 3, pattern: { pitch: 4, spacing: "arc", corner: "apex" } })] });
  const before = deriveProject(project([item, copy], { parts: [mk("p", "a"), mk("mp", copy.id)] }));
  const wider = { ...copy, w: 90, contours: shapeContours("rect", 90, 40) };
  const after = deriveProject(project([item, wider], { parts: [mk("p", "a"), mk("mp", copy.id)] }));
  assert.equal(after.parts[0].stitch[0].holes.length, before.parts[0].stitch[0].holes.length, "original unchanged");
  assert.ok(after.parts[1].stitch[0].holes.length > before.parts[1].stitch[0].holes.length, "mirror side re-derived");
});

import { createMirrorPart, syncMirrorParts, detachMirror } from "../src/leather/mirror.js";
import { transform } from "../src/geometry.js";
import { validateLeather } from "../src/leather/model.js";

test("mirror link: hardware is reflected into the copy, source edits propagate, copy edits do not", () => {
  const item = { id: "a", type: "rect", name: "a", x: 20, y: 20, w: 60, h: 40, radius: 6, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("rect", 60, 40, 6) };
  const src = makePart("p", "a", {
    thickness: 2,
    stitchLines: [makeStitchLine("s", { source: { subpath: 0, from: 1, to: 0 }, offset: 3, pattern: { pitch: 4 } })],
    hardware: [{ id: "h", presetId: "rivet-m", x: 10, y: 8, rotation: 20 }],
  });
  const axis = { a: { x: 100, y: 0 }, b: { x: 100, y: 1 } };
  const [copyItem] = mirrorItems([item], axis.a, axis.b, uid);
  const { copy, joints } = createMirrorPart(src, item, copyItem, axis, uid);
  const prj = project([item, copyItem], { parts: [src, copy], joints });
  // Hardware: world position of the copy's rivet is the reflection of the source's.
  const w0 = transform({ x: 10, y: 8 }, item), w1 = transform({ x: copy.hardware[0].x, y: copy.hardware[0].y }, copyItem);
  assert.ok(close(w1.x, 200 - w0.x) && close(w1.y, w0.y), `hardware mirrored: ${JSON.stringify([w0, w1])}`);
  assert.ok(!(copy.hardware[0].x === 10 && copy.hardware[0].y === 8), "not a naive copy of local coordinates");
  assert.equal(copy.mirrorOf.partId, "p");
  assert.equal(copy.thickness, 2);
  assert.equal(syncMirrorParts(prj, uid), 0, "nothing to sync right after creation");
  // Source edit: wider outline and a new fold line → copy follows, ids stay stable.
  const copyLineId = copy.stitchLines[0].id, copyHwId = copy.hardware[0].id;
  prj.items[0] = { ...item, w: 80, contours: shapeContours("rect", 80, 40, 6) };
  src.foldLines.push({ id: "f", name: "折", source: { subpath: 0, from: 0, to: 1 }, offset: 10, kind: "valley", operation: "SCORE" });
  src.thickness = 3;
  assert.equal(syncMirrorParts(prj, uid), 1);
  assert.equal(copy.foldLines.length, 1);
  assert.equal(copy.thickness, 3);
  assert.equal(copy.stitchLines[0].id, copyLineId, "stitch line id kept so the joint stays valid");
  assert.equal(copy.hardware[0].id, copyHwId);
  assert.ok(close(prj.items[1].w, 80), "copy outline re-mirrored");
  assert.equal(prj.items[1].id, copyItem.id);
  const d = deriveProject(prj);
  assert.equal(d.joints[0].count, d.parts[0].stitch[0].holes.length);
  assert.ok(d.joints[0].maxDeviation < 0.01);
  // Copy edit: the source is untouched and nothing syncs back.
  copy.stitchLines[0].offset = 5;
  prj.items[1] = { ...prj.items[1], w: 70, contours: shapeContours("rect", 70, 40, 6) };
  assert.equal(syncMirrorParts(prj, uid), 0);
  assert.equal(src.stitchLines[0].offset, 3);
  assert.ok(close(prj.items[0].w, 80));
  // Detach → source edits stop propagating; the file round-trips.
  detachMirror(prj.leather, copy.id);
  src.thickness = 1;
  assert.equal(syncMirrorParts(prj, uid), 0);
  assert.equal(copy.thickness, 3);
  const clean = validateLeather(JSON.parse(JSON.stringify(prj.leather)));
  assert.equal(clean.parts[1].mirrorOf, undefined);
  const linked = validateLeather(JSON.parse(JSON.stringify({ ...prj.leather, parts: [src, { ...copy, mirrorOf: { partId: "p", axis } }] })));
  assert.equal(linked.parts[1].mirrorOf.partId, "p");
  // Removing the source unlinks the copy.
  remapItems(linked, { removed: ["a"] });
  assert.equal(linked.parts.length, 1);
  assert.equal(linked.parts[0].mirrorOf, undefined);
});
