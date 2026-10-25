import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeContours } from "../src/geometry.js";
import { makePart, makeStitchLine, makeJoint, emptyLeather, validateLeather } from "../src/leather/model.js";
import { deriveProject, relativePlacement } from "../src/leather/derive.js";

const layer = { id: "L", name: "L", visible: true, locked: false };
const project = (items, leather) => ({ version: 2, width: 300, height: 200, layers: [layer], items, leather: { ...emptyLeather(), ...leather } });
const rect = (id, x, y, w, h) => ({ id, type: "rect", name: id, x, y, w, h, radius: 0, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("rect", w, h) });
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test("erased holes: the nearest hole to each recorded position is left out and survives a pitch change", () => {
  const item = rect("a", 10, 10, 60, 40);
  const line = makeStitchLine("s", { offset: 3, pattern: { pitch: 4, spacing: "arc", corner: "apex" } });
  const part = makePart("p", "a", { stitchLines: [line] });
  const prj = project([item], { parts: [part] });
  const full = deriveProject(prj).parts[0].stitch[0];
  const victim = full.holes[7];
  const u = victim.s / full.result.length;
  part.stitchLines[0].skipped = [{ u }];
  const d = deriveProject(prj).parts[0].stitch[0];
  assert.equal(d.holes.length, full.holes.length - 1);
  assert.ok(!d.holes.some((h) => d2(h, victim) < 1e-9), "victim gone");
  assert.equal(d.skippedHoles.length, 1);
  assert.equal(d.allHoles.length, full.holes.length);
  // Finer pitch: still exactly one hole missing, the one nearest to the recorded spot.
  part.stitchLines[0].pattern.pitch = 3;
  const fine = deriveProject(prj).parts[0].stitch[0];
  assert.equal(fine.holes.length, fine.allHoles.length - 1);
  const missing = fine.allHoles.find((h) => !fine.holes.includes(h));
  assert.ok(Math.abs(missing.s / fine.result.length - u) * fine.result.length <= 1.5);
  // Round trip.
  const clean = validateLeather(JSON.parse(JSON.stringify(prj.leather)));
  assert.equal(clean.parts[0].stitchLines[0].skipped[0].u, Number(u));
  // A skip that matches nothing (after removing the line's length drastically) is reported.
  part.stitchLines[0].skipped = [{ u: 0.5 }, { u: 0.5 }, { u: 0.5 }];
  const dd = deriveProject(prj);
  assert.ok(dd.issues.some((i) => /対応しません/.test(i.message)));
});

test("erased holes: a joint drops the partner hole on the other piece, and projected lines keep their own skips", () => {
  const a = rect("a", 0, 0, 60, 40), b = rect("b", 100, 0, 60, 40);
  const mk = (id) => makeStitchLine(id, { source: { subpath: 0, from: 1, to: 0 }, offset: 3, pattern: { pitch: 4, spacing: "chord" } });
  const pa = makePart("pa", "a", { stitchLines: [mk("la")] }), pb = makePart("pb", "b", { stitchLines: [mk("lb")] });
  const joint = makeJoint("j", { a: { partId: "pa", lineId: "la" }, b: { partId: "pb", lineId: "lb" } });
  const prj = project([a, b], { parts: [pa, pb], joints: [joint] });
  const n = deriveProject(prj).parts[0].stitch[0].holes.length;
  const full = deriveProject(prj).parts[0].stitch[0];
  pa.stitchLines[0].skipped = [{ u: full.holes[5].s / full.result.length }];
  const d = deriveProject(prj);
  assert.equal(d.parts[0].stitch[0].holes.length, n - 1);
  assert.equal(d.parts[1].stitch[0].holes.length, n - 1, "partner hole dropped too");
  assert.equal(d.joints[0].pairs.length, n - 1);
  for (const pr of d.joints[0].pairs) assert.ok(Math.abs(pr.a.x - (pr.b.x - 100)) < 1e-6);
  // Skip on the slave side also removes the master's partner.
  pb.stitchLines[0].skipped = [{ u: full.holes[2].s / full.result.length }];
  const d2_ = deriveProject(prj);
  assert.equal(d2_.parts[0].stitch[0].holes.length, n - 2);
  assert.equal(d2_.parts[1].stitch[0].holes.length, n - 2);
  // Projected: the bottom part can erase one of the projected holes on its own.
  const bottom = rect("bot", 0, 0, 100, 70), top = rect("top", 10, 30, 80, 35);
  const tl = makeStitchLine("tl", { source: { subpath: 0, from: 1, to: 0 }, offset: 3, pattern: { pitch: 4, spacing: "arc" } });
  const tp = makePart("tp", "top", { stitchLines: [tl] });
  const pl = makeStitchLine("pl", { source: { kind: "projected", partId: "tp", lineId: "tl", placement: relativePlacement(bottom, top) }, offset: 0 });
  const bp = makePart("bp", "bot", { stitchLines: [pl] });
  const p2 = project([bottom, top], { parts: [bp, tp] });
  const before = deriveProject(p2);
  const nb = before.parts[0].stitch[0].holes.length;
  bp.stitchLines[0].skipped = [{ u: before.parts[0].stitch[0].holes[3].s / before.parts[0].stitch[0].result.length }];
  const after = deriveProject(p2);
  assert.equal(after.parts[0].stitch[0].holes.length, nb - 1);
  assert.equal(after.parts[1].stitch[0].holes.length, before.parts[1].stitch[0].holes.length, "top part unaffected");
});
