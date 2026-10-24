import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import {
  polygonVertices, polygonItem, reflectPoint, reflectAngle, mirrorItems, axisThrough,
  rectangularPattern, circularPattern, offsetClosed, offsetOpen, offsetItem,
  segmentIntersection, contourCrossings, trimContour, trimItem, extendItem,
  filletCorner, chamferCorner, cornerItem, cornerOfLines, joinLines, workingPathOf,
  measurePoints, angleAt, measureItem, snapToVertex, makeDimension, dimensionLabel, dimensionGeometry,
} from "../src/cad.js";
import { shapeContours, worldContours, bounds, transform, exportSVG, cutGeometry, flatten } from "../src/geometry.js";
import { pathContours, shapePath } from "../src/path.js";
import { validateProject, validateAnnotations } from "../src/project.js";
import { ensureLayers } from "../src/layers.js";
import { layoutText, makeShapingFont } from "../src/typography.js";

let n = 0;
const makeId = () => `id-${++n}`;
const rect = (id, x, y, w, h, rotation = 0, extra = {}) => ({ id, type: "rect", name: id, x, y, w, h, rotation, layerId: "L", ratioLocked: false, contours: shapeContours("rect", w, h), ...extra });
const circle = (id, x, y, w, h = w) => ({ id, type: "circle", name: id, x, y, w, h, rotation: 0, layerId: "L", ratioLocked: false, contours: shapeContours("circle", w, h) });
const line = (id, x, y, w, rotation = 0) => ({ id, type: "line", name: id, x, y, w, h: 0, rotation, layerId: "L", contours: shapeContours("line", w, 0) });
const area = (c) => Math.abs(c.slice(1).reduce((s, p, i) => s + (c[i].x * p.y - p.x * c[i].y), 0)) / 2;
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const closeP = (a, b, eps = 1e-6) => close(a.x, b.x, eps) && close(a.y, b.y, eps);

// ---- Polygon
test("polygon: triangle, hexagon and 100-gon vertices lie on the circle and form a closed editable path", () => {
  for (const sides of [3, 6, 100]) {
    const v = polygonVertices(sides, 10);
    assert.equal(v.length, sides);
    for (const p of v) assert.ok(close(Math.hypot(p.x, p.y), 10, 1e-5));
    assert.ok(closeP(v[0], { x: 0, y: -10 }), "first vertex at the top");
    const item = polygonItem({ cx: 50, cy: 40, sides, radius: 10 }, "p", "L");
    assert.equal(item.type, "outline");
    assert.equal(item.path[0].nodes.length, sides);
    assert.equal(item.path[0].closed, true);
    const b = bounds(worldContours(item));
    assert.ok(close(b.x + b.w / 2, 50, 1e-5) && close(b.y + b.h / 2, 40, sides === 3 ? 2.6 : 1e-5), `${sides}-gon centred`);
  }
  const hex = polygonVertices(6, 10);
  assert.ok(close(area([...hex, hex[0]]), (3 * Math.sqrt(3) * 100) / 2, 1e-4), "hexagon area");
  assert.ok(close(polygonVertices(4, 10, 45)[0].x, 10 * Math.cos(-Math.PI / 4), 1e-6), "rotation applies");
  assert.throws(() => polygonVertices(2, 10), /3〜100/);
  assert.throws(() => polygonVertices(101, 10), /3〜100/);
  assert.throws(() => polygonVertices(5, 0), /半径/);
});

