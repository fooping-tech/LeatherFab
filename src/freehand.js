// Freehand strokes (stylus, finger or mouse) → clean Bézier paths.
//
// A stroke arrives as raw pointer samples in millimetres. Hand jitter is a
// property of the screen, not of the design, so every length below is set
// in screen pixels and scaled by `unit` (design mm per screen pixel at the
// zoom the stroke was drawn at). The stroke is resampled at a fixed spacing
// (so the result does not depend on the sampling rate of the device), its
// corners are found from the turning angle over a short window (a tight arc
// turns twice as much over a window twice as long, a corner does not), each
// run between corners is smoothed with a Gaussian kernel, and the runs are
// fitted with cubic curves (path.js). A stroke that ends near its start
// becomes a closed contour; overshoot past the start is trimmed.
import { fitStroke, pathContours, transformPath } from "./path.js";
import { bounds } from "./geometry.js";

export const FREEHAND_DEFAULTS = Object.freeze({
  smoothing: 3, // Gaussian sigma along the stroke, in screen pixels
  autoClose: true,
});
export const FREEHAND_LIMITS = Object.freeze({
  smoothing: { min: 0, max: 10 },
});
// The design millimetres one screen pixel covers when nothing says otherwise
// (a desktop at fit zoom).
export const DEFAULT_UNIT = 0.25;
// Screen-pixel constants, multiplied by `unit`.
const PX = Object.freeze({
  spacing: 0.5, // between resampled points
  minLength: 6, // shorter strokes are taps, not lines
  cornerWindow: 5, // on each side of a candidate corner
  closeGap: { min: 8, max: 40, ratio: 0.1 }, // of the stroke length
  closeSearch: { max: 60, ratio: 0.15 }, // head / tail searched for overlap
  tolerance: (sigma) => 0.4 + 0.2 * sigma, // fit error for a smoothing
  probe: (sigma) => Math.min(3, Math.max(1, sigma / 2)), // for corner search
});
const CORNER_ANGLE = (60 * Math.PI) / 180;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const finite = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const clampSigma = (v) =>
  Math.max(
    FREEHAND_LIMITS.smoothing.min,
    Math.min(FREEHAND_LIMITS.smoothing.max, Number(v) || 0),
  );

