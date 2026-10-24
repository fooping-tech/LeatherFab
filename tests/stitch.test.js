import { test } from "node:test";
import assert from "node:assert/strict";
import { placeHoles, holeContour, normalizePattern, DEFAULT_PATTERN, spiOf } from "../src/leather/stitch.js";
import { curve, corners, offsetInward, pointAt, tangentAt, totalLength } from "../src/leather/polyline.js";
import { shapeContours, flatten } from "../src/geometry.js";
import { pathContours, shapePath } from "../src/path.js";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const chords = (holes, closed) => {
  const out = holes.slice(1).map((h, i) => d(holes[i], h));
  if (closed) out.push(d(holes.at(-1), holes[0]));
  return out;
};
const line = (len) => [{ x: 0, y: 0 }, { x: len, y: 0 }];
const circle = (r, n = 720) => {
  const pts = Array.from({ length: n }, (_, i) => ({ x: r * Math.cos((2 * Math.PI * i) / n), y: r * Math.sin((2 * Math.PI * i) / n) }));
  return [...pts, { ...pts[0] }];
};
const square = (s) => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }, { x: 0, y: 0 }];

test("polyline: arc-length lookup, tangents and corner detection", () => {
  const c = curve(square(10), true);
  assert.equal(c.length, 40);
  assert.deepEqual(pointAt(c, 15), { x: 10, y: 5 });
  assert.deepEqual(pointAt(c, 45), { x: 5, y: 0 });
  const t = tangentAt(c, 5);
  assert.ok(close(t.x, 1) && close(t.y, 0));
  const ks = corners(c);
  assert.deepEqual(ks.map((k) => k.s), [0, 10, 20, 30]);
  assert.equal(corners(curve(circle(10), true)).length, 0, "a circle has no corners");
  const rr = curve(pathContours(shapePath("rect", 30, 20, 3))[0], true);
  assert.equal(corners(rr).length, 0, "a 3 mm fillet is not a corner at 0.02 mm flattening");
  assert.equal(corners(curve(line(10), false)).length, 0);
});

test("offsetInward: closed rings shrink and keep direction; open lines move towards the inside point", () => {
  const sq = square(20);
  const inner = offsetInward(sq, 3);
  assert.ok(inner && close(totalLength(inner), 56, 1e-6));
  assert.equal(offsetInward(sq, 11), null, "collapses");
  const edge = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
  const off = offsetInward(edge, 3, { closed: false, inside: { x: 10, y: 10 } });
  assert.ok(close(off[0].y, 3) && close(off[1].y, 3));
  const off2 = offsetInward(edge, 3, { closed: false, inside: { x: 10, y: -10 } });
  assert.ok(close(off2[0].y, -3));
});