// ---- Mirror
test("mirror: reflection maths and rect/line/ellipse copies stay rects/lines with exact corners", () => {
  const a = { x: 0, y: 0 }, b = { x: 0, y: 10 };
  assert.deepEqual(reflectPoint({ x: 3, y: 4 }, a, b), { x: -3, y: 4 });
  assert.equal(reflectAngle(30, a, b), 150);
  assert.equal(reflectAngle(30, { x: 0, y: 0 }, { x: 10, y: 0 }), -30);
  const plain = rect("p", 120, 40, 30, 30);
  const [mp0] = mirrorItems([plain], { x: 200, y: 0 }, { x: 200, y: 1 }, makeId);
  assert.deepEqual([mp0.x, mp0.y, mp0.rotation], [250, 40, 0], "a 0° rectangle mirrors to a 0° rectangle");
  const r = rect("r", 10, 20, 30, 10, 30);
  const [m] = mirrorItems([r], { x: 100, y: 0 }, { x: 100, y: 1 }, makeId);
  assert.equal(m.type, "rect");
  assert.equal(m.w, 30);
  assert.equal(m.h, 10);
  assert.notEqual(m.id, r.id);
  const corners = (item) => worldContours(item)[0].slice(0, 4).map((p) => ({ x: Number(p.x.toFixed(5)), y: Number(p.y.toFixed(5)) }));
  const mirrored = corners(r).map((p) => reflectPoint(p, { x: 100, y: 0 }, { x: 100, y: 1 })).map((p) => ({ x: Number(p.x.toFixed(5)), y: Number(p.y.toFixed(5)) }));
  for (const p of mirrored) assert.ok(corners(m).some((q) => closeP(p, q, 1e-4)), `corner ${JSON.stringify(p)} present`);
  const l = line("l", 0, 0, 20, 45);
  const [ml] = mirrorItems([l], { x: 0, y: 0 }, { x: 10, y: 0 }, makeId);
  assert.equal(ml.type, "line");
  assert.ok(close(ml.rotation, -45) && close(ml.w, 20));
  const c = circle("c", 0, 0, 20, 10);
  const [mc] = mirrorItems([c], { x: 0, y: 30 }, { x: 10, y: 30 }, makeId);
  assert.equal(mc.type, "circle");
  const bb = bounds(worldContours(mc));
  assert.ok(close(bb.y, 50, 1e-6) && close(bb.h, 10, 1e-6) && close(bb.w, 20, 1e-6));
});

test("mirror: text and paths become exactly reflected outlines; groups and bridges are remapped", () => {
  const bytes = fs.readFileSync("public/fonts/ZenKakuGothicNew-Regular.ttf");
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const font = opentype.parse(buf), shaping = makeShapingFont(buf);
  const text = { id: "t", type: "text", name: "t", text: "R", font: "zen", size: 20, spacing: 0, vertical: false, x: 10, y: 10, rotation: 20, layerId: "L", groupId: "g1" };
  text.contours = layoutText(text, font, shaping);
  const bridge = { id: "b", type: "bridge", name: "b", x: 20, y: 20, w: 4, h: 1.5, rotation: 10, layerId: "L", targetId: "t", groupId: "g1" };
  const other = rect("o", 0, 0, 5, 5, 0, { groupId: "g1" });
  const axis = [{ x: 60, y: -5 }, { x: 60, y: 50 }];
  const copies = mirrorItems([text, bridge, other], axis[0], axis[1], makeId);
  const [mt, mb, mo] = copies;
  assert.equal(mt.type, "outline");
  assert.equal(mt.text, undefined);
  assert.equal(mt.rotation, 0);
  const expected = worldContours(text).flat().map((p) => reflectPoint(p, ...axis));
  const got = worldContours(mt).flat();
  assert.equal(got.length, expected.length);
  for (let i = 0; i < expected.length; i++) assert.ok(closeP(expected[i], got[i], 1e-4), `point ${i}`);
  assert.equal(mb.targetId, mt.id, "bridge follows the mirrored owner");
  assert.ok(closeP(mb, reflectPoint(bridge, ...axis)), "bridge centre mirrored");
  assert.ok(close(mb.rotation, reflectAngle(10, ...axis)));
  assert.equal(mt.groupId, mo.groupId);
  assert.notEqual(mt.groupId, "g1");
  // editable path with handles reflects node by node
  const pathItem = { id: "p", type: "outline", name: "p", x: 0, y: 0, rotation: 0, layerId: "L", path: shapePath("rect", 10, 6, 2), contours: pathContours(shapePath("rect", 10, 6, 2)) };
  const [mp] = mirrorItems([pathItem], { x: 0, y: 0 }, { x: 1, y: 1 }, makeId);
  assert.ok(mp.path[0].nodes.some((nd) => nd.in || nd.out), "handles kept");
  const before = worldContours(pathItem).flat().map((p) => reflectPoint(p, { x: 0, y: 0 }, { x: 1, y: 1 }));
  const after = worldContours(mp).flat();
  for (const p of before.filter((_, i) => i % 5 === 0)) assert.ok(after.some((q) => closeP(p, q, 0.03)), "reflected outline within tolerance");
  const [h1, h2] = axisThrough({ x: 5, y: 5 }, "horizontal");
  assert.equal(h1.y, h2.y);
});

