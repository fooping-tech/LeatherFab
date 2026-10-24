// Stitch hole engine (Leather Domain Core). Pure functions, no UI: given a
// sampled stitch line (see polyline.js) and a StitchPattern, place holes and
// report the achieved pitch. Arc length and chord length are treated as
// distinct: `spacing: "arc"` measures along the curve, `spacing: "chord"`
// measures the straight distance between neighbouring holes (what a pricking
// iron actually spans). Deterministic: the same curve and pattern always give
// the same holes.
import { curve, pointAt, tangentAt, corners as findCorners, rotateStart, reverseCurve, dist, P } from "./polyline.js";

export const HOLE_SHAPES = Object.freeze({
  round: { label: "丸穴", width: 1.0, length: 1.0, angle: 0 },
  diamond: { label: "菱目", width: 0.6, length: 2.0, angle: 30 },
  french: { label: "フレンチ（斜めスロット）", width: 0.5, length: 2.4, angle: 15 },
  slit: { label: "斜めスリット", width: 0.3, length: 2.0, angle: 45 },
  flat: { label: "平目（線に沿う）", width: 0.5, length: 2.0, angle: 0 },
});
export const SPACINGS = Object.freeze({ arc: "一定弧長ピッチ", chord: "一定弦長ピッチ" });
export const FITS = Object.freeze({ fit: "自動フィット", fixed: "ピッチ固定（余りは末尾）", count: "穴数優先" });
export const CORNER_MODES = Object.freeze({ auto: "自動", apex: "角に穴", straddle: "角をまたぐ対称配置", none: "角を無視" });
// Common pricking iron pitches (mm) offered as presets; SPI = 25.4 / pitch.
export const PITCH_PRESETS = Object.freeze([2.7, 3.0, 3.38, 3.85, 4.0, 4.5, 5.0]);
export const spiOf = (pitch) => 25.4 / pitch;

