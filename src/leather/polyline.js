// Polyline helpers for the leather layer (CAD Geometry Core). Everything is
// in millimetres. A polyline is an array of {x, y}; a closed one repeats its
// first point at the end (the TypeFab contour convention).
import ClipperLib from "clipper-lib";
import { offsetOpen } from "../cad.js";
import { signedArea } from "../polygon.js";

// Inward offset of closed rings with Clipper. The arc tolerance is 0.002 mm
// (ten times finer than the cut flattening): the inset ring is where hole
// tangents are measured, and coarse 13° facets on a 3 mm concave arc would
// tilt slanted holes by a few degrees and break mirror symmetry.
const SCALE = 10000,
  ARC_TOLERANCE = 0.002;
export function offsetClosed(contours, distance) {
  const paths = ClipperLib.Clipper.SimplifyPolygons(
    contours.map((c) => c.slice(0, -1).map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }))),
    ClipperLib.PolyFillType.pftNonZero,
  );
  const co = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE * SCALE);
  co.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, distance * SCALE);
  return out
    .filter((c) => c.length >= 3)
    .map((c) => {
      const pts = c.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));
      return [...pts, { ...pts[0] }];
    });
}

export const P = (x, y) => ({ x, y });
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const same = (a, b) => dist(a, b) < 1e-7;
export const isClosedPolyline = (c) => c.length > 2 && same(c[0], c.at(-1));
const DEG = 180 / Math.PI;

// Removes consecutive duplicates; keeps the closing point of a closed ring.
export function dedupe(points) {
  const out = [];
  for (const p of points) if (!out.length || !same(out.at(-1), p)) out.push(p);
  return out;
}
// Cumulative arc length at every vertex (first is 0).
export function cumulative(points) {
  const s = [0];
  for (let i = 1; i < points.length; i++) s.push(s[i - 1] + dist(points[i - 1], points[i]));
  return s;
}
export const totalLength = (points) => cumulative(points).at(-1) ?? 0;

// A sampled curve: the polyline with its cumulative lengths, closed flag and
// total length, so points and tangents can be looked up by arc length.
export function curve(points, closed = isClosedPolyline(points)) {
  const pts = dedupe(points);
  if (closed && pts.length > 1 && !same(pts[0], pts.at(-1))) pts.push({ ...pts[0] });
  const s = cumulative(pts);
  return { points: pts, s, closed, length: s.at(-1) ?? 0 };
}
function wrap(c, s) {
  if (!c.closed) return Math.max(0, Math.min(c.length, s));
  if (c.length <= 0) return 0;
  s %= c.length;
  return s < 0 ? s + c.length : s;
}
// Index i with s[i] <= s < s[i+1] (binary search).
function segmentIndex(c, s) {
  let lo = 0,
    hi = c.s.length - 2;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (c.s[m] <= s) lo = m;
    else hi = m - 1;
  }
  return lo;
}
export function pointAt(c, s) {
  if (c.points.length === 1) return { ...c.points[0] };
  s = wrap(c, s);
  const i = segmentIndex(c, s),
    a = c.points[i],
    b = c.points[i + 1],
    l = c.s[i + 1] - c.s[i],
    t = l > 0 ? (s - c.s[i]) / l : 0;
  return P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}
// Unit tangent by central difference over ±window (clamped at open ends), so
// the direction on a flattened curve does not jump from facet to facet.
export function tangentAt(c, s, window = 0.25) {
  if (c.length <= 0) return P(1, 0);
  const w = Math.min(window, c.length / 4);
  let s0 = s - w,
    s1 = s + w;
  if (!c.closed) {
    s0 = Math.max(0, s0);
    s1 = Math.min(c.length, s1);
  }
  const a = pointAt(c, s0),
    b = pointAt(c, s1),
    l = dist(a, b);
  return l > 1e-9 ? P((b.x - a.x) / l, (b.y - a.y) / l) : P(1, 0);
}
export const angleAt = (c, s, window) => {
  const t = tangentAt(c, s, window);
  return Math.atan2(t.y, t.x) * DEG;
};
// Vertices whose turning angle exceeds `minAngle` degrees: {s, index, angle}.
// Flattened arcs (0.02 mm tolerance, radius ≥ 0.5 mm) turn less than ~33° per
// vertex, so real corners stand out; the open ends are never corners.
export function corners(c, minAngle = 40) {
  const out = [],
    n = c.points.length;
  if (n < 3) return out;
  const last = c.closed ? n - 1 : n - 1; // exclusive upper vertex index
  for (let i = c.closed ? 0 : 1; i < last; i++) {
    const p = c.points[i === 0 ? n - 2 : i - 1],
      q = c.points[i],
      r = c.points[i + 1];
    const a1 = Math.atan2(q.y - p.y, q.x - p.x),
      a2 = Math.atan2(r.y - q.y, r.x - q.x);
    let d = ((a2 - a1) * DEG + 540) % 360 - 180;
    if (Math.abs(d) >= minAngle) out.push({ s: c.s[i], index: i, angle: d });
  }
  return out;
}
// The same closed curve starting at arc length s0 (direction kept).
export function rotateStart(c, s0) {
  if (!c.closed || c.length <= 0) return c;
  s0 = wrap(c, s0);
  if (s0 < 1e-9) return c;
  const i = segmentIndex(c, s0),
    start = pointAt(c, s0),
    pts = [start, ...c.points.slice(i + 1, -1), ...c.points.slice(0, i + 1), start];
  return curve(pts, true);
}
export function reverseCurve(c) {
  return curve([...c.points].reverse(), c.closed);
}
// Orientation of a closed ring: +1 counter-clockwise in screen coordinates
// (y down), i.e. negative signed area in the maths sense.
export const orientation = (points) => (signedArea(points) < 0 ? 1 : -1);