// ---- Patterns
test("rectangular pattern: 1×1 makes nothing, 1×N and N×M place copies at the spacing, negative spacing allowed, sets stay grouped", () => {
  const r = rect("r", 10, 10, 5, 5, 0, { groupId: "g" });
  const b = { id: "b", type: "bridge", name: "b", x: 12, y: 10, w: 2, h: 1, rotation: 0, layerId: "L", targetId: "r", groupId: "g" };
  assert.equal(rectangularPattern([r, b], { columns: 1, rows: 1, dx: 20, dy: 15 }, makeId).length, 0);
  const col = rectangularPattern([r, b], { columns: 1, rows: 4, dx: 20, dy: 15 }, makeId);
  assert.equal(col.length, 6);
  assert.deepEqual(col.filter((i) => i.type === "rect").map((i) => i.y), [25, 40, 55]);
  const grid = rectangularPattern([r, b], { columns: 5, rows: 3, dx: 20, dy: -15 }, makeId);
  assert.equal(grid.length, 14 * 2);
  const rects = grid.filter((i) => i.type === "rect");
  assert.ok(rects.some((i) => i.x === 90 && i.y === -20));
  const groups = new Set(rects.map((i) => i.groupId));
  assert.equal(groups.size, 14, "each copy set is its own group");
  for (const br of grid.filter((i) => i.type === "bridge")) assert.ok(rects.some((i) => i.id === br.targetId), "bridge owner remapped per copy");
  assert.throws(() => rectangularPattern([r], { columns: 0, rows: 1, dx: 1, dy: 1 }, makeId), /1〜200/);
  assert.throws(() => rectangularPattern([r], { columns: 2, rows: 2, dx: NaN, dy: 1 }, makeId), /間隔/);
});

test("circular pattern: 360° spreads evenly, 180° spans the angle, count 2, arbitrary centre and rotation per copy", () => {
  const r = rect("r", 30, 0, 4, 4);
  const full = circularPattern([r], { center: { x: 0, y: 0 }, count: 6, totalAngle: 360 }, makeId);
  assert.equal(full.length, 5);
  assert.deepEqual(full.map((i) => Math.round(i.rotation)), [60, 120, 180, -120, -60]);
  assert.ok(closeP(full[2], { x: -30, y: 0 }, 1e-5), "180° copy across the centre");
  const half = circularPattern([r], { center: { x: 0, y: 0 }, count: 3, totalAngle: 180 }, makeId);
  assert.equal(half.length, 2);
  assert.deepEqual(half.map((i) => Math.round(i.rotation)), [90, 180]);
  assert.ok(closeP(half[0], { x: 0, y: 30 }, 1e-5));
  const two = circularPattern([r], { center: { x: 10, y: 10 }, count: 2, totalAngle: 90 }, makeId);
  assert.equal(two.length, 1);
  assert.ok(closeP(two[0], { x: 20, y: 30 }, 1e-5), "arbitrary centre");
  assert.throws(() => circularPattern([r], { center: { x: 0, y: 0 }, count: 1 }, makeId), /2〜360/);
  assert.throws(() => circularPattern([r], { center: null, count: 3 }, makeId), /中心/);
});

