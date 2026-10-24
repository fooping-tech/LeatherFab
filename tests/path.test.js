import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import {
  parsePathData,
  toPathData,
  pathContours,
  pathFromCommands,
  pathFromContours,
  shapePath,
  nodeKeys,
  nodeAt,
  moveNodes,
  moveHandle,
  setNodeType,
  insertNode,
  deleteNodes,
  nearestSegment,
  visibleHandles,
  segmentCurve,
} from "../src/path.js";
import {
  flatten,
  shapeContours,
  bounds,
  automaticBridges,
  cutGeometry,
  exportSVG,
  transform,
} from "../src/geometry.js";
import {
  makeShapingFont,
  layoutText,
  layoutGlyphs,
} from "../src/typography.js";
import { resizeFromHandle, booleanContours } from "../src/operations.js";
import { splitParts } from "../src/grouping.js";
import { validateProject } from "../src/project.js";
import { ensureLayers } from "../src/layers.js";
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const nearP = (p, x, y, e = 1e-9) => {
  near(p.x, x, e);
  near(p.y, y, e);
};
const segDist = (p, a, b) => {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    l = dx * dx + dy * dy,
    t = l
      ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l))
      : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
const toPolyline = (p, contours) =>
  Math.min(
    ...contours.flatMap((c) => c.slice(1).map((b, i) => segDist(p, c[i], b))),
  );
const samples = (contours) =>
  contours.flatMap((c) =>
    c.slice(1).flatMap((b, i) =>
      [0, 0.5].map((t) => ({
        x: c[i].x + (b.x - c[i].x) * t,
        y: c[i].y + (b.y - c[i].y) * t,
      })),
    ),
  );
// Two-sided distance between outlines, measured against the polylines.
const deviation = (a, b) =>
  Math.max(
    ...samples(a).map((p) => toPolyline(p, b)),
    ...samples(b).map((p) => toPolyline(p, a)),
  );
// Contours without consecutive repeated points (zero-length lines).
const distinct = (contours) =>
  contours.map((c) =>
    c.filter((p, i) => !i || p.x !== c[i - 1].x || p.y !== c[i - 1].y),
  );