export const DEFAULT_PATTERN = Object.freeze({
  shape: "diamond",
  pitch: 4,
  width: HOLE_SHAPES.diamond.width,
  length: HOLE_SHAPES.diamond.length,
  angle: HOLE_SHAPES.diamond.angle,
  spacing: "chord",
  fit: "fit",
  count: 0,
  corner: "auto",
  cornerAngle: 40,
  startOffset: 0,
  startMargin: 0,
  endMargin: 0,
  reverse: false,
  flip: false,
  maxDeviation: 0.12,
});
export const PATTERN_LIMITS = Object.freeze({
  pitch: [0.5, 50],
  width: [0.1, 10],
  length: [0.1, 20],
  angle: [-90, 90],
  count: [0, 5000],
  cornerAngle: [10, 170],
  startOffset: [-10000, 10000],
  startMargin: [0, 1000],
  endMargin: [0, 1000],
  maxDeviation: [0, 0.5],
});
const clamp = (v, [lo, hi], fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
export function normalizePattern(p = {}) {
  const shape = p.shape in HOLE_SHAPES ? p.shape : DEFAULT_PATTERN.shape;
  const base = HOLE_SHAPES[shape];
  return {
    shape,
    pitch: clamp(p.pitch, PATTERN_LIMITS.pitch, DEFAULT_PATTERN.pitch),
    width: clamp(p.width, PATTERN_LIMITS.width, base.width),
    length: clamp(p.length, PATTERN_LIMITS.length, base.length),
    angle: clamp(p.angle, PATTERN_LIMITS.angle, base.angle),
    spacing: p.spacing in SPACINGS ? p.spacing : DEFAULT_PATTERN.spacing,
    fit: p.fit in FITS ? p.fit : DEFAULT_PATTERN.fit,
    count: Math.round(clamp(p.count, PATTERN_LIMITS.count, 0)),
    corner: p.corner in CORNER_MODES ? p.corner : DEFAULT_PATTERN.corner,
    cornerAngle: clamp(p.cornerAngle, PATTERN_LIMITS.cornerAngle, DEFAULT_PATTERN.cornerAngle),
    startOffset: clamp(p.startOffset, PATTERN_LIMITS.startOffset, 0),
    startMargin: clamp(p.startMargin, PATTERN_LIMITS.startMargin, 0),
    endMargin: clamp(p.endMargin, PATTERN_LIMITS.endMargin, 0),
    reverse: Boolean(p.reverse),
    flip: Boolean(p.flip),
    maxDeviation: clamp(p.maxDeviation, PATTERN_LIMITS.maxDeviation, DEFAULT_PATTERN.maxDeviation),
  };
}

// ---------------------------------------------------------------- spans
// Arc positions of n+1 points from s0 to s1 (inclusive) at equal arc pitch.
function arcPositions(s0, s1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(s0 + ((s1 - s0) * i) / n);
  return out;
}
// Arc position reached from s by marching a straight chord of length c along
// the curve (never more than `limit`), or null when the chord does not reach.
function marchChord(c, s, chord, limit) {
  const from = pointAt(c, s);
  let lo = s,
    hi = Math.min(s + chord, limit);
  // The chord grows monotonically with arc length over one step as long as
  // the curve does not fold back within a chord; sample to find the bracket.
  const steps = 16;
  let found = null;
  for (let k = 1; k <= steps; k++) {
    const t = s + ((limit - s) * k) / steps;
    if (dist(from, pointAt(c, t)) >= chord) {
      found = t;
      hi = t;
      lo = s + ((limit - s) * (k - 1)) / steps;
      break;
    }
  }
  if (found === null) return null;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (dist(from, pointAt(c, m)) >= chord) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}
// n chords of equal length from s0 to s1 exactly: the chord length is solved
// by bisection so the last hole lands on s1. Falls back to arc spacing when
// the curve folds back within a chord.
function chordPositions(c, s0, s1, n) {
  if (n <= 1) return [s0, s1];
  const arc = (s1 - s0) / n;
  let lo = arc * 0.3,
    hi = arc;
  const landing = (chord) => {
    let s = s0;
    for (let i = 0; i < n; i++) {
      const next = marchChord(c, s, chord, s1 + 1e-9);
      if (next === null) return Infinity;
      s = next;
    }
    return s;
  };
  const positions = (chord) => {
    const out = [s0];
    let s = s0;
    for (let i = 0; i < n - 1; i++) {
      const next = marchChord(c, s, chord, s1);
      if (next === null) return null;
      out.push(next);
      s = next;
    }
    out.push(s1);
    return out;
  };
  if (!(landing(lo) < s1)) return arcPositions(s0, s1, n);
  for (let k = 0; k < 50; k++) {
    const m = (lo + hi) / 2;
    if (landing(m) >= s1 - 1e-9) hi = m;
    else lo = m;
  }
  return positions((lo + hi) / 2) ?? arcPositions(s0, s1, n);
}
// Positions at an exact pitch from s0; the remainder stays before s1.
function fixedPositions(c, s0, s1, pitch, spacing) {
  const out = [s0];
  let s = s0;
  for (let guard = 0; guard < 100000; guard++) {
    const next = spacing === "chord" ? marchChord(c, s, pitch, s1) : s + pitch;
    if (next === null || next > s1 - pitch * 0.5 + 1e-9) break;
    out.push(next);
    s = next;
  }
  out.push(s1);
  return out;
}
// Largest-remainder allocation of `total` holes over spans by length (≥ 1 each).
function allocate(lengths, total) {
  const sum = lengths.reduce((a, b) => a + b, 0) || 1;
  const raw = lengths.map((l) => Math.max(1, (total * l) / sum)),
    n = raw.map(Math.floor);
  let left = total - n.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    n[i]++;
    left--;
  }
  return n.map((v) => Math.max(1, v));
}