// ---- Offset
test("offset: rectangle and circle outer/inner areas, polygon, hole-bearing outline, vanishing inner offset, open path", () => {
  const sq = shapeContours("rect", 20, 10);
  const outer = offsetClosed(sq, 2, "miter");
  assert.equal(outer.length, 1);
  assert.ok(close(area(outer[0]), 24 * 14, 1e-3), "mitred outer rectangle");
  const round = offsetClosed(sq, 2, "round");
  assert.ok(area(round[0]) < 24 * 14 && area(round[0]) > 24 * 14 - 4 * 4 + Math.PI * 4 - 0.5, "rounded corners (arc inscribed within 0.02 mm)");
  const inner = offsetClosed(sq, -2, "miter");
  assert.ok(close(area(inner[0]), 16 * 6, 1e-3), "inner rectangle");
  assert.equal(offsetClosed(sq, -6, "miter").length, 0, "too large inner offset vanishes");
  const circ = shapeContours("circle", 20, 20);
  assert.ok(close(area(offsetClosed(circ, 5, "round")[0]), Math.PI * 225, 1.5), "circle outward");
  assert.ok(close(area(offsetClosed(circ, -5, "round")[0]), Math.PI * 25, 0.5), "circle inward");
  const hex = polygonVertices(6, 10);
  const hexOut = offsetClosed([[...hex, hex[0]]], 1, "miter")[0];
  assert.ok(area(hexOut) > area([...hex, hex[0]]));
  // outline with a hole: outer grows, hole shrinks
  const ring = [shapeContours("rect", 30, 30)[0], shapeContours("rect", 10, 10)[0].map((p) => ({ x: p.x + 10, y: p.y + 10 })).reverse()];
  const grown = offsetClosed(ring, 1, "miter");
  assert.equal(grown.length, 2);
  const areas = grown.map(area).sort((a, b) => b - a);
  assert.ok(close(areas[0], 32 * 32, 1e-3) && close(areas[1], 8 * 8, 1e-3), `hole shrinks: ${areas}`);
  const item = rect("r", 5, 5, 20, 10);
  const off = offsetItem(item, 2, "square", "o");
  assert.equal(off.type, "outline");
  assert.ok(off.path.length === 1 && off.contours.length === 1);
  const wb = bounds(worldContours(off));
  assert.ok(close(wb.x, 3) && close(wb.w, 24), "offset item placed in world coordinates");
  assert.throws(() => offsetItem(item, -6, "miter", "o"), /消えました/);
  assert.throws(() => offsetItem(item, 0, "miter", "o"), /距離/);
  const par = offsetOpen([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 1);
  assert.ok(closeP(par[0], { x: 0, y: 1 }) && closeP(par[1], { x: 9, y: 1 }) && closeP(par[2], { x: 9, y: 10 }), `parallel polyline ${JSON.stringify(par)}`);
  const lineOff = offsetItem(line("l", 0, 0, 10), 2, "miter", "o2");
  assert.equal(lineOff.contours[0].length, 2);
});

// ---- Trim
test("trim: crossing lines remove the span between intersections, line+circle, closed contour, no intersection", () => {
  const h = line("h", 0, 10, 40), v1 = line("v1", 10, 0, 20, 90), v2 = line("v2", 30, 0, 20, 90);
  const pieces = trimItem(h, { x: 20, y: 10 }, [h, v1, v2], makeId);
  assert.equal(pieces.length, 2);
  assert.ok(pieces.every((p) => p.type === "line"));
  const xs = pieces.map((p) => [p.x, p.x + p.w].sort((a, b) => a - b));
  assert.ok(close(xs[0][0], 0) && close(xs[0][1], 10) && close(xs[1][0], 30) && close(xs[1][1], 40), JSON.stringify(xs));
  const end = trimItem(h, { x: 5, y: 10 }, [h, v1, v2], makeId);
  assert.equal(end.length, 1);
  assert.ok(close(end[0].x, 10) && close(end[0].w, 30), "trim at the start keeps the rest");
  // line through a circle: the middle span inside the circle is removed
  const c = circle("c", 10, 0, 20), l = line("l", 0, 10, 40);
  const lc = trimItem(l, { x: 20, y: 10 }, [c, l], makeId);
  assert.equal(lc.length, 2);
  assert.ok(lc.every((p) => close(p.w, 10, 0.05)), `outside pieces ${lc.map((p) => p.w)}`);
  // closed rectangle crossed by a line: clicking the top edge opens it there
  const r = rect("r", 0, 0, 20, 20), across = line("x", 5, -5, 30, 90), across2 = line("y", 15, -5, 30, 90);
  const opened = trimItem(r, { x: 10, y: 0 }, [r, across, across2], makeId);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].type, "outline");
  const oc = opened[0].contours[0];
  assert.ok(!closeP(oc[0], oc.at(-1)), "contour is open now");
  assert.ok(close(oc.length ? Math.max(...worldContours(opened[0])[0].map((p) => p.y)) : 0, 20), "the rest of the rectangle remains");
  assert.throws(() => trimItem(line("a", 0, 0, 10), { x: 5, y: 0 }, [line("b", 0, 20, 10)], makeId), /交点がありません/);
  assert.throws(() => trimItem(r, { x: 10, y: 0 }, [r, line("z", 10, -5, 10, 90)], makeId), /2つ以上/, "a single crossing cannot open a closed contour");
  assert.ok(segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 }).t === 0.5);
  assert.equal(segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 }), null);
  assert.equal(contourCrossings([{ x: 0, y: 0 }, { x: 10, y: 0 }], [[{ x: 3, y: -1 }, { x: 3, y: 1 }], [{ x: 7, y: -1 }, { x: 7, y: 1 }]]).length, 2);
  assert.equal(trimContour([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.5, [{ s: 0.3 }, { s: 0.7 }]).length, 2);
});