const fonts = Object.fromEntries(
  ["ZenKakuGothicNew-Regular.ttf", "ShipporiMincho-Regular.ttf"].map((file) => {
    const raw = fs.readFileSync(
        new URL(`../public/fonts/${file}`, import.meta.url),
      ),
      bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    return [
      file,
      { font: opentype.parse(bytes), shaping: makeShapingFont(bytes) },
    ];
  }),
);
test("SVG path data: M L H V C S Q T Z, absolute and relative", () => {
  const box = parsePathData("M10 10 H20 V20 h-10 z");
  assert.equal(box.length, 1);
  assert.equal(box[0].closed, true);
  assert.deepEqual(
    box[0].nodes.map((n) => [n.x, n.y, n.in, n.out]),
    [
      [10, 10, undefined, undefined],
      [20, 10, undefined, undefined],
      [20, 20, undefined, undefined],
      [10, 20, undefined, undefined],
    ],
  );
  const smooth = parsePathData("M0 0 C0 10 10 10 10 0 S20 -10 20 0")[0];
  nearP(smooth.nodes[1].out, 10, -10);
  assert.equal(smooth.nodes[1].smooth, true);
  const quad = parsePathData("M0 0 Q5 10 10 0 T20 0")[0];
  nearP(quad.nodes[0].out, 10 / 3, 20 / 3);
  nearP(quad.nodes[1].in, 20 / 3, 20 / 3);
  // T reflects the control point (5,10) about (10,0) to (15,-10).
  nearP(quad.nodes[1].out, 10 + 10 / 3, -20 / 3);
  const rel = parsePathData("m1 1 l10 0 0 10 z m20 0 c0 5 5 5 5 0 t10 0 z");
  assert.equal(rel.length, 2);
  nearP(rel[0].nodes[2], 11, 11);
  nearP(rel[1].nodes[0], 21, 1);
  nearP(rel[1].nodes[1], 26, 1);
  // Implicit lineto after M and numbers written without separators.
  const packed = parsePathData("M0,0 10,0-5.5.5z")[0];
  assert.deepEqual(
    packed.nodes.map((n) => [n.x, n.y]),
    [
      [0, 0],
      [10, 0],
      [-5.5, 0.5],
    ],
  );
  for (const bad of [
    "L10 10",
    "M0 0 L1",
    "M0 0 X1 1",
    "M0 0 L1 1 <",
    "M0 0 A5 5 0 2 1 10 0",
  ])
    assert.throws(() => parsePathData(bad), bad);
});
test("arcs (A) become cubics on the true ellipse, honouring the flags", () => {
  const onCircle = (d, cx, cy, r) => {
    const contours = pathContours(parsePathData(d));
    for (const p of contours.flat())
      assert.ok(Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) < 0.02, d);
    return contours.flat();
  };
  // Half circle from (0,0) to (20,0): sweep 1 goes through y = -10 (y down).
  let pts = onCircle("M0 0 A10 10 0 0 1 20 0", 10, 0, 10);
  assert.ok(Math.min(...pts.map((p) => p.y)) < -9.99);
  pts = onCircle("M0 0 A10 10 0 0 0 20 0", 10, 0, 10);
  assert.ok(Math.max(...pts.map((p) => p.y)) > 9.99);
  // Large arc: three quarters of a circle, split into cubics of up to 90°.
  const large = parsePathData("M10 0 A10 10 0 1 1 0 10");
  assert.equal(nodeKeys(large).length, 4);
  // From (10,0) to (0,10) the large clockwise arc runs around (10,10).
  onCircle("M10 0 A10 10 0 1 1 0 10", 10, 10, 10);
  onCircle("M10 0 A10 10 0 0 1 0 10", 0, 0, 10);
  // Packed flags, relative arcs, rotated ellipses and too-small radii.
  assert.deepEqual(
    pathContours(parsePathData("M0 0 a10 10 0 0120 0")),
    pathContours(parsePathData("M0 0 A10 10 0 0 1 20 0")),
  );
  const ellipse = pathContours(parsePathData("M0 0 A20 10 90 0 1 0 40")).flat();
  assert.ok(Math.max(...ellipse.map((p) => Math.abs(p.x))) > 9.9);
  onCircle("M0 0 A1 1 0 0 1 20 0", 10, 0, 10);
  assert.equal(nodeKeys(parsePathData("M0 0 A0 5 0 0 1 20 0")).length, 2);
});
test("path data round-trips through M/L/C/Z and flattens like the source", () => {
  const d =
    "M0 0 C0 10 10 10 10 0 S20 -10 20 0 Q25 10 30 0 T40 0 L40 20 H0 Z M5 5 L8 5 L8 8 Z";
  const path = parsePathData(d),
    again = parsePathData(toPathData(path));
  assert.match(toPathData(path), /^M[\d\s.CLZM-]+$/);
  assert.equal(nodeKeys(again).length, nodeKeys(path).length);
  assert.ok(deviation(pathContours(again), pathContours(path)) < 1e-3);
  const commands = [
    { type: "M", x: 0, y: 0 },
    { type: "Q", x1: 5, y1: 10, x: 10, y: 0 },
    { type: "C", x1: 12, y1: -5, x2: 18, y2: -5, x: 20, y: 0 },
    { type: "L", x: 20, y: 10 },
    { type: "Z" },
  ];
  assert.deepEqual(pathContours(pathFromCommands(commands)), flatten(commands));
  // opentype.js starts TrueType contours with a zero-length line.
  const repeated = [
    commands[0],
    { type: "L", x: 0, y: 0 },
    ...commands.slice(1),
  ];
  assert.deepEqual(pathContours(pathFromCommands(repeated)), flatten(commands));
});
for (const [file, { font, shaping }] of Object.entries(fonts))
  test(`${file}: outlined text keeps the glyph Béziers and exactly the same outline`, () => {
    for (const settings of [
      { text: "ARO日よ", vertical: false, stretch: 1 },
      { text: "「縦ー」", vertical: true, stretch: 1.3 },
    ]) {
      const item = { size: 24, spacing: 1, ...settings },
        glyphs = layoutGlyphs(item, font, shaping),
        path = pathFromCommands(glyphs.flatMap((g) => g.commands));
      assert.deepEqual(
        pathContours(path),
        distinct(layoutText(item, font, shaping)),
      );
      // No two neighbouring nodes on the same spot.
      for (const s of path)
        s.nodes.forEach((n, i) => {
          const m = s.nodes[(i + 1) % s.nodes.length];
          assert.ok(n.x !== m.x || n.y !== m.y);
        });
      assert.ok(
        path.every((s) => s.closed),
        "glyph contours are closed",
      );
      assert.ok(
        nodeKeys(path).some((k) => nodeAt(path, k).in || nodeAt(path, k).out),
      );
    }
  });
