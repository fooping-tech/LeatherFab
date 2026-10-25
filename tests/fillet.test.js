import { test } from "node:test";
import assert from "node:assert/strict";
import { filletCurvedCorner } from "../src/leather/fillet.js";
import { filletCorner } from "../src/cad.js";
import { pathContours, shapePath } from "../src/path.js";
import { curve, corners, totalLength } from "../src/leather/polyline.js";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Max deviation of a polyline's "corner" turning: a smooth join has none.
const maxTurn = (pts) => Math.max(...corners(curve(pts, false), 1).map((k) => Math.abs(k.angle)), 0);
// Every point of the arc portion lies at radius r from one centre.
const arcRadiusError = (pts, r) => {
  // Fit centre as mean of (p + r·normal) is complex; instead check the circumscribed circle of 3 spread points.
  const a = pts[Math.floor(pts.length * 0.3)], b = pts[Math.floor(pts.length * 0.5)], c = pts[Math.floor(pts.length * 0.7)];
  const D = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / D;
  const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / D;
  return Math.abs(Math.hypot(a.x - ux, a.y - uy) - r);
};

test("curved fillet on a line–line corner matches the exact fillet", () => {
  const sq = shapePath("rect", 40, 30);
  const exact = filletCorner(sq, 0, 1, 5);
  const general = filletCurvedCorner(sq, 0, 1, 5);
  const pe = pathContours(exact)[0], pg = pathContours(general)[0];
  assert.ok(close(totalLength(pe), totalLength(pg), 1e-3), `${totalLength(pe)} vs ${totalLength(pg)}`);
  for (const p of pg.filter((_, k) => k % 7 === 0)) assert.ok(pe.some((q) => d(p, q) < 0.02), "same outline");
  assert.equal(general[0].nodes.length, 5);
});

test("fillet between a straight edge and a Bézier curve meeting at 90° is tangent", () => {
  const path = [{ closed: false, nodes: [{ x: 0, y: 0 }, { x: 40, y: 0, out: { x: 40, y: -15 } }, { x: 70, y: -30, in: { x: 55, y: -30 } }] }];
  const before = pathContours(path)[0];
  assert.ok(maxTurn(before) > 80, "input has a right-angle corner");
  const out = filletCorner(path, 0, 1, 5); // via cad.js → curved fallback
  assert.equal(out[0].nodes.length, 4);
  const pts = pathContours(out)[0];
  assert.ok(maxTurn(pts) < 10, `no sharp turn left: ${maxTurn(pts)}°`);
  const a = out[0].nodes[1];
  // A sits on the straight edge; the curve side decides exactly where.
  assert.ok(close(a.y, 0) && a.x > 33 && a.x < 37, `A on the straight edge near 5 mm before the corner: ${JSON.stringify(a)}`);
  const b = out[0].nodes[2];
  const ia = pts.findIndex((p) => d(p, a) < 1e-6), ib = pts.findIndex((p) => d(p, b) < 1e-6);
  assert.ok(arcRadiusError(pts.slice(ia, ib + 1), 5) < 0.05, "arc radius 5");
  assert.ok(totalLength(pts) < totalLength(before));
});

test("two sharply bent curves meeting at a cusp are joined by a smooth arc of radius r", () => {
  // Two cubic segments meeting at (50, 0) with a ~90° kink.
  const path = [{ closed: false, nodes: [
    { x: 0, y: 40, out: { x: 10, y: 10 } },
    { x: 50, y: 0, in: { x: 40, y: 20 }, out: { x: 60, y: 20 } },
    { x: 100, y: 40, in: { x: 90, y: 10 } },
  ] }];
  const before = pathContours(path)[0];
  assert.ok(maxTurn(before) > 60, "the input really has a sharp corner");
  for (const r of [3, 8]) {
    const out = filletCurvedCorner(path, 0, 1, r);
    assert.equal(out[0].nodes.length, 4);
    const pts = pathContours(out)[0];
    assert.ok(maxTurn(pts) < 10, `r=${r}: smooth join (max turn ${maxTurn(pts)}°)`);
    // The arc: points between the two inserted nodes.
    const a = out[0].nodes[1], b = out[0].nodes[2];
    const ia = pts.findIndex((p) => d(p, a) < 1e-6), ib = pts.findIndex((p) => d(p, b) < 1e-6);
    assert.ok(ia >= 0 && ib > ia, "inserted nodes lie on the outline");
    const arc = pts.slice(ia, ib + 1);
    assert.ok(arcRadiusError(arc, r) < 0.05, `r=${r}: arc radius error ${arcRadiusError(arc, r)}`);
    // Symmetric input → symmetric fillet.
    assert.ok(close(a.x + b.x, 100, 1e-3) && close(a.y, b.y, 1e-3));
  }
  assert.throws(() => filletCurvedCorner(path, 0, 1, 200), /半径/);
  assert.throws(() => filletCurvedCorner(path, 0, 0, 3), /端のノード/);
});

test("fillet at node 0 of a closed path (wrap-around) works", () => {
  const sq = shapePath("rect", 40, 30);
  const out = filletCurvedCorner(sq, 0, 0, 4);
  assert.equal(out[0].nodes.length, 5);
  const pts = pathContours(out)[0];
  assert.ok(maxTurn(pts) < 95, "three square corners remain, the filleted one is smooth");
  assert.ok(!pts.some((p) => d(p, { x: 0, y: 0 }) < 1e-6), "the original corner point is gone");
  assert.ok(close(totalLength(pts), 140 - 8 + (Math.PI / 2) * 4, 0.02));
});
