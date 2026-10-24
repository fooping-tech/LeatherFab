import { test } from "node:test";
import assert from "node:assert/strict";
import {
  presetEnvelope,
  flatEnvelope,
  warpContours,
  shapeSource,
  applyWarp,
  WARPABLE,
} from "../src/warp.js";
import {
  shapeContours,
  bounds,
  transform,
  automaticBridges,
  cutGeometry,
  exportSVG,
} from "../src/geometry.js";
import {
  resizeFromHandle,
  itemBounds,
  canResize,
  booleanContours,
} from "../src/operations.js";
import { splitParts } from "../src/grouping.js";
import { validateProject } from "../src/project.js";
import { ensureLayers } from "../src/layers.js";
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const warp = (preset, bend = 0.5, extra = {}) => ({
  preset,
  bend,
  envelope: presetEnvelope(preset, bend, 2),
  ...extra,
});
const shape = (type, extra = {}) => {
  const item = {
    id: type,
    type,
    name: type,
    x: 20,
    y: 30,
    rotation: 25,
    w: 40,
    h: 20,
    layerId: "layer-default",
    ...extra,
  };
  item.contours = applyWarp(item, shapeSource(item));
  return item;
};
const donut = [
  ...shapeContours("rect", 30, 20),
  ...shapeContours("rect", 10, 6).map((c) =>
    c.map((p) => ({ x: p.x + 10, y: p.y + 7 })).reverse(),
  ),
];
const path = (extra = {}) => {
  const item = {
    id: "path",
    type: "outline",
    name: "path",
    x: 10,
    y: 10,
    rotation: -15,
    layerId: "layer-default",
    contours: donut,
    ...extra,
  };
  if (item.warp)
    item.contours = applyWarp(item, item.warp.source ?? item.contours);
  return item;
};
test("rectangles, ellipses and fixed paths are warpable; lines and bridges are not", () => {
  assert.deepEqual(WARPABLE, ["text", "rect", "circle", "outline"]);
  const rect = shape("rect", { radius: 4 });
  assert.deepEqual(shapeSource(rect), shapeContours("rect", 40, 20, 4));
  assert.deepEqual(rect.contours, shapeContours("rect", 40, 20, 4));
  const warped = shape("rect", { radius: 4, warp: warp("bulge") });
  assert.deepEqual(
    warped.contours,
    warpContours(
      shapeContours("rect", 40, 20, 4),
      { x: 0, y: 0, w: 40, h: 20 },
      warped.warp.envelope,
    ),
  );
  const b = itemBounds(warped);
  near(b.y, -10, 0.05);
  near(b.h, 40, 0.05);
  const circle = shape("circle", { warp: warp("arcUp") });
  near(bounds(circle.contours).y, -10, 0.05);
  const p = path({ warp: warp("flag", 0.5, { source: donut }) });
  assert.deepEqual(shapeSource(p), donut);
  assert.equal(p.contours.length, 2);
});
test("dimension and fillet edits rebuild the same warp from the new shape", () => {
  const item = shape("rect", { warp: warp("arch") });
  const wider = { ...item, w: 80, radius: 5 };
  wider.contours = applyWarp(wider, shapeSource(wider));
  assert.deepEqual(
    wider.contours,
    warpContours(
      shapeContours("rect", 80, 20, 5),
      { x: 0, y: 0, w: 80, h: 20 },
      item.warp.envelope,
    ),
  );
  near(bounds(wider.contours).w, 80, 0.05);
});
for (const make of [
  () => shape("rect", { radius: 3, warp: warp("wave") }),
  () => shape("circle", { warp: warp("perspective") }),
  () => path({ warp: warp("fish", 0.6, { source: donut }) }),
])
  test(`corner resize of a warped ${make().type} scales the warped outline with the corner fixed`, () => {
    const item = make();
    assert.ok(canResize(item));
    const b = itemBounds(item),
      anchor = transform({ x: b.x, y: b.y }, item),
      target = transform({ x: b.x + b.w * 1.5, y: b.y + b.h * 2 }, item),
      next = resizeFromHandle(item, [1, 1], target, false);
    assert.deepEqual(next.warp.envelope, item.warp.envelope);
    const nb = itemBounds(next),
      fixed = transform({ x: nb.x, y: nb.y }, next);
    near(fixed.x, anchor.x, 0.05);
    near(fixed.y, anchor.y, 0.05);
    near(nb.w, b.w * 1.5, 0.05);
    near(nb.h, b.h * 2, 0.05);
    if (item.type === "outline") {
      near(bounds(next.warp.source).w, bounds(donut).w * 1.5);
      assert.deepEqual(next.contours, applyWarp(next, next.warp.source));
    } else {
      near(next.w, item.w * 1.5);
      near(next.h, item.h * 2);
    }
    const locked = resizeFromHandle(item, [1, 1], target, true),
      lb = itemBounds(locked);
    near(lb.w / lb.h, b.w / b.h, 1e-3);
  });
test("warped shapes export, combine, bridge and split as plain paths", () => {
  const rect = shape("rect", { warp: warp("bulge") }),
    ring = path({
      id: "ring",
      x: 120,
      warp: warp("arcUp", 0.5, { source: donut }),
    });
  const project = ensureLayers({
    version: 2,
    width: 240,
    height: 160,
    items: [rect, ring],
  });
  const svg = exportSVG(project);
  assert.match(svg, /<path d="M/);
  assert.doesNotMatch(svg, /transform=|<rect|<ellipse|style=/);
  const tabs = automaticBridges([rect, ring], 1.5).map((t, i) => ({
    ...t,
    id: `t${i}`,
  }));
  const cut = cutGeometry([rect, ring, ...tabs]);
  assert.equal(cut.untouched, 0);
  assert.equal(cut.unbridgedIslands, 0);
  assert.equal(booleanContours([rect, shape("circle")], "union").length, 1);
  const parts = splitParts(ring);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].warp, undefined);
  assert.equal(parts[0].contours.length, 2);
  const saved = validateProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(saved.items[1].warp.source, donut);
  assert.deepEqual(saved.items[0].warp, rect.warp);
});
test("saved warps: fixed paths need their source, other shapes must not carry one", () => {
  const base = ensureLayers({ width: 100, height: 100, items: [] }),
    save = (item) => validateProject({ ...base, items: [item] });
  assert.ok(save(path({ warp: warp("arch", 0.5, { source: donut }) })));
  assert.ok(save(shape("rect", { warp: warp("arch") })));
  assert.throws(() => save(path({ warp: warp("arch") })));
  assert.throws(() =>
    save(shape("rect", { warp: warp("arch", 0.5, { source: donut }) })),
  );
  assert.throws(() =>
    save(
      path({
        warp: warp("arch", 0.5, {
          source: [
            [
              { x: 0, y: NaN },
              { x: 1, y: 1 },
            ],
          ],
        }),
      }),
    ),
  );
  const line = {
    id: "l",
    type: "line",
    name: "l",
    x: 0,
    y: 0,
    rotation: 0,
    w: 10,
    h: 0,
    layerId: "layer-default",
    contours: shapeContours("line", 10, 0),
    warp: { preset: "none", bend: 0.5, envelope: flatEnvelope() },
  };
  assert.throws(() => save(line));
});