for (const [file, { font }] of Object.entries(fonts))
  test(`${file}: fitted curves follow flattened outlines within 0.05 mm with fewer nodes`, () => {
    for (const ch of "ORA日あ") {
      const flat = flatten(font.charToGlyph(ch).getPath(0, 30, 30).commands),
        fit = pathFromContours(flat);
      assert.ok(deviation(pathContours(fit), flat) < 0.05, ch);
      // Never more nodes than distinct polyline points; far fewer on curves.
      assert.ok(nodeKeys(fit).length <= flat.flat().length - flat.length, ch);
      if ("Oあ".includes(ch))
        assert.ok(nodeKeys(fit).length < flat.flat().length / 4, ch);
      assert.equal(fit.length, flat.length);
    }
    // A boolean result of straight edges fits as straight lines and corners.
    const frame = pathFromContours(
      booleanContours(
        [
          {
            id: "a",
            type: "rect",
            x: 0,
            y: 0,
            rotation: 0,
            contours: shapeContours("rect", 30, 20),
          },
          {
            id: "b",
            type: "rect",
            x: 5,
            y: 5,
            rotation: 0,
            contours: shapeContours("rect", 10, 10),
          },
        ],
        "difference",
      ),
    );
    assert.equal(nodeKeys(frame).length, 8);
    assert.ok(
      nodeKeys(frame).every(
        (k) => !nodeAt(frame, k).in && !nodeAt(frame, k).out,
      ),
    );
  });
