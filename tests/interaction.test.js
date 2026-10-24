import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import {
  selectionRect,
  marqueeIds,
  intersectsSelection,
  layerMovePlan,
  wheelZoom,
} from "../src/interaction.js";
import { ensureLayers } from "../src/layers.js";
import {
  shapeContours,
  stencilContours,
  automaticBridges,
  cutGeometry,
  flatten,
  contourTree,
  islandBridgeStatus,
  cutContour,
  exportSVG,
} from "../src/geometry.js";
import { followBridges } from "../src/operations.js";
const rect = (id, x = 0, y = 0, w = 20, h = 20) => ({
  id,
  type: "rect",
  x,
  y,
  w,
  h,
  rotation: 0,
  layerId: "layer-default",
  contours: shapeContours("rect", w, h),
});
test("rectangle selection is direction-independent, additive, and skips locked/hidden items", () => {
  const project = ensureLayers({
    items: [rect("a"), rect("b", 30), rect("c", 70)],
  });
  assert.deepEqual(selectionRect({ x: 45, y: 25 }, { x: -5, y: -5 }), {
    x: -5,
    y: -5,
    w: 50,
    h: 30,
  });
  assert.deepEqual(marqueeIds(project, { x: 45, y: 25 }, { x: -5, y: -5 }), [
    "a",
    "b",
  ]);
  assert.deepEqual(
    marqueeIds(project, { x: 45, y: 25 }, { x: 29, y: -5 }, ["a"]),
    ["a", "b"],
  );
  project.layers.push({
    id: "locked",
    name: "locked",
    visible: true,
    locked: true,
  });
  project.items[1].layerId = "locked";
  assert.deepEqual(marqueeIds(project, { x: 45, y: 25 }, { x: -5, y: -5 }), [
    "a",
  ]);
  project.layers[0].visible = false;
  assert.deepEqual(
    marqueeIds(project, { x: 100, y: 100 }, { x: -5, y: -5 }),
    [],
  );
});
test("selection tests actual contours including holes, line crossings, and rotated bridges", () => {
  const donut = {
    ...rect("d"),
    type: "outline",
    contours: [
      ...shapeContours("rect", 20, 20),
      ...shapeContours("rect", 10, 10).map((c) =>
        c.map((p) => ({ x: p.x + 5, y: p.y + 5 })).reverse(),
      ),
    ],
  };
  assert.equal(intersectsSelection(donut, { x: 8, y: 8, w: 2, h: 2 }), false);
  assert.equal(intersectsSelection(donut, { x: 1, y: 1, w: 2, h: 2 }), true);
  assert.equal(
    intersectsSelection(
      {
        ...rect("line"),
        type: "line",
        contours: shapeContours("line", 100, 100),
      },
      { x: 40, y: 40, w: 5, h: 5 },
    ),
    true,
  );
  assert.equal(
    intersectsSelection(
      { id: "bridge", type: "bridge", x: 10, y: 10, w: 20, h: 2, rotation: 45 },
      { x: 15, y: 15, w: 2, h: 2 },
    ),
    true,
  );
});
test("layer drop plans move scoped tabs, reject locked targets and orphaned tab drags", () => {
  const project = ensureLayers({
    items: [rect("a"), { ...automaticBridges([rect("a")])[0], id: "tab" }],
  });
  project.layers.push({
    id: "target",
    name: "target",
    visible: true,
    locked: false,
  });
  assert.deepEqual(
    layerMovePlan(project, ["a"], "target").map((i) => i.id),
    ["a", "tab"],
  );
  assert.throws(() => layerMovePlan(project, ["tab"], "target"));
  project.layers[1].locked = true;
  assert.throws(() => layerMovePlan(project, ["a"], "target"));
  project.layers[1].locked = false;
  project.layers[0].visible = false;
  assert.throws(() => layerMovePlan(project, ["a"], "target"));
});
test("wheel and trackpad zoom direction, units and bounds", () => {
  assert.ok(wheelZoom(1, -100) > 1);
  assert.ok(wheelZoom(1, 100) < 1);
  assert.ok(wheelZoom(1, -100, 0, true) > wheelZoom(1, -100));
  assert.equal(wheelZoom(20, -1000), 20);
  assert.ok(wheelZoom(8, -1000) > 8);
  assert.equal(wheelZoom(0.25, 1000), 0.25);
  assert.equal(wheelZoom(1, 2, 1), wheelZoom(1, 32, 0));
});
test("old independent tabs do not count as a single bridge across a ring", () => {
  const donut = {
    ...rect("d", 0, 0, 30, 30),
    type: "outline",
    contours: [
      ...shapeContours("rect", 30, 30),
      ...shapeContours("rect", 10, 10).map((c) =>
        c.map((p) => ({ x: p.x + 10, y: p.y + 10 })).reverse(),
      ),
    ],
  };
  const old = [
    {
      id: "t1",
      type: "bridge",
      x: 15,
      y: 0,
      w: 1.5,
      h: 1.5,
      rotation: 0,
      targetId: "d",
    },
    {
      id: "t2",
      type: "bridge",
      x: 15,
      y: 10,
      w: 1.5,
      h: 1.5,
      rotation: 0,
      targetId: "d",
    },
  ];
  assert.equal(cutGeometry([donut, ...old]).untouched, 0);
  assert.equal(islandBridgeStatus([donut, ...old]).unbridgedIslands, 1);
  const added = automaticBridges([donut, ...old], 1.5, ["d"]);
  assert.equal(added.length, 2);
  assert.equal(added[0].bridgeMode, "stencil");
  assert.equal(
    islandBridgeStatus([donut, ...old, ...added]).unbridgedIslands,
    0,
  );
  assert.equal(automaticBridges([donut, ...old, ...added]).length, 0);
});
for (const file of [
  "ZenKakuGothicNew-Regular.ttf",
  "ShipporiMincho-Regular.ttf",
])
  test(`${file}: よ inner island and outer boundary share the SAME bridge`, () => {
    const raw = fs.readFileSync(
      new URL(`../public/fonts/${file}`, import.meta.url),
    );
    const font = opentype.parse(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    );
    for (const rotation of [0, 37]) {
      const item = {
        id: "yo",
        type: "outline",
        x: 20,
        y: 20,
        rotation,
        contours: flatten(font.getPath("よ", 0, 50, 50).commands),
      };
      const tree = contourTree(item);
      assert.ok(tree.some((n) => n.parent >= 0));
      const bridges = automaticBridges([item], 1.5, ["yo"]);
      assert.ok(bridges.some((b) => b.bridgeMode === "stencil" && b.w > b.h));
      for (const n of tree.filter((n) => n.parent >= 0))
        assert.ok(
          bridges.some((b) =>
            [n.points, tree[n.parent].points].every((c) => {
              const runs = cutContour(c, [b]);
              return (
                runs.length !== 1 ||
                JSON.stringify(runs[0][0]) !== JSON.stringify(runs[0].at(-1))
              );
            }),
          ),
        );
      assert.equal(cutGeometry([item, ...bridges]).unbridgedIslands, 0);
      assert.equal(cutGeometry([item, ...bridges]).vanished, 0);
      const svg = exportSVG({
        width: 120,
        height: 120,
        items: [item, ...bridges],
      });
      assert.doesNotMatch(svg, /<rect|<mask/);
      assert.match(svg, / Z/);
      const output = stencilContours(item, bridges);
      assert.ok(output.length >= 2);
      assert.ok(
        output.every((c) => JSON.stringify(c[0]) === JSON.stringify(c.at(-1))),
      );
      assert.equal(
        contourTree({ x: 0, y: 0, rotation: 0, contours: output }).filter(
          (n) => n.parent >= 0,
        ).length,
        0,
      );
      assert.equal(automaticBridges([item, ...bridges]).length, 0);
      const resized = structuredClone(item);
      resized.contours = resized.contours.map((c) =>
        c.map((p) => ({ x: p.x * 2, y: p.y * 2 })),
      );
      resized.rotation += 23;
      followBridges(bridges, item, resized);
      assert.equal(cutGeometry([resized, ...bridges]).unbridgedIslands, 0);
      assert.ok(bridges.every((b) => b.h === 1.5));
    }
  });