test("straight line, arc fit: holes at both ends, equal pitch near the target", () => {
  const r = placeHoles(line(100), { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc", fit: "fit" }, { closed: false });
  assert.equal(r.holes.length, 26);
  assert.ok(close(r.holes[0].x, 0) && close(r.holes.at(-1).x, 100));
  for (const c of chords(r.holes)) assert.ok(close(c, 4, 1e-9));
  assert.equal(r.warnings.length, 0);
  const r2 = placeHoles(line(98), { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc" }, { closed: false });
  assert.equal(r2.holes.length, 26, "98 / 4 = 24.5 → rounds to 25 segments at 3.92 mm");
  assert.ok(close(r2.pitch.mean, 3.92, 1e-9));
  assert.equal(r2.spans[0].segments, 25);
});

test("straight line, fixed pitch: exact pitch with the remainder at the end", () => {
  const r = placeHoles(line(98), { ...DEFAULT_PATTERN, pitch: 4, fit: "fixed", spacing: "arc" }, { closed: false });
  const cs = chords(r.holes);
  for (const c of cs.slice(0, -1)) assert.ok(close(c, 4, 1e-9));
  assert.ok(cs.at(-1) <= 4 + 1e-9 && cs.at(-1) >= 2 - 1e-9);
  assert.ok(close(r.holes.at(-1).x, 98));
});

test("circle: arc spacing is equal in arc, chord spacing is equal in chord — and they differ", () => {
  const ring = circle(10); // circumference 62.83
  const arc = placeHoles(ring, { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc" });
  assert.equal(arc.holes.length, 16);
  for (const c of chords(arc.holes, true)) assert.ok(close(c, 2 * 10 * Math.sin(Math.PI / 16), 1e-3));
  const chord = placeHoles(ring, { ...DEFAULT_PATTERN, pitch: 4, spacing: "chord" });
  assert.equal(chord.holes.length, 16);
  for (const c of chords(chord.holes, true)) assert.ok(close(c, 3.9018, 2e-3), `chord ${c}`);
  // Tighter curve: chord of a 4 mm arc on r = 3 is noticeably shorter than 4.
  const tight = circle(3);
  const a2 = placeHoles(tight, { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc" });
  const c2 = placeHoles(tight, { ...DEFAULT_PATTERN, pitch: 4, spacing: "chord" });
  assert.equal(a2.holes.length, c2.holes.length, 5);
  assert.ok(chords(a2.holes, true)[0] < 3.6, "arc pitch 3.77 gives chord " + chords(a2.holes, true)[0]);
  assert.ok(chords(c2.holes, true).every((c) => close(c, c2.pitch.mean, 1e-3)));
});

test("closed loop start offset and reverse", () => {
  const ring = circle(10);
  const base = placeHoles(ring, { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc" });
  const shifted = placeHoles(ring, { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc", startOffset: 2 });
  assert.ok(close(shifted.holes[0].s, 0) && close(d(shifted.holes[0], pointAt(curve(ring, true), 2)), 0, 1e-6));
  assert.ok(!close(base.holes[0].x, shifted.holes[0].x, 1e-3));
  const rev = placeHoles(ring, { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc", reverse: true });
  assert.equal(rev.holes.length, 16);
  // Reversed traversal flips the tangent by 180° and the slant with it.
  const fwd = base.holes[0], back = rev.holes[0];
  assert.ok(close(((fwd.tangent - back.tangent) % 360 + 360) % 360, 180, 1e-6));
  // As an undirected slit the reversed slant is mirrored: it differs by 2 × angle.
  assert.ok(close((((fwd.angle - back.angle) % 180) + 180) % 180, 2 * DEFAULT_PATTERN.angle, 1e-6));
});

test("square: one hole on every corner, symmetric spans, equal counts per side", () => {
  const r = placeHoles(square(40), { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc", corner: "apex" });
  assert.equal(r.corners, 4);
  const cornerHoles = r.holes.filter((h) => h.anchor === "corner");
  assert.equal(cornerHoles.length, 4);
  assert.equal(r.holes.length, 40, "10 segments per side, corners shared");
  for (const c of chords(r.holes, true)) assert.ok(close(c, 4, 1e-9));
  // Straddle: no hole on the apex, pairs at ±2 mm.
  const s = placeHoles(square(40), { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc", corner: "straddle" });
  assert.ok(!s.holes.some((h) => (close(h.x, 0) || close(h.x, 40)) && (close(h.y, 0) || close(h.y, 40))), "no apex holes");
  assert.ok(s.holes.some((h) => close(h.x, 2) && close(h.y, 0)) && s.holes.some((h) => close(h.x, 0) && close(h.y, 2)));
  // Symmetry about the diagonal: mirror every hole (x,y)→(y,x) and find it.
  for (const h of s.holes) assert.ok(s.holes.some((g) => close(g.x, h.y, 1e-6) && close(g.y, h.x, 1e-6)), `mirror of ${h.x},${h.y}`);
  const none = placeHoles(square(40), { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc", corner: "none" });
  assert.equal(none.corners, 0);
  assert.equal(none.holes.length, 40);
});

test("auto corner mode picks per corner and never crams tight corners", () => {
  // A 10 mm square: corners 10 mm apart, pitch 4 → apex gives 2.5 segments
  // (dev 20%), straddle gives (10-4)/4 = 1.5 → both poor; apex chosen for 90°.
  const r = placeHoles(square(10), { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc", corner: "auto" });
  assert.equal(r.holes.filter((h) => h.anchor === "corner").length, 4);
  // Shallow corner (≈53°) on a long polyline: auto may straddle.
  const bent = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 70, y: 40 }];
  const b = placeHoles(bent, { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc", corner: "auto" }, { closed: false });
  assert.ok(b.holes.length > 20);
  assert.ok(b.holes.every((h, i) => i === 0 || d(h, b.holes[i - 1]) > 2), "no overlaps");
});

test("rounded rectangle (Bézier corners): holes stay on the curve, count follows length", () => {
  const ring = pathContours(shapePath("rect", 60, 40, 8))[0];
  const L = totalLength(ring);
  const r = placeHoles(ring, { ...DEFAULT_PATTERN, pitch: 3.85, spacing: "chord" });
  assert.equal(r.corners, 0);
  assert.equal(r.holes.length, Math.round(L / 3.85));
  const c = curve(ring, true);
  for (const h of r.holes) assert.ok(d(h, pointAt(c, h.s)) < 1e-9);
  const cs = chords(r.holes, true);
  assert.ok(Math.max(...cs) - Math.min(...cs) < 0.02, `chords uniform ${Math.min(...cs)}–${Math.max(...cs)}`);
  // Straight portion holes point along x; the hole orientation adds the slant.
  const straight = r.holes.find((h) => h.x > 20 && h.x < 40 && h.y < 1);
  assert.ok(close(Math.abs(straight.tangent % 180), 0, 0.5));
  assert.ok(close(straight.angle - straight.tangent, 30, 1e-9));
});

test("concave shape (L) and a sharp 30° V: corners kept, no duplicate holes", () => {
  const L = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 40 }, { x: 0, y: 40 }, { x: 0, y: 0 }];
  const r = placeHoles(L, { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc" });
  assert.equal(r.corners, 6);
  assert.ok(r.holes.some((h) => close(h.x, 20) && close(h.y, 20)), "concave corner has a hole");
  const seen = new Set();
  for (const h of r.holes) {
    const k = `${h.x.toFixed(4)},${h.y.toFixed(4)}`;
    assert.ok(!seen.has(k), "duplicate hole " + k);
    seen.add(k);
  }
  const v = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 * Math.tan(Math.PI / 6) }];
  const rv = placeHoles(v, { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc", corner: "auto" }, { closed: false });
  assert.ok(rv.holes.some((h) => close(h.x, 40) && close(h.y, 0)), "sharp apex hole");
  assert.ok(rv.holes.every((h, i) => i === 0 || d(h, rv.holes[i - 1]) > 1.5));
});

test("count mode: exactly N holes on a loop, and distributed over spans", () => {
  const r = placeHoles(circle(10), { ...DEFAULT_PATTERN, fit: "count", count: 20, spacing: "arc" });
  assert.equal(r.holes.length, 20);
  const s = placeHoles(square(40), { ...DEFAULT_PATTERN, fit: "count", count: 44, spacing: "arc", corner: "apex" });
  assert.equal(s.holes.length, 44);
  const o = placeHoles(line(50), { ...DEFAULT_PATTERN, fit: "count", count: 11, spacing: "arc" }, { closed: false });
  assert.equal(o.holes.length, 11);
  for (const c of chords(o.holes)) assert.ok(close(c, 5, 1e-9));
});

test("margins on open lines and deviation warnings", () => {
  const r = placeHoles(line(50), { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc", startMargin: 3, endMargin: 5 }, { closed: false });
  assert.ok(close(r.holes[0].x, 3) && close(r.holes.at(-1).x, 45));
  const w = placeHoles(line(6), { ...DEFAULT_PATTERN, pitch: 4, spacing: "arc" }, { closed: false });
  assert.ok(w.warnings.some((m) => m.includes("ずれ")), w.warnings.join());
});

test("hole contours: shapes, size and orientation; mirror flips the slant", () => {
  const hole = { x: 10, y: 10, tangent: 0, angle: 30 };
  const round = holeContour(hole, { shape: "round", width: 1 });
  for (const p of round.slice(0, -1)) assert.ok(close(d(p, hole), 0.5, 1e-9));
  const dia = holeContour(hole, { shape: "diamond", width: 0.6, length: 2, angle: 30 });
  assert.equal(dia.length, 5);
  assert.ok(close(d(dia[0], dia[2]), 2) && close(d(dia[1], dia[3]), 0.6));
  assert.ok(close(Math.atan2(dia[0].y - hole.y, dia[0].x - hole.x), Math.PI / 6, 1e-9), "long axis at 30°");
  const fr = holeContour(hole, { shape: "french", width: 0.5, length: 2.4 });
  assert.ok(fr.every((p) => d(p, hole) <= 1.2 + 1e-9));
  const flat = holeContour({ ...hole, angle: 0 }, { shape: "flat", width: 0.5, length: 2 });
  assert.ok(close(Math.max(...flat.map((p) => p.x)) - Math.min(...flat.map((p) => p.x)), 2));
  const a = placeHoles(line(20), { ...DEFAULT_PATTERN, spacing: "arc" }, { closed: false }).holes[1];
  const b = placeHoles(line(20), { ...DEFAULT_PATTERN, spacing: "arc", flip: true }, { closed: false }).holes[1];
  assert.ok(close(a.angle, 30) && close(b.angle, -30));
});

test("pattern normalisation and SPI", () => {
  const p = normalizePattern({ shape: "bogus", pitch: 1000, count: -3 });
  assert.equal(p.shape, "diamond");
  assert.equal(p.pitch, 50);
  assert.equal(p.count, 0);
  assert.ok(close(spiOf(3.85), 6.597, 1e-3));
});

test("determinism: same input → identical output", () => {
  const ring = pathContours(shapePath("rect", 60, 40, 8))[0];
  const a = JSON.stringify(placeHoles(ring, DEFAULT_PATTERN));
  const b = JSON.stringify(placeHoles(structuredClone(ring), { ...DEFAULT_PATTERN }));
  assert.equal(a, b);
});
