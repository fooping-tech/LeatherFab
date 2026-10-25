import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateProject } from "../src/project.js";
import { deriveProject } from "../src/leather/derive.js";
import { operationGeometry } from "../src/leather/manufacturing.js";
import { shapeContours } from "../src/geometry.js";
import { makePart, makeStitchLine, emptyLeather } from "../src/leather/model.js";

test("stacked ring on a body (user file): the ring's holes snap onto the body's holes along the shared circle", () => {
  const p = validateProject(JSON.parse(fs.readFileSync("tests/fixtures/stacked-ring.json", "utf8")));
  const d = deriveProject(p);
  const body = d.parts[0].stitch[0].holes, ring = d.parts[2].stitch[0].holes;
  // Holes on the shared circle (marked `shared`) coincide exactly with a body
  // hole; the few ring holes near the bar junction, where the body's line
  // leaves the circle, keep their own positions.
  const shared = ring.filter((h) => h.shared);
  assert.ok(shared.length >= 20, `shared ring holes: ${shared.length}`);
  for (const h of shared) {
    const best = body.reduce((b, g) => { const dd = Math.hypot(g.x - h.x, g.y - h.y); return dd < b.dd ? { g, dd } : b; }, { dd: Infinity });
    assert.ok(best.dd < 1e-6, `offset ${best.dd}`);
    const da = ((best.g.angle - h.angle) % 180 + 180) % 180;
    assert.ok(Math.min(da, 180 - da) < 1e-6, `slant ${da}`);
  }
  const own = ring.filter((h) => !h.shared);
  assert.ok(own.length > 0 && own.length < 12);
  assert.ok(d.issues.some((i) => i.level === "info" && /穴位置に合わせました/.test(i.message)));
  // The mirror copy, laid apart, is untouched by sharing (still joined by count).
  assert.equal(d.parts[1].stitch[0].holes.length, d.parts[0].stitch[0].holes.length);
  // No doubled PUNCH geometry at the shared spots: each shared ring hole has exactly one body partner.
  const punch = operationGeometry(p, d).PUNCH.length;
  assert.equal(punch, body.length + d.parts[1].stitch[0].holes.length + ring.length + 4);
});

test("lines that merely cross are not snapped", () => {
  const a = { id: "a", type: "rect", name: "a", x: 0, y: 0, w: 60, h: 40, radius: 0, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("rect", 60, 40) };
  const b = { id: "b", type: "rect", name: "b", x: 30, y: 20, w: 60, h: 40, radius: 0, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("rect", 60, 40) };
  const mk = (id) => makeStitchLine(id, { offset: 3, pattern: { pitch: 4, spacing: "arc", corner: "apex" } });
  const prj = { version: 2, width: 300, height: 200, layers: [{ id: "L", name: "L", visible: true, locked: false }], items: [a, b], leather: { ...emptyLeather(), parts: [makePart("pa", "a", { stitchLines: [mk("la")] }), makePart("pb", "b", { stitchLines: [mk("lb")] })] } };
  const d = deriveProject(prj);
  assert.ok(!d.issues.some((i) => /穴位置に合わせました/.test(i.message)));
  assert.equal(d.parts[1].stitch[0].holes.length, d.parts[0].stitch[0].holes.length);
});