// ---- Extend
test("extend: a line grows to the first crossing target; no target throws", () => {
  const l = line("l", 0, 10, 10), wall = line("w", 30, 0, 30, 90);
  const ext = extendItem(l, { x: 10, y: 10 }, [l, wall], makeId);
  assert.equal(ext.type, "line");
  assert.ok(close(ext.x, 0) && close(ext.w, 30), `extended to x=30 (${ext.w})`);
  const back = extendItem(line("l2", 10, 10, 10), { x: 10, y: 10 }, [line("w2", -5, 0, 30, 90)], makeId);
  assert.ok(close(back.x, -5) && close(back.w, 25), "start end extends backwards");
  assert.throws(() => extendItem(l, { x: 10, y: 10 }, [l, line("far", 0, 50, 10)], makeId), /延長先が見つかりません/);
  assert.throws(() => extendItem(rect("r", 0, 0, 5, 5), { x: 0, y: 0 }, [], makeId), /開いた線/);
});

// ---- Fillet / Chamfer
test("fillet: 90°, acute and obtuse corners get tangent points at r/tan(θ/2) and a cubic arc; too large a radius throws", () => {
  const square = [{ closed: true, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }];
  const f = filletCorner(square, 0, 1, 3);
  assert.equal(f[0].nodes.length, 5);
  const [a, b] = [f[0].nodes[1], f[0].nodes[2]];
  assert.ok(closeP(a, { x: 7, y: 0 }) && closeP(b, { x: 10, y: 3 }), "tangent points 3 mm from the corner");
  assert.ok(a.out && b.in, "arc handles");
  const arc = pathContours([{ closed: false, nodes: [a, b] }])[0];
  for (const p of arc) assert.ok(close(Math.hypot(p.x - 7, p.y - 3), 3, 0.02), "arc points 3 mm from the arc centre");
  assert.equal(filletCorner(square, 0, 1, 10)[0].nodes.length, 5, "radius equal to the edge is the limit for 90°");
  assert.throws(() => filletCorner(square, 0, 1, 12), /大きすぎ/);
  const acute = [{ closed: false, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }] }];
  const fa = filletCorner(acute, 0, 1, 1);
  const theta = Math.acos(((-10) * (-10) + 0 * 5) / (10 * Math.hypot(10, 5)));
  assert.ok(close(Math.hypot(fa[0].nodes[1].x - 10, fa[0].nodes[1].y), 1 / Math.tan(theta / 2), 1e-4), "acute tangent length");
  const obtuse = [{ closed: false, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 5 }] }];
  const fo = filletCorner(obtuse, 0, 1, 2);
  assert.equal(fo[0].nodes.length, 4);
  assert.throws(() => filletCorner(acute, 0, 0, 1), /端のノード/);
  const curved = [{ closed: false, nodes: [{ x: 0, y: 0, out: { x: 3, y: 0 } }, { x: 10, y: 0, in: { x: 7, y: 0 } }, { x: 10, y: 10 }] }];
  assert.throws(() => filletCorner(curved, 0, 1, 1), /直線どうし/);
});

test("chamfer: equal-distance 90° corner; too large a distance throws; corner tools on items and on two lines", () => {
  const square = [{ closed: true, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }];
  const ch = chamferCorner(square, 0, 1, 3);
  assert.equal(ch[0].nodes.length, 5);
  assert.ok(closeP(ch[0].nodes[1], { x: 7, y: 0 }) && closeP(ch[0].nodes[2], { x: 10, y: 3 }));
  assert.ok(!ch[0].nodes[1].out && !ch[0].nodes[2].in, "straight chamfer");
  assert.equal(chamferCorner(square, 0, 1, 10)[0].nodes.length, 5, "distance equal to the edge is the limit");
  assert.throws(() => chamferCorner(square, 0, 1, 11), /大きすぎ/);
  const r = rect("r", 5, 5, 20, 10);
  const filleted = cornerItem(r, { x: 25, y: 5 }, 4, "fillet", "f");
  assert.equal(filleted.type, "outline");
  assert.equal(filleted.path[0].nodes.length, 5);
  assert.equal(filleted.w, undefined);
  const wc = worldContours(filleted).flat();
  assert.ok(!wc.some((p) => closeP(p, { x: 25, y: 5 }, 1e-6)), "corner point removed");
  const a = line("a", 0, 0, 10), b = line("b", 10, 0, 10, 90);
  assert.equal(joinLines(a, b).length, 3);
  const joined = cornerOfLines(a, b, 2, "chamfer", "j");
  assert.equal(joined.path[0].closed, false);
  assert.equal(joined.path[0].nodes.length, 4);
  assert.throws(() => joinLines(a, line("c", 30, 30, 5)), /接していません/);
  assert.deepEqual(workingPathOf(rect("q", 0, 0, 4, 4))[0].nodes.length, 4);
});

