import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFromItem, regenerate, applyHistory, isStale, normalizeHistory, pathKey } from "../src/leather/history.js";
import { shapeContours, worldContours, bounds } from "../src/geometry.js";
import { pathContours, shapePath } from "../src/path.js";
import { signedArea } from "../src/polygon.js";
import { makePart, makeStitchLine, emptyLeather, validateLeather } from "../src/leather/model.js";
import { deriveProject } from "../src/leather/derive.js";
import { totalLength } from "../src/leather/polyline.js";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const rect = (w, h, radius = 0) => ({ id: "a", type: "rect", name: "a", x: 10, y: 10, w, h, radius, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("rect", w, h, radius) });

test("history: rect base + fillet + hole replays, and editing the base or a radius regenerates everything", () => {
  const item = rect(60, 40);
  const history = { base: baseFromItem(item, shapePath("rect", 60, 40)), features: [], outputKey: "" };
  assert.deepEqual(history.base, { kind: "rect", w: 60, h: 40, radius: 0 });
  history.features.push({ id: "f1", kind: "fillet", subpath: 0, node: 1, radius: 5 }, { id: "f2", kind: "fillet", subpath: 0, node: 3, radius: 5 }, { id: "h1", kind: "hole", x: 30, y: 20, d: 6 });
  let { item: out, errors } = applyHistory(item, history);
  assert.equal(errors.length, 0);
  assert.equal(out.type, "outline");
  assert.equal(out.path.length, 2, "outer ring + hole");
  assert.equal(out.path[0].nodes.length, 6);
  assert.ok(signedArea(out.contours[0]) * signedArea(out.contours[1]) < 0, "hole runs opposite to the outline");
  const holeBox = bounds([out.contours[1]]);
  assert.ok(close(holeBox.w, 6, 0.01) && close(holeBox.x + 3, 30, 0.01));
  // Node 3 referenced the original corner (w,h) because fillet f1 turned node 1 into nodes 1,2.
  assert.ok(out.contours[0].some((p) => close(p.x, 60) && close(p.y, 0)) === false, "corner (60,0) rounded");
  assert.ok(out.contours[0].some((p) => close(p.x, 0) && close(p.y, 40)), "corner (0,40) untouched");
  assert.equal(isStale(out, history, out.path), false);
  // Change the base width and the first radius: same structure, new numbers.
  history.base.w = 90;
  history.features[0].radius = 10;
  ({ item: out, errors } = applyHistory(out, history));
  assert.equal(errors.length, 0);
  assert.equal(out.path[0].nodes.length, 6);
  const b = bounds([out.contours[0]]);
  assert.ok(close(b.w, 90, 1e-6) && close(b.h, 40, 1e-6));
  assert.ok(close(totalLength(out.contours[0]), 2 * (90 + 40) - (10 + 5) * (2 - Math.PI / 2), 0.05));
  // A radius that no longer fits is skipped and reported, not thrown.
  history.features[1].radius = 100;
  ({ item: out, errors } = applyHistory(out, history));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].featureId, "f2");
  assert.equal(out.path[0].nodes.length, 5, "the other fillet still applies");
});

test("history: stitch holes follow a parameter change; stale detection after a foreign edit", () => {
  const item = rect(60, 40);
  const part = makePart("p", "a", {
    stitchLines: [makeStitchLine("s", { offset: 3, pattern: { pitch: 4, spacing: "arc", corner: "apex" } })],
    history: { base: { kind: "rect", w: 60, h: 40, radius: 0 }, features: [{ id: "f", kind: "fillet", node: 2, radius: 8 }] },
  });
  const built = applyHistory(item, part.history).item;
  const prj = (it) => ({ version: 2, width: 300, height: 200, layers: [{ id: "L", name: "L", visible: true, locked: false }], items: [it], leather: { ...emptyLeather(), parts: [part] } });
  const n1 = deriveProject(prj(built)).parts[0].stitch[0].holes.length;
  part.history.base.w = 100;
  const built2 = applyHistory(built, part.history).item;
  const n2 = deriveProject(prj(built2)).parts[0].stitch[0].holes.length;
  assert.ok(n2 > n1, `${n2} > ${n1}`);
  assert.equal(isStale(built2, part.history, built2.path), false);
  const edited = { ...built2, path: structuredClone(built2.path) };
  edited.path[0].nodes[0].x += 3;
  assert.equal(isStale(edited, part.history, edited.path), true);
  // Round trip through the validator.
  const clean = validateLeather(JSON.parse(JSON.stringify({ ...emptyLeather(), parts: [part] })));
  assert.equal(clean.parts[0].history.features[0].radius, 8);
  assert.equal(clean.parts[0].history.base.w, 100);
  assert.throws(() => normalizeHistory({ base: { kind: "nope" } }), /基本形状/);
  assert.notEqual(pathKey(built.path), pathKey(built2.path));
});

test("history: slot feature and circle base", () => {
  const h = { base: { kind: "circle", w: 50, h: 30 }, features: [{ id: "s", kind: "slot", x: 25, y: 15, w: 3, h: 12, rotation: 90 }] };
  const { path, errors } = regenerate(h);
  assert.equal(errors.length, 0);
  const rings = pathContours(path);
  assert.equal(rings.length, 2);
  const sb = bounds([rings[1]]);
  assert.ok(close(sb.w, 12, 0.01) && close(sb.h, 3, 0.01), "slot rotated 90°");
  assert.ok(signedArea(rings[0]) * signedArea(rings[1]) < 0);
});
