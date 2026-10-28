import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { shapeContours } from "../src/geometry.js";
import { makePart, makeStitchLine, emptyLeather } from "../src/leather/model.js";
import { deriveProject, symmetryAxes } from "../src/leather/derive.js";
import { validateProject } from "../src/project.js";

const layer = { id: "L", name: "L", visible: true, locked: false };
const project = (items, leather) => ({ version: 2, width: 300, height: 200, layers: [layer], items, leather: { ...emptyLeather(), ...leather } });
const has = (holes, q, eps = 0.02) => holes.some((h) => Math.hypot(h.x - q.x, h.y - q.y) < eps);
const centre = (holes) => { const xs = holes.map((h) => h.x), ys = holes.map((h) => h.y); return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }; };

test("rounded rectangle: holes are mirror-symmetric about both axes (auto), and not with symmetry off", () => {
  const item = { id: "a", type: "rect", name: "a", x: 17, y: 23, w: 61, h: 37, radius: 7, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("rect", 61, 37, 7) };
  const run = (symmetry) => deriveProject(project([item], { parts: [makePart("p", "a", { stitchLines: [makeStitchLine("s", { offset: 3, pattern: { pitch: 3.7, spacing: "chord", symmetry } })] })] })).parts[0].stitch[0];
  const st = run("auto");
  assert.deepEqual(st.symmetry, ["vertical", "horizontal"]);
  const c = { x: 17 + 61 / 2, y: 23 + 37 / 2 };
  for (const h of st.holes) {
    assert.ok(has(st.holes, { x: 2 * c.x - h.x, y: h.y }), `left-right mirror of (${h.x.toFixed(2)}, ${h.y.toFixed(2)})`);
    assert.ok(has(st.holes, { x: h.x, y: 2 * c.y - h.y }), `top-bottom mirror of (${h.x.toFixed(2)}, ${h.y.toFixed(2)})`);
  }
  assert.equal(st.holes.length % 2, 0);
  const off = run("none");
  assert.equal(off.symmetry.length, 0);
  const asym = off.holes.filter((h) => !has(off.holes, { x: 2 * c.x - h.x, y: h.y })).length;
  assert.ok(asym > 0, "without symmetry the start is arbitrary and the layout is not mirrored");
  // Rotated part: the axes are detected in the part's own frame.
  const rot = deriveProject(project([{ ...item, rotation: 33 }], { parts: [makePart("p", "a", { stitchLines: [makeStitchLine("s", { offset: 3, pattern: { pitch: 3.7, spacing: "chord" } })] })] })).parts[0].stitch[0];
  assert.deepEqual(rot.symmetry, ["vertical", "horizontal"]);
});

test("user's bar-with-disc part: symmetric about its horizontal axis, top and bottom rows mirror each other", () => {
  const p = validateProject(JSON.parse(fs.readFileSync("tests/fixtures/mirror-skips.json", "utf8")));
  for (const part of p.leather.parts) for (const l of part.stitchLines) delete l.skipped;
  const d = deriveProject(p);
  const st = d.parts[0].stitch[0];
  assert.deepEqual(st.symmetry, ["horizontal"]);
  const cy = centre(st.allHoles).y;
  let worst = 0;
  for (const h of st.allHoles) {
    const best = Math.min(...st.allHoles.map((g) => Math.hypot(g.x - h.x, g.y - (2 * cy - h.y))));
    worst = Math.max(worst, best);
  }
  assert.ok(worst < 0.05, `worst mirror mismatch ${worst}`);
  // The mirror copy's holes still pair as images (joint), unaffected by symmetry.
  assert.ok(d.joints[0].mirrored);
  assert.equal(d.parts[1].stitch[0].holes.length, st.holes.length);
});

test("symmetryAxes: an asymmetric outline has none; a circle has both", () => {
  const ring = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 40 }, { x: 0, y: 40 }, { x: 0, y: 0 }];
  assert.equal(symmetryAxes(ring, { x: 0, y: 0, rotation: 0 }).length, 0);
  const circle = shapeContours("circle", 30, 30)[0];
  assert.equal(symmetryAxes(circle, { x: 5, y: 5, rotation: 0 }).length, 2);
});
