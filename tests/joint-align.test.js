import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeContours } from "../src/geometry.js";
import { shapePath, pathContours } from "../src/path.js";
import { makePart, makeStitchLine, makeJoint, emptyLeather } from "../src/leather/model.js";
import { deriveProject } from "../src/leather/derive.js";

const layer = { id: "L", name: "L", visible: true, locked: false };
const project = (items, leather) => ({ version: 2, width: 300, height: 200, layers: [layer], items, leather: { ...emptyLeather(), ...leather } });
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// The same ellipse as an editable path whose node order starts elsewhere and runs the other way.
function rotatedReversedPath(w, h, shift) {
  const [sub] = shapePath("circle", w, h);
  const nodes = [...sub.nodes.slice(shift), ...sub.nodes.slice(0, shift)].reverse().map((n) => ({ ...n, in: n.out, out: n.in }));
  return [{ closed: true, nodes }];
}

test("stacked loops: the joint starts the partner's holes at the master's first hole and runs the same way", () => {
  const a = { id: "a", type: "circle", name: "a", x: 20, y: 20, w: 60, h: 60, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("circle", 60, 60) };
  // The same circle drawn as a 180-gon starting at 10°, traversed the other
  // way: slightly different flattening, so the inset ring starts elsewhere.
  const ring = Array.from({ length: 180 }, (_, i) => { const t = (10 * Math.PI) / 180 - (2 * Math.PI * i) / 180; return { x: 30 + 30 * Math.cos(t), y: 30 + 30 * Math.sin(t) }; });
  ring.push({ ...ring[0] });
  const b = { id: "b", type: "outline", name: "b", x: 20, y: 20, rotation: 0, layerId: "L", ratioLocked: false, contours: [ring] };
  void rotatedReversedPath;
  const mk = (id, extra = {}) => makeStitchLine(id, { offset: 3, pattern: { pitch: 4, spacing: "chord", shape: "diamond", angle: 30, ...extra } });
  // The partner's own start sits 7 mm along the loop (as a user might have set it).
  const pa = makePart("pa", "a", { stitchLines: [mk("la")] }), pb = makePart("pb", "b", { stitchLines: [mk("lb", { startOffset: 7 })] });
  // Without a joint the holes are shifted along the loop (different start / direction).
  const loose = deriveProject(project([a, b], { parts: [pa, pb] }));
  const ha = loose.parts[0].stitch[0].holes, hb0 = loose.parts[1].stitch[0].holes;
  const worst0 = Math.max(...ha.map((h) => Math.min(...hb0.map((g) => d2(g, h)))));
  assert.ok(worst0 > 0.3, `unaligned offset ${worst0}`);
  // With the joint they coincide hole for hole, slants included.
  const joint = makeJoint("j", { a: { partId: "pa", lineId: "la" }, b: { partId: "pb", lineId: "lb" } });
  const d = deriveProject(project([a, b], { parts: [pa, pb], joints: [joint] }));
  const hb = d.parts[1].stitch[0].holes;
  assert.equal(hb.length, ha.length);
  assert.ok(d.joints[0].aligned);
  for (let i = 0; i < ha.length; i++) {
    // 0.1 mm: the partner is a 180-gon, so its inset ring is flattened differently.
    assert.ok(d2(ha[i], hb[i]) < 0.1, `hole ${i}: ${d2(ha[i], hb[i])}`);
    const da = ((ha[i].angle - hb[i].angle) % 180 + 180) % 180;
    assert.ok(Math.min(da, 180 - da) < 2, `slant ${i}: ${da}`);
  }
  assert.ok(d.joints[0].maxDeviation < 0.05);
  // Pieces laid apart are not re-aligned (nothing to align to).
  const far = { ...b, x: 150 };
  const dd = deriveProject(project([a, far], { parts: [pa, pb], joints: [joint] }));
  assert.ok(!dd.joints[0].aligned);
});
