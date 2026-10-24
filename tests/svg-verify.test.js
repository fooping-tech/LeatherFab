// Re-reads the exported laser SVG with TypeFab's SVG importer (an independent
// parser from the exporter) and checks the geometry against the design:
// document size in mm, part outline size, hole count and hole positions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseXML, svgShapes } from "../src/svgimport.js";
import { airtagCase } from "../src/leather/templates.js";
import { deriveProject } from "../src/leather/derive.js";
import { exportLeatherSVG, operationGeometry } from "../src/leather/manufacturing.js";
import { emptyLeather, makePart, makeStitchLine } from "../src/leather/model.js";
import { shapeContours, bounds, flatten } from "../src/geometry.js";
import { pathContours } from "../src/path.js";

let n = 0;
const makeId = () => `v-${++n}`;
const layer = { id: "L", name: "L", visible: true, locked: false };
const project = (items, leather) => ({ version: 2, name: "v", width: 300, height: 200, layers: [layer], items, leather: { ...emptyLeather(), ...leather } });
const centroid = (ring) => ring.slice(0, -1).reduce((c, p, _, a) => ({ x: c.x + p.x / a.length, y: c.y + p.y / a.length }), { x: 0, y: 0 });
const close = (a, b, eps) => Math.abs(a - b) <= eps;

test("exported SVG re-parsed independently matches the design within 0.01 mm", () => {
  const tpl = airtagCase(makeId, "L");
  const prj = project(tpl.items, { parts: tpl.parts, joints: tpl.joints });
  const derived = deriveProject(prj);
  const svg = exportLeatherSVG(prj, derived);
  const root = parseXML(svg);
  assert.match(svg, /width="300mm" height="200mm"/);
  const shapes = svgShapes(root).shapes;
  const byLayer = (name) => shapes.filter((s) => s.layer === name);
  const cut = byLayer("CUT"), punch = byLayer("PUNCH");
  const groups = operationGeometry(prj, derived);
  assert.equal(cut.length, groups.CUT.length, "every CUT ring comes back");
  assert.equal(punch.length, groups.PUNCH.length, "every hole comes back");
  // Part outlines: the back piece is a 42 × 60 mm rounded rectangle.
  const sizes = cut.map((s) => bounds(pathContours(s.path))).map((b) => [Number(b.w.toFixed(2)), Number(b.h.toFixed(2))]);
  assert.ok(sizes.some(([w, h]) => close(w, 42, 0.01) && close(h, 60, 0.01)), JSON.stringify(sizes));
  assert.ok(sizes.some(([w, h]) => close(w, 24, 0.02) && close(h, 24, 0.02)), "window Ø24 present");
  // Hole centres: each re-parsed PUNCH shape has a derived hole within 0.01 mm.
  const holes = derived.parts.flatMap((d) => d.stitch.flatMap((s) => s.holes)).map((h) => ({ x: h.x, y: h.y }));
  const hardware = derived.parts.flatMap((d) => d.hardware.map((h) => h.center));
  const targets = [...holes, ...hardware];
  let worst = 0;
  for (const s of punch) {
    const c = centroid(pathContours(s.path)[0]);
    const d = Math.min(...targets.map((t) => Math.hypot(t.x - c.x, t.y - c.y)));
    worst = Math.max(worst, d);
  }
  assert.ok(worst < 0.01, `worst hole centre deviation ${worst} mm`);
  // Hole spacing measured on the re-parsed geometry equals the engine's report.
  const frontHoles = derived.parts[0].stitch[0].holes;
  const parsedCentres = punch.map((s) => centroid(pathContours(s.path)[0]));
  const near = (h) => parsedCentres.find((c) => Math.hypot(c.x - h.x, c.y - h.y) < 0.01);
  const chords = frontHoles.slice(1).map((h, i) => Math.hypot(near(h).x - near(frontHoles[i]).x, near(h).y - near(frontHoles[i]).y));
  const mean = chords.reduce((a, b) => a + b, 0) / chords.length;
  assert.ok(close(mean, derived.parts[0].stitch[0].result.pitch.mean, 0.01), `${mean} vs ${derived.parts[0].stitch[0].result.pitch.mean}`);
  assert.ok(Math.max(...chords) - Math.min(...chords) < 0.02, "chords uniform");
});

test("round holes export at the requested diameter and kerf shrinks them", () => {
  const item = { id: "r", type: "rect", name: "r", x: 10, y: 10, w: 60, h: 40, radius: 0, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("rect", 60, 40) };
  const part = makePart("p", "r", { stitchLines: [makeStitchLine("s", { offset: 3, pattern: { shape: "round", width: 1.2, pitch: 4 } })] });
  const prj = project([item], { parts: [part], kerf: 0 });
  const derived = deriveProject(prj);
  for (const kerf of [0, 0.2]) {
    const shapes = svgShapes(parseXML(exportLeatherSVG(prj, derived, { kerf }))).shapes;
    const holes = shapes.filter((s) => s.layer === "PUNCH").map((s) => bounds(pathContours(s.path)));
    for (const b of holes) assert.ok(close(b.w, 1.2 - kerf, 0.01) && close(b.h, 1.2 - kerf, 0.01), `kerf ${kerf}: ${b.w} × ${b.h}`);
    const cut = bounds(pathContours(shapes.find((s) => s.layer === "CUT").path));
    assert.ok(close(cut.w, 60 + kerf, 0.01) && close(cut.h, 40 + kerf, 0.01), `kerf ${kerf}: cut ${cut.w} × ${cut.h}`);
  }
});
