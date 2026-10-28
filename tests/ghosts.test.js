// Regression for the erased-hole markers: a ghost must sit where a hole was
// left out (near the skipped hole, away from every kept hole), on the source
// part and, as a mirror-pair ghost, on a linked copy. Uses the user's file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateProject } from "../src/project.js";
import { deriveProject } from "../src/leather/derive.js";
import { syncMirrorParts } from "../src/leather/mirror.js";
import { shapeContours } from "../src/geometry.js";
import { makePart, makeStitchLine, emptyLeather } from "../src/leather/model.js";

const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const nearest = (list, p) => Math.min(...list.map((h) => d2(h, p)));
function checkGhosts(st, label) {
  const pitch = st.line.pattern?.pitch ?? st.sourceLine?.pattern?.pitch ?? 4;
  assert.equal(st.ghosts.length, st.line.skipped?.length ?? 0, `${label}: one ghost per record`);
  for (const g of st.ghosts) {
    assert.ok(nearest(st.holes, g) > pitch * 0.4, `${label}: ghost at (${g.x.toFixed(1)}, ${g.y.toFixed(1)}) lies in a gap`);
    assert.ok(nearest(st.skippedHoles, g) < pitch * 0.6, `${label}: ghost sits at the skipped hole`);
  }
}

test("user file: ghosts mark the erased holes on the source, and their images on the mirror copy", () => {
  const p = validateProject(JSON.parse(fs.readFileSync("tests/fixtures/mirror-skips.json", "utf8")));
  let n = 0;
  syncMirrorParts(p, () => `g${++n}`);
  const d = deriveProject(p);
  const A = d.parts[0].stitch[0], B = d.parts[1].stitch[0];
  checkGhosts(A, "source");
  assert.equal(B.ghosts.length, 0, "a linked copy has no records of its own");
  assert.equal(B.pairedGhosts.length, A.skippedHoles.length);
  for (const g of B.pairedGhosts) {
    assert.ok(nearest(B.holes, g) > 1.5, "pair ghost lies in a gap on the copy");
    assert.ok(nearest(B.allHoles, g) < 1e-6, "pair ghost is exactly a removed copy hole");
  }
});

test("ghosts stay put under symmetry, start offset and reverse (the records are in the line's own frame)", () => {
  const item = { id: "a", type: "rect", name: "a", x: 10, y: 10, w: 60, h: 40, radius: 6, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("rect", 60, 40, 6) };
  const prj = (pattern, skipped) => ({ version: 2, width: 300, height: 200, layers: [{ id: "L", name: "L", visible: true, locked: false }], items: [item], leather: { ...emptyLeather(), parts: [makePart("p", "a", { stitchLines: [makeStitchLine("s", { offset: 3, pattern, skipped })] })] } });
  const base = deriveProject(prj({ pitch: 4, spacing: "arc", symmetry: "none" })).parts[0].stitch[0];
  const victim = base.holes[9];
  const u = victim.s / base.result.length;
  for (const pattern of [
    { pitch: 4, spacing: "arc", symmetry: "none" },
    { pitch: 4, spacing: "arc", symmetry: "auto" },
    { pitch: 4, spacing: "arc", symmetry: "none", startOffset: 11 },
    { pitch: 4, spacing: "arc", symmetry: "none", reverse: true },
    { pitch: 4, spacing: "chord", symmetry: "auto", reverse: true, startOffset: 5 },
  ]) {
    const st = deriveProject(prj(pattern, [{ u }])).parts[0].stitch[0];
    checkGhosts(st, JSON.stringify(pattern));
    assert.ok(d2(st.ghosts[0], victim) < 1e-6, `ghost drawn at the recorded spot for ${JSON.stringify(pattern)}`);
  }
});
