import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import {
  clipSegment,
  cutContour,
  shapeContours,
  flatten,
  exportSVG,
  automaticBridges,
  bridgeSize,
  AUTO_BRIDGE_DEFAULTS,
  cutGeometry,
  transform,
} from "../src/geometry.js";
import { validateProject } from "../src/project.js";
const p = (x, y) => ({ x, y });
const bridge = { type: "bridge", id: "b", x: 5, y: 0, w: 2, h: 2, rotation: 0 };
const square = {
  id: "s",
  type: "rect",
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  rotation: 0,
  contours: shapeContours("rect", 10, 10),
};
test("bridge removes actual line section and preserves both outside parts", () => {
  assert.deepEqual(clipSegment(p(0, 0), p(10, 0), bridge), [
    [p(0, 0), p(4, 0)],
    [p(6, 0), p(10, 0)],
  ]);
});
test("bridge containing segment removes whole segment; nonintersecting stays", () => {
  assert.deepEqual(clipSegment(p(4.5, 0), p(5.5, 0), bridge), []);
  assert.deepEqual(clipSegment(p(0, 3), p(10, 3), bridge), [
    [p(0, 3), p(10, 3)],
  ]);
});
test("rotated bridge clips in its own coordinates", () => {
  const b = { ...bridge, rotation: 90, w: 2, h: 4 };
  const parts = clipSegment(p(0, 0), p(10, 0), b);
  assert.ok(Math.abs(parts[0][1].x - 3) < 1e-8);
  assert.ok(Math.abs(parts[1][0].x - 7) < 1e-8);
});
test("multiple bridge gaps remain open across contour wraparound", () => {
  const runs = cutContour(square.contours[0], [
    bridge,
    { ...bridge, x: 5, y: 10 },
  ]);
  assert.equal(runs.length, 2);
  for (const r of runs) assert.notDeepEqual(r[0], r.at(-1));
});
test("auto holding tabs cover every closed contour and are idempotent", () => {
  const items = [square, { ...square, id: "s2", x: 20, rotation: 25 }];
  const added = automaticBridges(items);
  assert.equal(added.length, 2);
  assert.equal(cutGeometry([...items, ...added]).untouched, 0);
  assert.equal(automaticBridges([...items, ...added]).length, 0);
});
test("Japanese glyphs in both bundled fonts produce outlines and export without text/masks/bridges", () => {
  for (const file of [
    "ZenKakuGothicNew-Regular.ttf",
    "ShipporiMincho-Regular.ttf",
  ]) {
    const bytes = fs.readFileSync(
      new URL(`../public/fonts/${file}`, import.meta.url),
    );
    const font = opentype.parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    for (const c of "日本語田口自由") assert.ok(font.hasChar(c), c);
    const contours = flatten(font.getPath("日本語田口", 0, 25, 20).commands);
    assert.ok(contours.length > 10);
    const item = {
      id: "jp",
      type: "outline",
      x: 10,
      y: 10,
      rotation: 0,
      contours,
    };
    const items = [item, ...automaticBridges([item])];
    assert.equal(cutGeometry(items).untouched, 0);
    const svg = exportSVG({ width: 240, height: 160, items });
    assert.match(svg, /width="240mm"/);
    assert.match(svg, /<path d="M/);
    assert.doesNotMatch(svg, /<text|<mask|<clipPath|<rect|NaN|Infinity/);
  }
});
test("curve subdivision preserves endpoints and closed contours", () => {
  const paths = flatten([
    { type: "M", x: 0, y: 0 },
    { type: "C", x1: 0, y1: 10, x2: 10, y2: 10, x: 10, y: 0 },
    { type: "Z" },
  ]);
  assert.ok(paths[0].length > 15);
  assert.deepEqual(paths[0][0], paths[0].at(-1));
});
test("project import rejects malformed, nonfinite, duplicate and excessive data", () => {
  const valid = { version: 1, width: 240, height: 160, items: [square] };
  assert.equal(validateProject(valid).items.length, 1);
  assert.throws(() => validateProject({ ...valid, width: 0 }));
  assert.throws(() => validateProject({ ...valid, items: [square, square] }));
  assert.throws(() =>
    validateProject({ ...valid, items: [{ ...square, x: Infinity }] }),
  );
});
test("empty export fails, line-only export has no fabricated closing cut", () => {
  assert.throws(() => exportSVG({ width: 100, height: 100, items: [] }));
  const svg = exportSVG({
    width: 100,
    height: 100,
    items: [
      { ...square, type: "line", contours: shapeContours("line", 10, 0) },
    ],
  });
  assert.doesNotMatch(svg, / Z/);
});
test("oversized bridges report completely erased contours", () => {
  const r = cutGeometry([square, { ...bridge, x: 5, y: 5, w: 30, h: 30 }]);
  assert.equal(r.vanished, 1);
  assert.equal(r.paths.length, 0);
});
test("import rejects attribute injection in object identifiers", () => {
  assert.throws(() =>
    validateProject({
      version: 1,
      width: 100,
      height: 100,
      items: [{ ...square, id: 'x" onload="alert(1)' }],
    }),
  );
});

test("bridgeSize accepts a number or {width,height}, clamps and falls back to the defaults", () => {
  assert.deepEqual(bridgeSize(1.5), { width: 1.5, height: 1.5 });
  assert.deepEqual(bridgeSize({ width: 2, height: 3 }), { width: 2, height: 3 });
  assert.deepEqual(bridgeSize({ width: "abc", height: -1 }), { ...AUTO_BRIDGE_DEFAULTS });
  assert.deepEqual(bridgeSize(undefined), { ...AUTO_BRIDGE_DEFAULTS });
  assert.deepEqual(bridgeSize({ width: 0.01, height: 999 }), { width: 0.2, height: 50 });
});
test("automatic bridge width and height: stencil strip thickness and overlap, holding tab along the longest edge", () => {
  // Ring: 20 × 20 outer contour with a 6 × 6 hole.
  const ring = {
    id: "ring",
    type: "outline",
    x: 0,
    y: 0,
    rotation: 0,
    // shapeContours() starts at the origin, so centre the hole inside the outer square.
    contours: [shapeContours("rect", 20, 20)[0], shapeContours("rect", 6, 6)[0].map((q) => ({ x: q.x + 7, y: q.y + 7 }))],
  };
  const legacy = automaticBridges([ring], 1.5);
  const sized = automaticBridges([ring], { width: 2, height: 3 });
  assert.equal(legacy.length, 2);
  assert.equal(sized.length, 2);
  for (const b of legacy) {
    assert.equal(b.bridgeMode, "stencil");
    assert.equal(b.h, 1.5, "strip thickness = width");
    assert.ok(Math.abs(b.w - (7 + 1.5)) < 1e-6, "span = hole-to-outer distance + overlap");
  }
  for (const b of sized) {
    assert.equal(b.h, 2, "strip thickness = width");
    assert.ok(Math.abs(b.w - (7 + 3)) < 1e-6, "span = distance + height");
  }
  assert.deepEqual(automaticBridges([ring]), legacy, "default equals the previous 1.5 mm behaviour");
  assert.equal(cutGeometry([ring, ...sized]).unbridgedIslands, 0);
  // Holding tab on a hole-less rectangle: width along the edge, height across it.
  const wide = { ...square, id: "wide", w: 30, h: 10, contours: shapeContours("rect", 30, 10) };
  const [tab] = automaticBridges([wide], { width: 3, height: 1 });
  assert.equal(tab.bridgeMode, "holding");
  assert.equal(tab.w, 3);
  assert.equal(tab.h, 1);
  assert.equal(Math.abs(tab.rotation) % 180, 0, "aligned with the long horizontal edge");
  const runs = cutContour(wide.contours[0], [tab]);
  const length = runs.reduce((sum, r) => sum + r.slice(1).reduce((acc, q, i) => acc + Math.hypot(q.x - r[i].x, q.y - r[i].y), 0), 0);
  assert.ok(Math.abs(length - (80 - 3)) < 1e-6, "the gap in the cut line equals the width");
  const [rotatedTab] = automaticBridges([{ ...wide, id: "r", rotation: 30, contours: wide.contours }], { width: 3, height: 1 });
  assert.ok(Math.abs(((rotatedTab.rotation % 180) + 180) % 180 - 30) < 1e-6, "tab follows the rotated edge");
  assert.equal(cutGeometry([wide, tab]).untouched, 0);
});
