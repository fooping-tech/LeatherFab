import { test } from "node:test";
import assert from "node:assert/strict";
import { transform, shapeContours } from "../src/geometry.js";
import { makePart, makeStitchLine, emptyLeather, rebaseItemFrames, remapItems } from "../src/leather/model.js";
import { relativePlacement, composePlacement, deriveProject } from "../src/leather/derive.js";
import { booleanContours } from "../src/operations.js";

const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;
const rect = (id, x, y, w, h, rotation = 0) => ({ id, type: "rect", name: id, x, y, w, h, radius: 0, rotation, layerId: "L", ratioLocked: false, contours: shapeContours("rect", w, h) });

test("boolean result at the origin: hardware and projections stay where they were on the board", () => {
  const old = rect("a", 50, 40, 60, 40, 15);
  const hole = { id: "c", type: "circle", name: "c", x: 60, y: 50, w: 10, h: 10, rotation: 0, layerId: "L", contours: shapeContours("circle", 10, 10) };
  const contours = booleanContours([old, hole], "difference");
  const result = { id: "r", type: "outline", name: "抜き", x: 0, y: 0, rotation: 0, layerId: "L", ratioLocked: false, contours };
  const part = makePart("p", "a", { hardware: [{ id: "h", presetId: "rivet-m", x: 10, y: 8, rotation: 30 }] });
  // A projected line on this part from a top part placed at a known spot.
  const top = rect("t", 70, 45, 20, 20);
  const bottomLine = makeStitchLine("pl", { source: { kind: "projected", partId: "tp", lineId: "tl", placement: relativePlacement(old, top) }, offset: 0 });
  part.stitchLines.push(bottomLine);
  const leather = { ...emptyLeather(), parts: [part, makePart("tp", "t", { stitchLines: [makeStitchLine("tl", { offset: 3, pattern: { pitch: 4 } })] })] };
  const worldBefore = transform({ x: 10, y: 8 }, old);
  const topBefore = composePlacement(old, bottomLine.source.placement);
  rebaseItemFrames(leather, old, result, { transform, relativePlacement, composePlacement });
  remapItems(leather, { replaced: { a: "r" } });
  const h = leather.parts[0].hardware[0];
  const worldAfter = transform({ x: h.x, y: h.y }, result);
  assert.ok(close(worldAfter.x, worldBefore.x) && close(worldAfter.y, worldBefore.y), `hardware moved: ${JSON.stringify([worldBefore, worldAfter])}`);
  assert.ok(close(h.rotation, 45), `rotation ${h.rotation} keeps the world angle (30 + 15)`);
  const topAfter = composePlacement(result, leather.parts[0].stitchLines[0].source.placement);
  assert.ok(close(topAfter.x, topBefore.x) && close(topAfter.y, topBefore.y) && close(topAfter.rotation, topBefore.rotation));
  // The derived punch geometry of the hardware is the same before and after.
  const prj = (item, lea) => ({ version: 2, width: 300, height: 200, layers: [{ id: "L", name: "L", visible: true, locked: false }], items: [item, top], leather: lea });
  const before = deriveProject(prj(old, { ...emptyLeather(), parts: [makePart("p", "a", { hardware: [{ id: "h", presetId: "rivet-m", x: 10, y: 8, rotation: 30 }] })] })).parts[0].hardware[0].center;
  const after = deriveProject(prj(result, leather)).parts[0].hardware[0].center;
  assert.ok(close(before.x, after.x) && close(before.y, after.y));
});
