import { TOLERANCE, shapeContours, bounds } from "./geometry.js";
// A warp envelope is 12 points running clockwise around the text's unwarped
// bounds, in units of that box (0..1): corners 0 TL, 3 TR, 6 BR, 9 BL, and two
// Bézier handles between each pair. Each side is an independent cubic curve.
export const CORNERS = [0, 3, 6, 9];
export const WARP_PRESETS = [
  ["arcUp", "Arc Up", "上弧"],
  ["arcDown", "Arc Down", "下弧"],
  ["arch", "Arch", "アーチ"],
  ["bulge", "Bulge", "膨張"],
  ["wave", "Wave", "波形"],
  ["flag", "Flag", "旗"],
  ["fish", "Fish", "魚形"],
  ["perspective", "Perspective", "遠近"],
];
export function flatEnvelope() {
  return [
    [0, 0],
    [1 / 3, 0],
    [2 / 3, 0],
    [1, 0],
    [1, 1 / 3],
    [1, 2 / 3],
    [1, 1],
    [2 / 3, 1],
    [1 / 3, 1],
    [0, 1],
    [0, 2 / 3],
    [0, 1 / 3],
  ].map(([x, y]) => ({ x, y }));
}
// Handles one third of the way along a straight side.
function straighten(e, a, h1, h2, b) {
  e[h1] = {
    x: e[a].x + (e[b].x - e[a].x) / 3,
    y: e[a].y + (e[b].y - e[a].y) / 3,
  };
  e[h2] = {
    x: e[a].x + ((e[b].x - e[a].x) * 2) / 3,
    y: e[a].y + ((e[b].y - e[a].y) * 2) / 3,
  };
}
// bend is -1..1 (±100 %). Curved sides move their midpoint by the given
// fraction of the text height (a cubic's midpoint moves 3/4 of its handles).
// Arch bends relative to the width so long lines visibly arch.
export function presetEnvelope(name, bend = 0.5, aspect = 1) {
  const e = flatEnvelope(),
    b = Math.max(-1, Math.min(1, bend)),
    lift = (i, d) => (e[i].y -= d),
    mid = (d) => (d * 4) / 3;
  if (name === "arcUp") [1, 2].forEach((i) => lift(i, mid(b)));
  else if (name === "arcDown") [7, 8].forEach((i) => lift(i, -mid(b)));
  else if (name === "bulge") {
    [1, 2].forEach((i) => lift(i, mid(b)));
    [7, 8].forEach((i) => lift(i, -mid(b)));
  } else if (name === "arch")
    [1, 2, 7, 8].forEach((i) => lift(i, mid(b * 0.25 * aspect)));
  else if (name === "flag" || name === "wave") {
    // Top and bottom as S-curves: in phase for a flag, opposite for a wave.
    const k = 2 * b,
      phase = name === "flag" ? 1 : -1;
    lift(1, k);
    lift(2, -k);
    lift(8, k * phase);
    lift(7, -k * phase);
  } else if (name === "fish") {
    const d = mid(b * 0.8);
    lift(1, d);
    lift(2, d * 0.6);
    lift(8, -d);
    lift(7, -d * 0.6);
    e[3].y += 0.3 * b;
    e[6].y -= 0.3 * b;
    straighten(e, 3, 4, 5, 6);
  } else if (name === "perspective") {
    e[3].y -= 0.5 * b;
    e[6].y += 0.5 * b;
    straighten(e, 0, 1, 2, 3);
    straighten(e, 3, 4, 5, 6);
    straighten(e, 6, 7, 8, 9);
  } else if (name !== "none") throw Error("不明なワーププリセットです。");
  return e;
}
const cubic = (a, b, c, d, t) => {
  const s = 1 - t;
  return {
    x:
      s * s * s * a.x +
      3 * s * s * t * b.x +
      3 * s * t * t * c.x +
      t * t * t * d.x,
    y:
      s * s * s * a.y +
      3 * s * s * t * b.y +
      3 * s * t * t * c.y +
      t * t * t * d.y,
  };
};
// Coons patch: blends the four side curves so each side maps exactly onto
// its curve and a flat envelope is the identity.
export function coons(e, u, v) {
  const top = cubic(e[0], e[1], e[2], e[3], u),
    bottom = cubic(e[9], e[8], e[7], e[6], u),
    left = cubic(e[0], e[11], e[10], e[9], v),
    right = cubic(e[3], e[4], e[5], e[6], v);
  const corner = (k) =>
    (1 - u) * (1 - v) * e[0][k] +
    u * (1 - v) * e[3][k] +
    (1 - u) * v * e[9][k] +
    u * v * e[6][k];
  return {
    x:
      (1 - v) * top.x +
      v * bottom.x +
      (1 - u) * left.x +
      u * right.x -
      corner("x"),
    y:
      (1 - v) * top.y +
      v * bottom.y +
      (1 - u) * left.y +
      u * right.y -
      corner("y"),
  };
}
export function isFlat(e) {
  return flatEnvelope().every(
    (p, i) => Math.abs(p.x - e[i].x) < 1e-9 && Math.abs(p.y - e[i].y) < 1e-9,
  );
}
function gap(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    l = dx * dx + dy * dy,
    t = l
      ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l))
      : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
// Maps contours (local mm) through the envelope placed on box. Segments are
// split until the mapped polyline stays within TOLERANCE of the mapped curve.
export function warpContours(contours, box, envelope) {
  const w = box.w || 1e-9,
    h = box.h || 1e-9;
  const map = (p) => {
    const s = coons(envelope, (p.x - box.x) / w, (p.y - box.y) / h);
    return { x: box.x + s.x * w, y: box.y + s.y * h };
  };
  const lerp = (a, b, t) => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  const segment = (a, b, ma, mb, out, depth) => {
    if (
      depth < 12 &&
      [0.25, 0.5, 0.75].some((t) => gap(map(lerp(a, b, t)), ma, mb) > TOLERANCE)
    ) {
      const m = lerp(a, b, 0.5),
        mm = map(m);
      segment(a, m, ma, mm, out, depth + 1);
      segment(m, b, mm, mb, out, depth + 1);
    } else out.push(mb);
  };
  return contours.map((c) => {
    const out = [map(c[0])];
    for (let i = 1; i < c.length; i++)
      segment(c[i - 1], c[i], out.at(-1), map(c[i]), out, 0);
    return out;
  });
}
// Items that can carry a warp. A line has no area to put an envelope on.
export const WARPABLE = ["text", "rect", "circle", "outline"];
// Unwarped outline of a shape: rectangles and ellipses are rebuilt from their
// dimensions, fixed paths keep theirs in warp.source. (Text needs its font;
// see layoutText.)
export function shapeSource(item) {
  if (["rect", "circle", "line"].includes(item.type))
    return shapeContours(item.type, item.w, item.h, item.radius);
  return item.warp?.source ?? item.contours;
}
export function applyWarp(item, source) {
  return item.warp
    ? warpContours(source, bounds(source), item.warp.envelope)
    : source;
}