test("rectangles and ellipses become exact editable paths", () => {
  assert.equal(nodeKeys(shapePath("rect", 30, 20)).length, 4);
  const oval = shapePath("rect", 30, 20, 8, 4);
  assert.equal(nodeKeys(oval).length, 8);
  assert.equal(bounds(pathContours(oval)).w, 30);
  const rounded = shapePath("rect", 30, 20, 5);
  assert.equal(nodeKeys(rounded).length, 8);
  assert.ok(
    deviation(pathContours(rounded), shapeContours("rect", 30, 20, 5)) < 0.03,
  );
  assert.equal(nodeKeys(shapePath("rect", 30, 20, 10)).length, 6);
  const ellipse = shapePath("circle", 40, 20);
  assert.equal(nodeKeys(ellipse).length, 4);
  assert.ok(nodeKeys(ellipse).every((k) => nodeAt(ellipse, k).smooth));
  assert.ok(
    deviation(pathContours(ellipse), shapeContours("circle", 40, 20)) < 0.03,
  );
});
test("node moves carry handles; smooth handles stay linked, corner handles independent", () => {
  const path = parsePathData("M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0");
  const moved = moveNodes(path, ["0:1"], 2, 3);
  nearP(moved[0].nodes[1], 12, 3);
  nearP(moved[0].nodes[1].in, 12, 13);
  nearP(moved[0].nodes[1].out, 12, -7);
  nearP(path[0].nodes[1], 10, 0);
  const smooth = moveHandle(path, "0:1", "out", { x: 16, y: -8 });
  const n = smooth[0].nodes[1],
    din = { x: n.x - n.in.x, y: n.y - n.in.y },
    dout = { x: n.out.x - n.x, y: n.out.y - n.y };
  near(din.x * dout.y - din.y * dout.x, 0, 1e-9);
  near(Math.hypot(din.x, din.y), 10, 1e-9);
  assert.ok(n.smooth);
  const broken = moveHandle(path, "0:1", "out", { x: 16, y: -8 }, true);
  nearP(broken[0].nodes[1].in, 10, 10);
  assert.equal(broken[0].nodes[1].smooth, undefined);
  const corner = setNodeType(path, ["0:1"], "corner"),
    free = moveHandle(corner, "0:1", "out", { x: 16, y: -8 });
  nearP(free[0].nodes[1].in, 10, 10);
  const line = setNodeType(path, ["0:1"], "line");
  assert.equal(line[0].nodes[1].in, undefined);
  assert.equal(line[0].nodes[1].out, undefined);
});
test("smooth nodes gain collinear handles from their neighbours", () => {
  const triangle = parsePathData("M0 0 L10 10 L20 0 Z"),
    smooth = setNodeType(triangle, ["0:1"], "smooth"),
    n = smooth[0].nodes[1];
  assert.ok(n.smooth && n.in && n.out);
  near(n.in.y, 10);
  near(n.out.y, 10);
  assert.ok(n.in.x < 10 && n.out.x > 10);
  assert.ok(segmentCurve(smooth[0], 0) && segmentCurve(smooth[0], 1));
});
test("adding a node splits curves exactly and lines at the point", () => {
  const path = parsePathData("M0 0 C0 10 10 10 10 0 L20 0"),
    before = pathContours(path);
  const { path: split, key } = insertNode(path, 0, 0, 0.3);
  assert.equal(key, "0:1");
  assert.equal(nodeKeys(split).length, 4);
  assert.ok(deviation(pathContours(split), before) < 0.02);
  const { path: onLine } = insertNode(path, 0, 1, 0.5);
  nearP(onLine[0].nodes[2], 15, 0);
  // Closing segment of a closed path.
  const square = parsePathData("M0 0 H10 V10 H0 Z"),
    closed = insertNode(square, 0, 3, 0.5);
  nearP(closed.path[0].nodes[4], 0, 5);
  const hit = nearestSegment(path, { x: 15, y: 0.4 });
  assert.equal(hit.i, 1);
  near(hit.t, 0.5, 1e-6);
  near(hit.distance, 0.4, 1e-6);
});
test("deleting nodes keeps neighbours, drops empty subpaths and never empties the path", () => {
  const path = parsePathData("M0 0 H10 V10 H0 Z M20 0 H30 V10 Z");
  const fewer = deleteNodes(path, ["0:1"]);
  assert.equal(fewer[0].nodes.length, 3);
  const dropped = deleteNodes(path, ["1:0"]);
  assert.equal(dropped.length, 1);
  assert.throws(() => deleteNodes(path, nodeKeys(path)), /すべてのノード/);
});
test("visible handles are those of selected nodes and their adjacent segments", () => {
  const path = parsePathData(
    "M0 0 C0 10 10 10 10 0 C10 -10 20 -10 20 0 C25 5 30 5 30 0",
  );
  assert.deepEqual(visibleHandles(path, new Set()), []);
  assert.deepEqual(
    visibleHandles(path, new Set(["0:1"]))
      .map((h) => `${h.key}:${h.side}`)
      .sort(),
    ["0:0:out", "0:1:in", "0:1:out", "0:2:in"],
  );
});
test("path outlines resize, save and feed bridges, booleans and export", () => {
  const { font, shaping } = fonts["ZenKakuGothicNew-Regular.ttf"],
    glyphs = layoutGlyphs({ text: "A", size: 40, spacing: 0 }, font, shaping),
    path = pathFromCommands(glyphs.flatMap((g) => g.commands));
  let item = {
    id: "a",
    type: "outline",
    name: "A",
    x: 20,
    y: 20,
    rotation: 0,
    layerId: "layer-default",
    path,
    contours: pathContours(path),
  };
  // Stretch the right leg: move its two lowest nodes 10 mm down.
  const b = bounds(item.contours),
    feet = nodeKeys(path).filter(
      (k) =>
        nodeAt(path, k).y > b.y + b.h - 0.01 &&
        nodeAt(path, k).x > b.x + b.w / 2,
    );
  assert.equal(feet.length, 2);
  const longer = moveNodes(path, feet, 0, 10);
  item = { ...item, path: longer, contours: pathContours(longer) };
  near(bounds(item.contours).h, b.h + 10, 1e-6);
  const resized = resizeFromHandle(
    item,
    [1, 1],
    transform({ x: b.x + b.w * 2, y: b.y + b.h + 10 }, item),
    false,
  );
  assert.deepEqual(resized.contours, pathContours(resized.path));
  near(bounds(resized.contours).w, b.w * 2, 1e-6);
  const tabs = automaticBridges([item], 1.5).map((t, i) => ({
    ...t,
    id: `t${i}`,
  }));
  assert.equal(cutGeometry([item, ...tabs]).unbridgedIslands, 0);
  assert.ok(
    booleanContours([item, { ...item, id: "c", x: 30 }], "union").length,
  );
  assert.equal(splitParts(item)[0].path, undefined);
  const project = ensureLayers({
    version: 2,
    width: 240,
    height: 160,
    items: [item],
  });
  const svg = exportSVG(project);
  assert.match(svg, /<path d="M/);
  assert.doesNotMatch(
    svg,
    /data-node|data-handle|path-edit|<circle|<rect|<line|transform=/,
  );
  const saved = validateProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(saved.items[0].path, longer);
  for (const bad of [
    [{ closed: "yes", nodes: [{ x: 0, y: 0 }] }],
    [{ closed: true, nodes: [{ x: 0, y: NaN }] }],
    [{ closed: true, nodes: [{ x: 0, y: 0, in: { x: 1 } }] }],
    [],
  ])
    assert.throws(() =>
      validateProject({ ...project, items: [{ ...item, path: bad }] }),
    );
  assert.throws(() =>
    validateProject({
      ...project,
      items: [
        {
          ...item,
          type: "rect",
          w: 10,
          h: 10,
          contours: shapeContours("rect", 10, 10),
        },
      ],
    }),
  );
});