export function strokeLength(points) {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += dist(points[i - 1], points[i]);
  return n;
}
// Points every `spacing` mm along the polyline, plus its last point.
export function resample(points, spacing) {
  const src = points.filter(finite).map((p) => ({ x: p.x, y: p.y }));
  if (!src.length) return [];
  const out = [src[0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1],
      b = src[i],
      seg = dist(a, b);
    if (seg < 1e-9) continue;
    let along = spacing - carry;
    while (along <= seg) {
      const t = along / seg;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      along += spacing;
    }
    carry = seg - (along - spacing);
  }
  const last = src.at(-1);
  if (dist(out.at(-1), last) > spacing / 2) out.push(last);
  return out;
}
const angleAt = (pts, i, k, closed) => {
  const n = pts.length,
    at = (j) => pts[closed ? ((j % n) + n) % n : j];
  const p = at(i - k),
    q = at(i),
    r = at(i + k),
    ax = q.x - p.x,
    ay = q.y - p.y,
    bx = r.x - q.x,
    by = r.y - q.y,
    la = Math.hypot(ax, ay),
    lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
};
// Indices of the corners of a resampled stroke: the turning angle over
// ±window exceeds the threshold and does not keep growing over ±2 window
// (which is what an arc does). Neighbouring candidates keep the sharpest.
export function findCorners(pts, { closed = false, spacing, window }) {
  const n = pts.length,
    k = Math.max(1, Math.round(window / spacing));
  if (n < 2 * k + 1) return [];
  const candidates = [];
  for (let i = 0; i < n; i++) {
    if (!closed && (i < k || i > n - 1 - k)) continue;
    const a = angleAt(pts, i, k, closed);
    if (a <= CORNER_ANGLE) continue;
    const wide =
      closed || (i >= 2 * k && i <= n - 1 - 2 * k)
        ? angleAt(pts, i, 2 * k, closed)
        : null;
    if (wide !== null && wide > a * 1.5) continue;
    candidates.push([i, a]);
  }
  const corners = [];
  let run = [];
  const flush = () => {
    if (run.length)
      corners.push(run.reduce((best, c) => (c[1] > best[1] ? c : best))[0]);
    run = [];
  };
  for (const c of candidates) {
    if (run.length && c[0] - run.at(-1)[0] > k) flush();
    run.push(c);
  }
  flush();
  // On a loop the first and last runs may be one corner across the seam.
  if (closed && corners.length > 1 && corners[0] + n - corners.at(-1) <= k)
    corners.splice(
      angleAt(pts, corners[0], k, true) >= angleAt(pts, corners.at(-1), k, true)
        ? corners.length - 1
        : 0,
      1,
    );
  return corners;
}
// Gaussian smoothing along the polyline (sigma and spacing in mm). The first
// and last points stay (they are corners or stroke ends); a loop wraps.
export function smoothRun(pts, sigma, { closed = false, spacing }) {
  const n = pts.length;
  if (sigma <= 0 || n < 3) return pts.map((p) => ({ ...p }));
  const radius = Math.max(1, Math.ceil((3 * sigma) / spacing)),
    weights = [];
  for (let d = -radius; d <= radius; d++)
    weights.push(Math.exp(-((d * spacing) ** 2) / (2 * sigma * sigma)));
  return pts.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return { ...p };
    let x = 0,
      y = 0,
      sum = 0;
    for (let d = -radius; d <= radius; d++) {
      let j = i + d;
      if (closed) j = ((j % n) + n) % n;
      else j = Math.max(0, Math.min(n - 1, j));
      const w = weights[d + radius];
      x += pts[j].x * w;
      y += pts[j].y * w;
      sum += w;
    }
    return { x: x / sum, y: y / sum };
  });
}
// Where a stroke closes: the closest pair between its head and its tail,
// when that pair is within the closing gap. Returns [start, end] indices of
// the loop or null.
export function closure(pts, { spacing, unit = DEFAULT_UNIT }) {
  const n = pts.length,
    length = (n - 1) * spacing,
    gap = Math.max(
      PX.closeGap.min * unit,
      Math.min(PX.closeGap.max * unit, length * PX.closeGap.ratio),
    ),
    reach = Math.round(
      Math.min(PX.closeSearch.max * unit, length * PX.closeSearch.ratio) /
        spacing,
    );
  if (length < 3 * gap) return null;
  let best = null;
  for (let j = 0; j <= reach; j++)
    for (let i = n - 1; i >= n - 1 - reach; i--) {
      if (i - j < 3) continue;
      const d = dist(pts[j], pts[i]);
      if (d <= gap && (!best || d < best.d)) best = { d, j, i };
    }
  return best ? [best.j, best.i] : null;
}
// The screen-pixel settings scaled to design millimetres.
export function strokeScale({ smoothing, unit = DEFAULT_UNIT } = {}) {
  const sigmaPx = clampSigma(smoothing ?? FREEHAND_DEFAULTS.smoothing),
    u = Number.isFinite(unit) && unit > 0 ? unit : DEFAULT_UNIT;
  return {
    unit: u,
    spacing: PX.spacing * u,
    minLength: PX.minLength * u,
    window: PX.cornerWindow * u,
    sigma: sigmaPx * u,
    probe: PX.probe(sigmaPx) * u,
    error: PX.tolerance(sigmaPx) * u,
  };
}
// The fitted path of a stroke, or null when it is too short to be a line.
export function freehandPath(points, options = {}) {
  const { autoClose } = { ...FREEHAND_DEFAULTS, ...options },
    s = strokeScale(options);
  let pts = resample(points, s.spacing);
  if (pts.length < 2 || strokeLength(pts) < s.minLength) return null;
  let closed = false;
  if (autoClose) {
    const loop = closure(pts, { spacing: s.spacing, unit: s.unit });
    if (loop) {
      pts = pts.slice(loop[0], loop[1] + 1);
      closed = true;
      if (dist(pts[0], pts.at(-1)) < s.spacing / 2) pts.pop();
    }
  }
  // Corners are looked for on a lightly smoothed copy so that hand jitter
  // does not read as a row of corners; a real corner survives that much.
  const corners = findCorners(
    smoothRun(pts, s.probe, { closed, spacing: s.spacing }),
    { closed, spacing: s.spacing, window: s.window },
  );
  // A loop starts at its first corner so the seam is inside a smooth run.
  if (closed && corners.length) {
    const shift = corners[0];
    pts = [...pts.slice(shift), ...pts.slice(0, shift)];
    for (let c = 0; c < corners.length; c++) corners[c] -= shift;
  }
  // Each run between corners is smoothed on its own so corners stay put.
  let smoothed;
  if (closed && !corners.length)
    smoothed = smoothRun(pts, s.sigma, { closed: true, spacing: s.spacing });
  else {
    const stops = closed
      ? [...corners, pts.length]
      : [
          0,
          ...corners.filter((c) => c > 0 && c < pts.length - 1),
          pts.length - 1,
        ];
    smoothed = [];
    for (let k = 0; k + 1 < stops.length; k++) {
      const run = pts.slice(stops[k], Math.min(stops[k + 1], pts.length) + 1);
      if (stops[k + 1] === pts.length) run.push(pts[0]);
      smoothed.push(
        ...smoothRun(run, s.sigma, { spacing: s.spacing }).slice(0, -1),
      );
    }
    if (!closed) smoothed.push({ ...pts.at(-1) });
  }
  const path = fitStroke(smoothed, { closed, corners, error: s.error });
  return path.length ? { path, closed, corners: corners.length } : null;
}
// A fixed-path item at the stroke's own position, ready for the project,
// with whether the stroke closed; null when the stroke is too short.
export function freehandItem(points, options, { id, layerId, name } = {}) {
  const fit = freehandPath(points, options);
  if (!fit) return null;
  const world = pathContours(fit.path),
    box = bounds(world),
    path = transformPath(fit.path, (p) => ({ x: p.x - box.x, y: p.y - box.y }));
  return {
    item: {
      id,
      type: "outline",
      name: name ?? (fit.closed ? "フリーハンド" : "フリーハンド（線）"),
      x: box.x,
      y: box.y,
      rotation: 0,
      layerId,
      ratioLocked: false,
      path,
      contours: pathContours(path),
    },
    closed: fit.closed,
    corners: fit.corners,
  };
}