test("multiple nested loops connect to direct parents without affecting other items", () => {
  const item = {
    ...rect("a"),
    type: "outline",
    contours: [
      ...shapeContours("rect", 60, 40),
      ...shapeContours("rect", 10, 10).map((c) =>
        c.map((p) => ({ x: p.x + 5, y: p.y + 5 })).reverse(),
      ),
      ...shapeContours("rect", 10, 10).map((c) =>
        c.map((p) => ({ x: p.x + 40, y: p.y + 20 })).reverse(),
      ),
    ],
  };
  const other = { ...item, id: "b" },
    tabs = automaticBridges([item, other], 1.5, ["a"]);
  assert.equal(tabs.length, 4);
  assert.equal(islandBridgeStatus([item, ...tabs]).unbridgedIslands, 0);
  assert.equal(islandBridgeStatus([other, ...tabs]).unbridgedIslands, 2);
});

for (const file of [
  "ZenKakuGothicNew-Regular.ttf",
  "ShipporiMincho-Regular.ttf",
]) {
  test(`${file}: stencil subtraction opens counters in Japanese and Latin glyphs`, () => {
    const raw = fs.readFileSync(
      new URL(`../public/fonts/${file}`, import.meta.url),
    );
    const font = opentype.parse(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    );
    for (const text of [
      "よ",
      "日",
      "目",
      "田",
      "回",
      "品",
      "国",
      "あ",
      "ぬ",
      "の",
      "ABOPQR0689",
    ]) {
      const item = {
        id: "glyph",
        type: "text",
        x: 0,
        y: 0,
        rotation: 0,
        contours: flatten(font.getPath(text, 0, 50, 50).commands),
      };
      const tabs = automaticBridges([item]);
      const output = stencilContours(item, tabs);
      assert.equal(
        contourTree({ ...item, contours: output }).filter((n) => n.parent >= 0)
          .length,
        0,
        text,
      );
      assert.ok(
        output.every((c) => JSON.stringify(c[0]) === JSON.stringify(c.at(-1))),
        text,
      );
      assert.ok(output.length > 0, text);
    }
  });
}