// ---------------------------------------------------------------- placement
// Places holes along `points` (a polyline, closed or open). Returns
// { holes, spans, length, closed, pitch: {target, min, max, mean}, warnings }.
// Every hole is { x, y, s, tangent (deg), angle (deg, hole orientation),
// anchor: "corner" | "end" | null }.
export function placeHoles(points, patternIn, { closed = undefined } = {}) {
  const pattern = normalizePattern(patternIn);
  const warnings = [];
  let c = curve(points, closed);
  if (c.points.length < 2 || c.length < 1e-6)
    return { holes: [], spans: [], length: 0, closed: Boolean(c.closed), pitch: { target: pattern.pitch }, warnings: ["縫い線の長さが0です。"] };
  if (pattern.reverse) c = reverseCurve(c);
  if (c.closed && pattern.startOffset) c = rotateStart(c, pattern.startOffset);
  const p = pattern.pitch;
  // Anchors: the open ends (after margins) and the corners.
  let lo = 0,
    hi = c.length;
  if (!c.closed) {
    lo = Math.min(pattern.startMargin, c.length / 2);
    hi = Math.max(lo, c.length - Math.min(pattern.endMargin, c.length / 2));
  }
  const cornerList = pattern.corner === "none" ? [] : findCorners(c, pattern.cornerAngle).filter((k) => c.closed || (k.s > lo + 1e-6 && k.s < hi - 1e-6));
  // Corner strategy: a hole on the apex, or an even pair straddling it at
  // ±pitch/2 along the line. "auto" picks, per corner, the strategy whose
  // neighbouring spans deviate least from the target pitch.
  const anchors = []; // { s, kind }
  if (!c.closed) anchors.push({ s: lo, kind: "end" });
  const spanDeviation = (len) => {
    const n = Math.max(1, Math.round(len / p));
    return Math.abs(len / n - p) / p;
  };
  cornerList.forEach((k, idx) => {
    let strategy = pattern.corner;
    const half = p / 2;
    const prevS = idx ? cornerList[idx - 1].s : c.closed ? cornerList.at(-1).s - c.length : lo;
    const nextS = idx + 1 < cornerList.length ? cornerList[idx + 1].s : c.closed ? cornerList[0].s + c.length : hi;
    const room = Math.min(k.s - prevS, nextS - k.s);
    if (strategy === "auto") {
      // Right angles and sharper always get a single apex hole (a straddled
      // 90° corner would shorten the diagonal stitch to 0.7 pitch).
      if (Math.abs(k.angle) >= 80 || room < p * 1.2) strategy = "apex";
      else {
        const apex = spanDeviation(k.s - prevS) + spanDeviation(nextS - k.s);
        const straddle = spanDeviation(k.s - half - prevS) + spanDeviation(nextS - (k.s + half));
        strategy = straddle + 0.02 < apex ? "straddle" : "apex";
      }
    }
    if (strategy === "straddle" && room >= p * 1.2) {
      anchors.push({ s: k.s - half, kind: "corner" }, { s: k.s + half, kind: "corner" });
    } else anchors.push({ s: k.s, kind: "corner" });
  });
  if (!c.closed) anchors.push({ s: hi, kind: "end" });
  anchors.sort((a, b) => a.s - b.s);
  // Spans between anchors; a closed loop without anchors is one span that
  // starts at s = 0 (the start offset) and has no fixed hole.
  const spans = [];
  if (c.closed && !anchors.length) spans.push({ from: 0, to: c.length, loop: true });
  else if (c.closed) {
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i],
        b = anchors[(i + 1) % anchors.length];
      spans.push({ from: a.s, to: i + 1 < anchors.length ? b.s : b.s + c.length, loop: false });
    }
  } else for (let i = 0; i + 1 < anchors.length; i++) spans.push({ from: anchors[i].s, to: anchors[i + 1].s, loop: false });
  // Hole counts per span.
  const lengths = spans.map((sp) => sp.to - sp.from);
  let counts;
  if (pattern.fit === "count" && pattern.count > 0) {
    // Anchor holes are fixed; the remaining holes are spread over the spans
    // in proportion to their length (each span has interior + 1 segments).
    const interior = Math.max(0, pattern.count - anchors.length);
    counts = spans.length === 1 && spans[0].loop ? [Math.max(1, pattern.count)] : allocate(lengths, interior + spans.length);
  } else counts = lengths.map((l) => Math.max(1, Math.round(l / p)));
  // Positions.
  const holesS = []; // { s, anchor }
  spans.forEach((sp, i) => {
    const len = lengths[i];
    let pos;
    if (pattern.fit === "fixed") pos = fixedPositions(c, sp.from, sp.to, p, pattern.spacing);
    else if (pattern.spacing === "chord") pos = chordPositions(c, sp.from, sp.to, counts[i]);
    else pos = arcPositions(sp.from, sp.to, counts[i]);
    const segments = pos.length - 1;
    const achieved = segments > 0 ? (pattern.spacing === "chord" ? pos.slice(1).map((s, k) => dist(pointAt(c, pos[k]), pointAt(c, s))) : pos.slice(1).map((s, k) => s - pos[k])) : [];
    const mean = achieved.length ? achieved.reduce((a, b) => a + b, 0) / achieved.length : 0;
    sp.length = len;
    sp.segments = segments;
    sp.pitch = mean;
    sp.min = achieved.length ? Math.min(...achieved) : 0;
    sp.max = achieved.length ? Math.max(...achieved) : 0;
    sp.deviation = p > 0 ? Math.abs(mean - p) / p : 0;
    if (pattern.fit !== "fixed" && sp.deviation > pattern.maxDeviation)
      warnings.push(`区間 ${i + 1}（${len.toFixed(1)} mm）の実ピッチ ${mean.toFixed(2)} mm は目標 ${p} mm から ${(sp.deviation * 100).toFixed(0)}% ずれています。`);
    if (pattern.fit === "fixed" && achieved.length > 1 && achieved.at(-1) < p * 0.75)
      warnings.push(`区間 ${i + 1} の最後の穴間隔が ${achieved.at(-1).toFixed(2)} mm と狭くなっています。`);
    const startKind = anchors.find((a) => Math.abs(a.s - sp.from) < 1e-9)?.kind ?? null;
    const endKind = anchors.find((a) => Math.abs(a.s - (sp.to % c.length || sp.to)) < 1e-9 || Math.abs(a.s - sp.to) < 1e-9)?.kind ?? null;
    pos.forEach((s, k) => {
      if (k === pos.length - 1 && (c.closed || i + 1 < spans.length)) return; // shared with the next span
      if (sp.loop && k === pos.length - 1) return;
      holesS.push({ s, anchor: k === 0 ? startKind : k === pos.length - 1 ? endKind : null });
    });
  });
  // Remove holes that would overlap (e.g. straddle pairs of two close corners).
  const minGap = Math.max(pattern.width, Math.min(p * 0.5, pattern.length));
  const kept = [];
  for (const h of holesS) {
    const prev = kept.at(-1);
    const point = pointAt(c, h.s);
    if (prev && dist(prev.point, point) < minGap) {
      warnings.push(`間隔 ${dist(prev.point, point).toFixed(2)} mm で重なる穴を1つ省きました。`);
      continue;
    }
    kept.push({ ...h, point });
  }
  if (c.closed && kept.length > 1 && dist(kept[0].point, kept.at(-1).point) < minGap) {
    kept.pop();
    warnings.push("始点と終点で重なる穴を1つ省きました。");
  }
  const sign = (pattern.reverse ? -1 : 1) * (pattern.flip ? -1 : 1);
  const holes = kept.map((h, index) => {
    const t = tangentAt(c, h.s);
    const tangent = (Math.atan2(t.y, t.x) * 180) / Math.PI;
    return { index, x: h.point.x, y: h.point.y, s: h.s, tangent, angle: tangent + sign * pattern.angle, anchor: h.anchor };
  });
  // Achieved pitch statistics over neighbouring holes (chord and arc).
  const chords = holes.slice(1).map((h, k) => dist(holes[k], h));
  if (c.closed && holes.length > 1) chords.push(dist(holes.at(-1), holes[0]));
  const stats = chords.length
    ? { target: p, min: Math.min(...chords), max: Math.max(...chords), mean: chords.reduce((a, b) => a + b, 0) / chords.length }
    : { target: p, min: 0, max: 0, mean: 0 };
  if (holes.length < 2) warnings.push("穴が2つ未満です。縫い線が短すぎるかピッチが大きすぎます。");
  return { holes, spans, length: c.length, closed: Boolean(c.closed), pitch: stats, warnings, corners: cornerList.length };
}

