import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shapeContours,
  TOLERANCE,
  automaticBridges,
  cutGeometry,
} from "../src/geometry.js";
import { resizeFromHandle, booleanContours } from "../src/operations.js";
import { ensureLayers } from "../src/layers.js";
import { validateProject } from "../src/project.js";
import { browserOrder, rangeIds, marqueeIds } from "../src/interaction.js";
import {
  groupItems,
  ungroupItems,
  expandGroups,
  normalizeGroups,
} from "../src/grouping.js";
import { arrangeItems, cloneItems } from "../src/edit.js";
const rect = (id, x = 0, y = 0, w = 10, h = 10, extra = {}) => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  w,
  h,
  rotation: 0,
  layerId: "layer-default",
  contours: shapeContours("rect", w, h, extra.radius),
  ...extra,
});
const area = (c) =>
  Math.abs(c.slice(1).reduce((n, p, i) => n + c[i].x * p.y - p.x * c[i].y, 0)) /
  2;
const two = () => {
  const project = ensureLayers({
    items: [rect("a"), rect("b", 20), rect("c", 40)],
  });
  project.layers.push({ id: "top", name: "上", visible: true, locked: false });
  project.items.push(
    { ...rect("d", 60), layerId: "top" },
    { ...rect("e", 80), layerId: "top" },
  );
  return project;
};
test("rounded rectangle arcs stay within tolerance and keep the requested size", () => {
  for (const [w, h, r] of [
    [40, 20, 5],
    [30, 30, 15],
    [10, 4, 50],
    [8, 6, 0.01],
  ]) {
    const [c] = shapeContours("rect", w, h, r),
      radius = Math.min(r, w / 2, h / 2);
    assert.deepEqual(c[0], c.at(-1));
    for (let i = 1; i < c.length; i++)
      assert.ok(Math.hypot(c[i].x - c[i - 1].x, c[i].y - c[i - 1].y) > 1e-7);
    const xs = c.map((p) => p.x),
      ys = c.map((p) => p.y);
    assert.ok(
      Math.abs(Math.min(...xs)) < 1e-9 && Math.abs(Math.max(...xs) - w) < 1e-9,
    );
    assert.ok(
      Math.abs(Math.min(...ys)) < 1e-9 && Math.abs(Math.max(...ys) - h) < 1e-9,
    );
    // Every chord midpoint is within the flattening tolerance of its arc.
    const centres = [
      [w - radius, radius],
      [w - radius, h - radius],
      [radius, h - radius],
      [radius, radius],
    ];
    for (let i = 1; i < c.length; i++) {
      const m = { x: (c[i].x + c[i - 1].x) / 2, y: (c[i].y + c[i - 1].y) / 2 },
        gap = Math.min(
          ...centres.map(([x, y]) =>
            Math.abs(Math.hypot(m.x - x, m.y - y) - radius),
          ),
        ),
        straight =
          Math.abs(c[i].x - c[i - 1].x) < 1e-9 ||
          Math.abs(c[i].y - c[i - 1].y) < 1e-9;
      assert.ok(
        straight || gap <= TOLERANCE + 1e-9,
        `chord ${i} off by ${gap}`,
      );
    }
    const exact = w * h - (4 - Math.PI) * radius * radius;
    assert.ok(area(c) <= exact + 1e-9);
    assert.ok(exact - area(c) < 2 * Math.PI * radius * TOLERANCE);
  }
  assert.deepEqual(
    shapeContours("rect", 10, 5, 0),
    shapeContours("rect", 10, 5),
  );
});
test("filleted rectangles resize, cut, combine and save with their radius", () => {
  const a = rect("a", 10, 10, 40, 20, { radius: 6 });
  const bigger = resizeFromHandle(a, [1, 1], { x: 90, y: 50 }, false);
  assert.equal(bigger.radius, 6);
  assert.deepEqual(bigger.contours, shapeContours("rect", 80, 40, 6));
  const smaller = resizeFromHandle(a, [1, 1], { x: 18, y: 14 }, false);
  assert.equal(smaller.radius, 2);
  const tab = automaticBridges([a])[0];
  assert.equal(cutGeometry([a, { ...tab, id: "t" }]).untouched, 0);
  const union = booleanContours([a, rect("b", 40, 10, 20, 20)], "union");
  assert.equal(union.length, 1);
  const project = validateProject({
    version: 2,
    width: 100,
    height: 100,
    layers: [{ id: "layer-default", name: "1", visible: true, locked: false }],
    items: [a],
  });
  assert.equal(project.items[0].radius, 6);
  for (const radius of [-1, Infinity, 1001])
    assert.throws(() =>
      validateProject({ ...project, items: [{ ...a, radius }] }),
    );
  assert.throws(() =>
    validateProject({
      ...project,
      items: [{ ...a, type: "circle", radius: 2 }],
    }),
  );
});
test("browser shift range runs from the anchor across layers and skips locked rows", () => {
  const project = two();
  assert.deepEqual(
    browserOrder(project).map((i) => i.id),
    ["e", "d", "c", "b", "a"],
  );
  assert.deepEqual(rangeIds(project, "a", "d"), ["a", "b", "c", "d"]);
  assert.deepEqual(rangeIds(project, "d", "b"), ["d", "c", "b"]);
  assert.deepEqual(rangeIds(project, "missing", "b"), ["b"]);
  assert.deepEqual(rangeIds(project, "b", "b"), ["b"]);
  project.layers[1].locked = true;
  assert.deepEqual(rangeIds(project, "e", "b"), ["c", "b"]);
});
test("grouping stacks members together on one layer and flattens old groups", () => {
  const project = two();
  const tab = { ...automaticBridges([project.items[0]])[0], id: "tab" };
  project.items.push(tab);
  const ids = groupItems(project, ["a", "c", "e", "tab"], "g1", "top");
  assert.deepEqual(ids, ["a", "c", "e"]);
  assert.deepEqual(
    project.items.map((i) => i.id),
    ["b", "d", "a", "c", "e", "tab"],
  );
  for (const id of ["a", "c", "e", "tab"])
    assert.equal(project.items.find((i) => i.id === id).layerId, "top");
  assert.equal(project.items.find((i) => i.id === "tab").groupId, undefined);
  assert.deepEqual(expandGroups(project, ["c"]).sort(), ["a", "c", "e"]);
  assert.deepEqual(marqueeIds(project, { x: 41, y: 1 }, { x: 42, y: 2 }), [
    "c",
  ]);
  // Regrouping members of g1 with another item forms a single new group.
  groupItems(project, ["a", "b"], "g2", "layer-default");
  assert.deepEqual(
    project.items.filter((i) => i.groupId === "g2").map((i) => i.id),
    ["b", "a"],
  );
  assert.deepEqual(
    project.items.filter((i) => i.groupId === "g1").map((i) => i.id),
    ["c", "e"],
  );
  assert.throws(() => groupItems(project, ["a"], "g3", "top"));
  assert.deepEqual(ungroupItems(project, ["e"]).sort(), ["c", "e"]);
  assert.ok(project.items.every((i) => i.groupId !== "g1"));
  project.items = project.items.filter((i) => i.id !== "b");
  normalizeGroups(project);
  assert.ok(project.items.every((i) => !i.groupId));
});
test("arrange moves selections within their own layer and keeps bridges in place", () => {
  const items = [
    rect("a"),
    rect("b"),
    { ...rect("x"), layerId: "top" },
    rect("c"),
    {
      id: "tab",
      type: "bridge",
      layerId: "layer-default",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      rotation: 0,
    },
    rect("d"),
  ];
  const order = (mode, ids) => arrangeItems(items, ids, mode).map((i) => i.id);
  assert.deepEqual(order("front", ["a", "b"]), [
    "c",
    "d",
    "x",
    "a",
    "tab",
    "b",
  ]);
  assert.deepEqual(order("back", ["d"]), ["d", "a", "x", "b", "tab", "c"]);
  assert.deepEqual(order("forward", ["a", "b"]), [
    "c",
    "a",
    "x",
    "b",
    "tab",
    "d",
  ]);
  assert.deepEqual(order("backward", ["c", "d"]), [
    "a",
    "c",
    "x",
    "d",
    "tab",
    "b",
  ]);
  assert.deepEqual(
    order("forward", ["d"]),
    items.map((i) => i.id),
  );
  assert.throws(() => arrangeItems(items, ["a"], "sideways"));
});
test("copies get new ids, keep scoped bridges attached and form separate groups", () => {
  const a = { ...rect("a"), groupId: "g" },
    b = { ...rect("b", 20), groupId: "g" },
    tab = { ...automaticBridges([a])[0], id: "tab" };
  let n = 0;
  const { copies, ids } = cloneItems(
    [a, b, tab, rect("z")],
    ["a", "b"],
    () => `n${n++}`,
    5,
    "top",
  );
  assert.equal(copies.length, 3);
  assert.deepEqual(ids, [copies[0].id, copies[1].id]);
  assert.equal(copies[2].targetId, copies[0].id);
  assert.equal(copies[0].groupId, copies[1].groupId);
  assert.notEqual(copies[0].groupId, "g");
  assert.equal(copies[2].x, tab.x + 5);
  assert.ok(copies.every((c) => c.layerId === "top"));
  assert.equal(a.x, 0);
});
test("group ids are validated in saved projects", () => {
  const project = ensureLayers({ width: 100, height: 100, items: [rect("a")] });
  assert.equal(
    validateProject({ ...project, items: [{ ...rect("a"), groupId: "g-1" }] })
      .items[0].groupId,
    "g-1",
  );
  for (const groupId of ["", "bad id", 5])
    assert.throws(() =>
      validateProject({ ...project, items: [{ ...rect("a"), groupId }] }),
    );
});
test("rotating about a point turns the whole outline rigidly", async () => {
  const { rotateAbout, selectionCenter, normalizeAngle } =
    await import("../src/edit.js");
  const { worldContours } = await import("../src/geometry.js");
  const { itemBounds, followBridges } = await import("../src/operations.js");
  const a = { ...rect("a", 10, 20, 40, 10), rotation: 30 };
  const c = selectionCenter([a], itemBounds);
  const turned = rotateAbout(a, c, 75),
    r = (75 * Math.PI) / 180;
  worldContours(turned)[0].forEach((p, i) => {
    const q = worldContours(a)[0][i],
      dx = q.x - c.x,
      dy = q.y - c.y;
    assert.ok(
      Math.abs(p.x - (c.x + dx * Math.cos(r) - dy * Math.sin(r))) < 1e-9,
    );
    assert.ok(
      Math.abs(p.y - (c.y + dx * Math.sin(r) + dy * Math.cos(r))) < 1e-9,
    );
  });
  // A single item keeps its own centre; the angle wraps into ±180°.
  const again = selectionCenter([turned], itemBounds);
  assert.ok(Math.abs(again.x - c.x) < 1e-9 && Math.abs(again.y - c.y) < 1e-9);
  assert.equal(rotateAbout(a, c, 170).rotation, -160);
  assert.equal(normalizeAngle(540), 180);
  assert.equal(normalizeAngle(-180), 180);
  assert.equal(normalizeAngle(-190), 170);
  // Several items share the centre of their combined box.
  const b = rect("b", 60, 20, 10, 10);
  const shared = selectionCenter([rect("l", 0, 0, 10, 10), b], itemBounds);
  assert.deepEqual(shared, { x: 35, y: 15 });
  // Scoped bridges follow a rotating owner.
  const tab = { ...automaticBridges([a])[0], id: "tab" },
    start = worldContours(a)[0].map((p) => ({ ...p }));
  followBridges([tab], a, turned);
  const dx = tab.x - c.x,
    dy = tab.y - c.y;
  assert.ok(cutGeometry([turned, tab]).untouched === 0);
  assert.ok(Math.hypot(dx, dy) > 0 && start.length === 5);
});