// Offsets a polyline by `distance` to the interior side of the shape it
// belongs to. Closed rings use Clipper (the largest resulting ring is kept;
// `null` when the ring collapses). Open polylines are shifted along the
// normal that points towards `inside`, a point known to lie inside the part.
// For an open run taken from a ring, pass `ring` (the whole closed outline)
// so the interior side is derived from its orientation, which is also right
// next to concave corners where a centroid test would fail.
export function offsetInward(points, distance, { closed = isClosedPolyline(points), inside = null, ring = null } = {}) {
  if (!(Math.abs(distance) > 1e-9)) return dedupe(points);
  if (closed) {
    const rings = offsetClosed([points], -Math.abs(distance));
    if (!rings.length) return null;
    let best = rings[0],
      area = Math.abs(signedArea(best));
    for (const r of rings) {
      const a = Math.abs(signedArea(r));
      if (a > area) {
        best = r;
        area = a;
      }
    }
    // Keep the traversal direction of the source ring.
    if (orientation(best) !== orientation(points)) best = [...best].reverse();
    return best;
  }
  let side = 1;
  if (ring) {
    // Shoelace sum > 0 (screen coordinates) means the interior lies on the
    // (-dy, dx) side of travel, which is offsetOpen's positive side.
    let sum = 0;
    for (let i = 1; i < ring.length; i++) sum += ring[i - 1].x * ring[i].y - ring[i].x * ring[i - 1].y;
    side = sum > 0 ? 1 : -1;
  } else if (inside) {
    const pts = dedupe(points);
    const a = pts[0],
      b = pts[Math.min(1, pts.length - 1)];
    const cross = (b.x - a.x) * (inside.y - a.y) - (b.y - a.y) * (inside.x - a.x);
    // offsetOpen's positive side is the normal (-dy, dx), which is where the
    // cross product is positive.
    side = cross >= 0 ? 1 : -1;
  }
  const out = offsetOpen(points, side * Math.abs(distance));
  return out.length >= 2 ? out : null;
}
// Distance from a point to a polyline (closed or open), and the nearest point.
export function nearestOnPolyline(points, p) {
  let best = { d: Infinity, point: null, index: 0, t: 0 };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      dx = b.x - a.x,
      dy = b.y - a.y,
      l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
    const q = P(a.x + dx * t, a.y + dy * t),
      d = dist(p, q);
    if (d < best.d) best = { d, point: q, index: i - 1, t };
  }
  return best;
}
// The part of a closed curve from arc length s0 forward to s1 (wrapping), as
// an open polyline that starts and ends exactly at those positions.
export function slice(c, s0, s1) {
  if (!c.closed || c.length <= 0) return c.points.slice();
  const a = ((s0 % c.length) + c.length) % c.length;
  let b = ((s1 % c.length) + c.length) % c.length;
  if (b <= a + 1e-9) b += c.length;
  const out = [pointAt(c, a)];
  // Walk the vertices forward from a, continuing past the ring's end.
  const n = c.s.length - 1; // vertex n equals vertex 0
  for (let lap = 0; lap < 2; lap++)
    for (let k = 0; k < n; k++) {
      const s = c.s[k] + lap * c.length;
      if (s > a + 1e-9 && s < b - 1e-9) out.push({ ...c.points[k] });
    }
  out.push(pointAt(c, b));
  return dedupe(out);
}
// Arc length on the curve of the point nearest to p.
export function nearestArcLength(c, p) {
  const hit = nearestOnPolyline(c.points, p);
  return c.s[hit.index] + hit.t * (c.s[hit.index + 1] - c.s[hit.index]);
}
