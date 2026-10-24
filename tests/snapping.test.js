import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alignmentSnap,
  pointSnap,
  unionBox,
  lines,
  boardBox,
} from "../src/snapping.js";

const box = (x, y, w, h, extra = {}) => ({ x, y, w, h, ...extra });

test("lines of a box are start, centre and end on each axis", () => {
  assert.deepEqual(lines(box(10, 20, 30, 40), "x"), [
    ["start", 10],
    ["center", 25],
    ["end", 40],
  ]);
  assert.deepEqual(lines(box(10, 20, 30, 40), "y"), [
    ["start", 20],
    ["center", 40],
    ["end", 60],
  ]);
  assert.deepEqual(unionBox([box(0, 0, 10, 10), box(5, -5, 10, 10)]), box(0, -5, 15, 15));
  assert.equal(unionBox([]), null);
});

test("centres, same edges and opposite edges snap within the threshold only", () => {
  const target = box(100, 100, 40, 20);
  // Centre to centre: moving centre at 120.4 → 120.
  let r = alignmentSnap(box(110.4, 50, 20, 10), [target], 1);
  assert.ok(Math.abs(r.dx - -0.4) < 1e-9);
  assert.equal(r.dy, null);
  // Left edge to left edge.
  r = alignmentSnap(box(100.7, 50, 10, 10), [target], 1);
  assert.ok(Math.abs(r.dx - -0.7) < 1e-9);
  // Right edge to right edge.
  r = alignmentSnap(box(129.5, 50, 10, 10), [target], 1);
  assert.ok(Math.abs(r.dx - 0.5) < 1e-9);
  // Left edge to the target's right edge (abutting).
  r = alignmentSnap(box(140.6, 50, 10, 10), [target], 1);
  assert.ok(Math.abs(r.dx - -0.6) < 1e-9);
  // Top to top and bottom to bottom.
  r = alignmentSnap(box(0, 100.3, 10, 10), [target], 1);
  assert.ok(Math.abs(r.dy - -0.3) < 1e-9 && r.dx === null);
  r = alignmentSnap(box(0, 109.2, 10, 10), [target], 1);
  assert.ok(Math.abs(r.dy - 0.8) < 1e-9);
  // Beyond the threshold nothing happens.
  r = alignmentSnap(box(103, 50, 10, 10), [target], 1);
  assert.equal(r.dx, null);
  assert.deepEqual(r.guides, []);
});

test("the nearest line wins and both axes snap independently", () => {
  const targets = [box(0, 0, 20, 20), box(50, 30, 20, 20)];
  // Moving centre at 10.9: centre of the first box (10) is 0.9 away, its end (20) 9.1 away.
  const r = alignmentSnap(box(0.9, 40.4, 20, 20), targets, 1);
  assert.ok(Math.abs(r.dx - -0.9) < 1e-9);
  // y: moving centre 50.4 vs second box centre 40 (too far); top 40.4 vs bottom of first (20) no; vs second top 30 no;
  // moving bottom 60.4 vs second bottom 50 no → only start 40.4 vs 40? second box centre is 40 → 0.4.
  assert.ok(Math.abs(r.dy - -0.4) < 1e-9);
});

test("guides describe the aligned lines and span both boxes", () => {
  const target = box(100, 100, 40, 20);
  const r = alignmentSnap(box(110.4, 50, 20, 10), [target, boardBox({ width: 250, height: 160 })], 1);
  assert.equal(r.guides.length, 1);
  const [g] = r.guides;
  assert.equal(g.axis, "x");
  assert.equal(g.kind, "center");
  assert.ok(Math.abs(g.value - 120) < 1e-9);
  assert.equal(g.from, 50);
  assert.equal(g.to, 120);
  assert.equal(g.board, false);
  // Board centre: the guide is flagged so it can be drawn across the board.
  const b = alignmentSnap(box(115.5, 0, 10, 10), [boardBox({ width: 240, height: 160 })], 1);
  assert.ok(Math.abs(b.dx - -0.5) < 1e-9);
  assert.equal(b.guides[0].board, true);
  assert.equal(b.guides[0].kind, "center");
  // A shift that aligns two lines at once yields one guide per distinct value.
  const twin = alignmentSnap(box(100.2, 100.2, 40, 20), [target], 1);
  assert.deepEqual(
    twin.guides.map((g) => [g.axis, g.kind]).sort(),
    [["x", "end"], ["x", "start"], ["x", "center"], ["y", "start"], ["y", "center"], ["y", "end"]].sort(),
  );
});

test("a resize corner snaps to lines as a point", () => {
  const p = pointSnap({ x: 139.6, y: 30 }, [box(100, 100, 40, 20)], 1);
  assert.ok(Math.abs(p.x - 140) < 1e-9 && p.snappedX && !p.snappedY && p.y === 30);
  assert.equal(p.guides.length, 1);
  const none = pointSnap({ x: 5, y: 5 }, [box(100, 100, 40, 20)], 1);
  assert.deepEqual([none.x, none.y, none.snappedX, none.snappedY], [5, 5, false, false]);
});
