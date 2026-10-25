import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeContours } from "../src/geometry.js";
import { makePart, makeStitchLine, emptyLeather, remapItems, validateLeather } from "../src/leather/model.js";
import { deriveProject, relativePlacement } from "../src/leather/derive.js";
import { operationGeometry } from "../src/leather/manufacturing.js";

const layer = { id: "L", name: "L", visible: true, locked: false };
const project = (items, leather) => ({ version: 2, width: 300, height: 200, layers: [layer], items, leather: { ...emptyLeather(), ...leather } });
const rect = (id, x, y, w, h, rotation = 0) => ({ id, type: "rect", name: id, x, y, w, h, radius: 0, rotation, layerId: "L", ratioLocked: false, contours: shapeContours("rect", w, h) });
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test("projected line: the part below gets the same holes, which stay when the top part moves and follow the top line's pitch", () => {
  const bottom = rect("b", 10, 10, 100, 70);
  const top = rect("t", 20, 40, 80, 35); // sits on the bottom part
  const topLine = makeStitchLine("tl", { source: { subpath: 0, from: 1, to: 0 }, offset: 3, pattern: { pitch: 4, spacing: "arc", corner: "apex" } });
  const topPart = makePart("tp", "t", { stitchLines: [topLine] });
  const proj = makeStitchLine("pl", { source: { kind: "projected", partId: "tp", lineId: "tl", placement: relativePlacement(bottom, top) }, offset: 0 });
  const bottomPart = makePart("bp", "b", { stitchLines: [proj] });
  let prj = project([bottom, top], { parts: [bottomPart, topPart] });
  let d = deriveProject(prj);
  assert.equal(d.issues.filter((i) => i.level === "error").length, 0, JSON.stringify(d.issues));
  const ht = d.parts[1].stitch[0].holes, hb = d.parts[0].stitch[0].holes;
  assert.equal(hb.length, ht.length);
  for (let i = 0; i < ht.length; i++) assert.ok(d2(ht[i], hb[i]) < 1e-6 && close(ht[i].angle, hb[i].angle), `hole ${i} coincides`);
  // PUNCH contains both sets (one per part).
  assert.equal(operationGeometry(prj, d).PUNCH.length, 2 * ht.length);
  // Move the top part away for cutting: the bottom's holes do not move.
  prj = project([bottom, { ...top, x: 150, y: 120 }], { parts: [bottomPart, topPart] });
  const d2_ = deriveProject(prj);
  const hb2 = d2_.parts[0].stitch[0].holes;
  for (let i = 0; i < hb.length; i++) assert.ok(d2(hb[i], hb2[i]) < 1e-6, "bottom holes unchanged");
  // Change the top line's pitch: the bottom follows.
  topPart.stitchLines[0].pattern.pitch = 3;
  const d3 = deriveProject(prj);
  assert.ok(d3.parts[0].stitch[0].holes.length > hb.length);
  assert.equal(d3.parts[0].stitch[0].holes.length, d3.parts[1].stitch[0].holes.length);
  // Rotated bottom part: the placement is relative, so a rotated bottom still carries the holes.
  const rb = { ...bottom, rotation: 20 };
  const topOnRb = { ...top };
  const proj2 = makeStitchLine("pl2", { source: { kind: "projected", partId: "tp", lineId: "tl", placement: relativePlacement(rb, topOnRb) }, offset: 0 });
  const bp2 = makePart("bp2", "b", { stitchLines: [proj2] });
  const d4 = deriveProject(project([rb, topOnRb], { parts: [bp2, topPart] }));
  const h4t = d4.parts[1].stitch[0].holes, h4b = d4.parts[0].stitch[0].holes;
  const kept = h4b.length;
  assert.ok(kept > 0);
  // placement is stored to 4 decimals, so allow 1e-3 mm here.
  for (const h of h4b) assert.ok(h4t.some((g) => d2(g, h) < 1e-3), "each projected hole matches a top hole at capture");
});

test("projected line: holes outside the lower part are dropped with a warning; missing or projected sources are reported", () => {
  const bottom = rect("b", 10, 10, 50, 70);
  const top = rect("t", 20, 40, 80, 35); // overhangs the bottom on the right
  const topLine = makeStitchLine("tl", { source: { subpath: 0, from: null, to: null }, offset: 3, pattern: { pitch: 4, spacing: "arc" } });
  const topPart = makePart("tp", "t", { stitchLines: [topLine] });
  const proj = makeStitchLine("pl", { source: { kind: "projected", partId: "tp", lineId: "tl", placement: relativePlacement(bottom, top) }, offset: 0 });
  const bottomPart = makePart("bp", "b", { stitchLines: [proj] });
  const d = deriveProject(project([bottom, top], { parts: [bottomPart, topPart] }));
  const st = d.parts[0].stitch[0];
  assert.ok(st.dropped > 0 && st.holes.length > 0);
  assert.ok(st.holes.every((h) => h.x <= 60 + 1e-6));
  assert.ok(d.issues.some((i) => /外にある/.test(i.message)));
  // Chained projection is refused.
  const chain = makeStitchLine("cl", { source: { kind: "projected", partId: "bp", lineId: "pl", placement: { x: 0, y: 0, rotation: 0 } }, offset: 0 });
  const third = makePart("cp", "t", { stitchLines: [chain] });
  const dc = deriveProject(project([bottom, top], { parts: [bottomPart, topPart, third] }));
  assert.ok(dc.issues.some((i) => /さらに投影/.test(i.message)));
  // Deleting the source part removes the projection; the file round-trips.
  const leather = { ...emptyLeather(), parts: [bottomPart, topPart] };
  const clean = validateLeather(JSON.parse(JSON.stringify(leather)));
  assert.equal(clean.parts[0].stitchLines[0].source.kind, "projected");
  remapItems(clean, { removed: ["t"] });
  assert.equal(clean.parts.length, 1);
  assert.equal(clean.parts[0].stitchLines.length, 0);
});