// ---------------------------------------------------------------- hole shapes
const ROUND_STEP = 0.005; // flattening tolerance for hole outlines (finer than cuts)
// Closed outline of one hole (world mm) for the pattern's shape, centred on
// the hole and rotated to its orientation.
export function holeContour(hole, patternIn) {
  const pattern = normalizePattern(patternIn);
  const a = (hole.angle * Math.PI) / 180,
    cos = Math.cos(a),
    sin = Math.sin(a);
  const place = (x, y) => P(hole.x + x * cos - y * sin, hole.y + x * sin + y * cos);
  const w = pattern.width,
    l = pattern.length;
  let local;
  if (pattern.shape === "round") {
    // Vertex count is a multiple of 4 so the extremes (and the bounding
    // box) are exact; the chord sag stays within ROUND_STEP.
    const r = w / 2,
      n = Math.max(24, 4 * Math.ceil(Math.PI / Math.acos(Math.max(0.01, 1 - ROUND_STEP / r)) / 4));
    local = Array.from({ length: n }, (_, i) => {
      const t = (2 * Math.PI * i) / n;
      return [r * Math.cos(t), r * Math.sin(t)];
    });
  } else if (pattern.shape === "diamond") {
    local = [
      [l / 2, 0],
      [0, w / 2],
      [-l / 2, 0],
      [0, -w / 2],
    ];
  } else if (pattern.shape === "french") {
    // Stadium: a slot with semicircular ends.
    const r = w / 2,
      half = Math.max(0, l / 2 - r),
      n = 10;
    local = [];
    for (let i = 0; i <= n; i++) {
      const t = -Math.PI / 2 + (Math.PI * i) / n;
      local.push([half + r * Math.cos(t), r * Math.sin(t)]);
    }
    for (let i = 0; i <= n; i++) {
      const t = Math.PI / 2 + (Math.PI * i) / n;
      local.push([-half + r * Math.cos(t), r * Math.sin(t)]);
    }
  } else {
    // slit / flat: a thin rectangle along the orientation.
    local = [
      [l / 2, -w / 2],
      [l / 2, w / 2],
      [-l / 2, w / 2],
      [-l / 2, -w / 2],
    ];
  }
  const pts = local.map(([x, y]) => place(x, y));
  pts.push({ ...pts[0] });
  return pts;
}
export const holeContours = (result, pattern) => result.holes.map((h) => holeContour(h, pattern));
