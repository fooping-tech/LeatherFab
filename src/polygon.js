import ClipperLib from "clipper-lib";
// Shared low-level polygon helpers (issue #5). Everything is in millimetres;
// Clipper works on integers scaled by SCALE, like the rest of the editor.
export const SCALE = 10000;
export const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-7;
export const isClosed = (c) => c.length > 3 && same(c[0], c.at(-1));
export const encode = (c) =>
  (isClosed(c) ? c.slice(0, -1) : c).map((p) => ({
    X: Math.round(p.x * SCALE),
    Y: Math.round(p.y * SCALE),
  }));
export function decode(path) {
  const ps = path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));
  return [...ps, { ...ps[0] }];
}
export function polygonArea(c) {
  return Math.abs(signedArea(c));
}
export function signedArea(c) {
  let s = 0;
  for (let i = 1; i < c.length; i++)
    s += c[i - 1].x * c[i].y - c[i].x * c[i - 1].y;
  return s / 2;
}
// Even-odd point test with the half-open rule, so a scanline through a
// vertex is counted once.
export function containsPoint(p, c) {
  let inside = false;
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1],
      b = c[i];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
// Nonzero union of closed contours as filled regions: each region is one
// outer contour with its holes. Material inside a hole (the centre of 回) is
// a region of its own. Open contours are ignored. With `strict` (the
// default) parts that only touch at a vertex stay separate polygons; it is
// costly on large inputs, so the result union of Smart Connect skips it.
export function unionRegions(contours, { fill: fillType = "nonzero", strict = true } = {}) {
  const closed = contours.filter(isClosed).map(encode).filter((c) => c.length >= 3);
  if (!closed.length) return [];
  const clipper = new ClipperLib.Clipper();
  clipper.StrictlySimple = strict;
  clipper.AddPaths(closed, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree(),
    fill =
      fillType === "evenodd"
        ? ClipperLib.PolyFillType.pftEvenOdd
        : ClipperLib.PolyFillType.pftNonZero;
  if (!clipper.Execute(ClipperLib.ClipType.ctUnion, tree, fill, fill))
    throw Error("輪郭の合成に失敗しました。");
  const regions = [];
  const walk = (node) => {
    for (const outer of node.Childs()) {
      const contour = outer.Contour();
      if (contour.length >= 3)
        regions.push({
          outer: decode(contour),
          holes: outer
            .Childs()
            .map((hole) => hole.Contour())
            .filter((c) => c.length >= 3)
            .map(decode),
        });
      for (const hole of outer.Childs()) walk(hole);
    }
  };
  walk(tree);
  return regions;
}
// Flat list of closed contours (outers and holes) of the union.
export const unionContours = (contours) =>
  unionRegions(contours).flatMap((r) => [r.outer, ...r.holes]);
// Area of the overlap of two sets of closed contours, in mm².
export function intersectionArea(a, b) {
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(a.filter(isClosed).map(encode), ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(b.filter(isClosed).map(encode), ClipperLib.PolyType.ptClip, true);
  const out = [];
  clipper.Execute(
    ClipperLib.ClipType.ctIntersection,
    out,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  );
  return out.reduce((n, c) => n + Math.abs(ClipperLib.Clipper.Area(c)), 0) / (SCALE * SCALE);
}
// A point strictly inside a region: the midpoint between the first two
// crossings of a horizontal scanline through the outer contour.
export function interiorPoint(region) {
  const all = [region.outer, ...region.holes];
  let ys = region.outer.map((p) => p.y),
    lo = Math.min(...ys),
    hi = Math.max(...ys);
  for (const f of [0.5, 0.37, 0.63, 0.25, 0.75, 0.13, 0.87]) {
    const y = lo + (hi - lo) * f,
      xs = [];
    for (const c of all)
      for (let i = 1; i < c.length; i++) {
        const a = c[i - 1],
          b = c[i];
        if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2)
      if (xs[i + 1] - xs[i] > 1e-6) {
        const p = { x: (xs[i] + xs[i + 1]) / 2, y };
        if (containsPoint(p, region.outer) && !region.holes.some((h) => containsPoint(p, h)))
          return p;
      }
  }
  return { ...region.outer[0] };
}
// Whether the point lies inside the region (outer minus holes).
export const regionContains = (region, p) =>
  containsPoint(p, region.outer) && !region.holes.some((h) => containsPoint(p, h));
// Offsets an open polyline into a band of the given width with Clipper.
export function bandAround(points, width, ends = "butt") {
  const pts = points.filter((p, i) => !i || !same(p, points[i - 1]));
  if (pts.length < 2 || !(width > 0)) return [];
  const co = new ClipperLib.ClipperOffset(2, 0.02 * SCALE);
  co.AddPath(
    pts.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })),
    ClipperLib.JoinType.jtRound,
    ends === "round" ? ClipperLib.EndType.etOpenRound : ClipperLib.EndType.etOpenButt,
  );
  const out = new ClipperLib.Paths();
  co.Execute(out, (width / 2) * SCALE);
  return out.filter((c) => c.length >= 3).map(decode);
}
export function segmentsIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d,
    u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}
// Offsets closed contours (holes included); positive grows, negative erodes.
export function offsetContours(contours, distance, join = "miter") {
  const paths = ClipperLib.Clipper.SimplifyPolygons(
    contours.filter(isClosed).map(encode),
    ClipperLib.PolyFillType.pftNonZero,
  );
  const co = new ClipperLib.ClipperOffset(2, 0.02 * SCALE);
  co.AddPaths(
    paths,
    join === "round" ? ClipperLib.JoinType.jtRound : ClipperLib.JoinType.jtMiter,
    ClipperLib.EndType.etClosedPolygon,
  );
  const out = new ClipperLib.Paths();
  co.Execute(out, distance * SCALE);
  return out.filter((c) => c.length >= 3).map(decode);
}