// ---- Measure & dimensions
test("measure: distance, ΔX/ΔY, diagonal, line length/angle, circle radius, angle between rays, vertex snapping", () => {
  const m = measurePoints({ x: 0, y: 0 }, { x: 40, y: 13.92 });
  assert.ok(close(m.distance, 42.352, 1e-3) && m.dx === 40 && m.dy === 13.92 && close(m.angle, 19.19, 0.01));
  assert.deepEqual(measurePoints({ x: 5, y: 5 }, { x: 25, y: 5 }), { distance: 20, dx: 20, dy: 0, angle: 0 });
  assert.deepEqual(measurePoints({ x: 5, y: 5 }, { x: 5, y: 15 }), { distance: 10, dx: 0, dy: 10, angle: 90 });
  assert.deepEqual(measureItem(line("l", 0, 0, 25, 30)), { kind: "line", length: 25, angle: 30 });
  assert.deepEqual(measureItem(circle("c", 0, 0, 12)), { kind: "circle", radius: 6, diameter: 12 });
  assert.deepEqual(measureItem(circle("e", 0, 0, 12, 8)), { kind: "ellipse", rx: 6, ry: 4 });
  assert.deepEqual(measureItem(rect("r", 3, 3, 20, 10)), { kind: "box", width: 20, height: 10 });
  assert.equal(angleAt({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }), 90);
  assert.ok(close(angleAt({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }), 45));
  assert.deepEqual(snapToVertex({ x: 20.3, y: 9.8 }, [rect("r", 0, 0, 20, 10)], 1), { x: 20, y: 10 });
  assert.deepEqual(snapToVertex({ x: 5, y: 5 }, [rect("r", 0, 0, 20, 10)], 1), { x: 5, y: 5 });
});

test("dimensions: values from points, labels, geometry, JSON validation and exclusion from the cut output", () => {
  const lin = makeDimension("linear", [{ x: 0, y: 0 }, { x: 80, y: 0 }], "d1");
  assert.equal(lin.value, 80);
  assert.equal(dimensionLabel(lin), "80.00 mm");
  assert.equal(makeDimension("horizontal", [{ x: 0, y: 0 }, { x: 30, y: 40 }], "d2").value, 30);
  assert.equal(makeDimension("vertical", [{ x: 0, y: 0 }, { x: 30, y: 40 }], "d3").value, 40);
  const ang = makeDimension("angle", [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], "d4");
  assert.equal(ang.value, 90);
  assert.equal(dimensionLabel(ang), "90.0°");
  assert.equal(makeDimension("radius", [{ x: 0, y: 0 }, { x: 6, y: 0 }], "d5").value, 6);
  assert.equal(dimensionLabel(makeDimension("diameter", [{ x: 0, y: 0 }, { x: 6, y: 0 }], "d6")), "⌀12.00 mm");
  assert.throws(() => makeDimension("angle", [{ x: 0, y: 0 }, { x: 1, y: 0 }], "x"), /点が足りません/);
  const g = dimensionGeometry(lin);
  assert.equal(g.kind, "linear");
  assert.ok(close(g.line[0].y, -6) && close(g.line[1].x, 80), "offset dimension line");
  assert.equal(dimensionGeometry(ang).kind, "angle");
  assert.equal(dimensionGeometry(makeDimension("diameter", [{ x: 5, y: 5 }, { x: 8, y: 5 }], "d7")).line[0].x, 2);
  // JSON: annotations survive validation, invalid ones are rejected, old files without them are fine
  const project = validateProject({ version: 2, name: "p", width: 100, height: 100, layers: [{ id: "L", name: "L", visible: true, locked: false }], items: [rect("r", 0, 0, 20, 10)], annotations: [lin, ang] });
  assert.equal(project.annotations.length, 2);
  assert.equal(validateProject({ version: 1, name: "p", width: 100, height: 100, items: [] }).annotations, undefined);
  assert.throws(() => validateAnnotations([{ type: "dimension", id: "x", dimensionType: "linear", points: [{ x: 0, y: 0 }], value: 1 }]), /寸法/);
  assert.throws(() => validateAnnotations([{ type: "note", id: "x" }]), /寸法/);
  // the cut output and checks only see items
  const svg = exportSVG(ensureLayers(project));
  assert.ok(!/80\.00|dimension/.test(svg), "no dimension in the SVG");
  assert.equal(cutGeometry(project.items).closed, 1);
});
