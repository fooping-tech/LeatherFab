// General fillet: rounds the corner at node i of subpath s whatever the two
// adjacent pieces are (lines, cubic curves, or chains of smoothly joined
// fitted segments), joining two sharply bent pieces with a tangent arc.
// TypeFab's cad.js keeps its exact line–line fillet and falls back to this
// for anything else.
//
// Method: on each side of the corner the path is followed across smooth
// (tangent-continuous) nodes and sampled by arc length. Points A (incoming
// side) and B (outgoing side) are searched so that the circles of radius r
// tangent to the path at A and at B share one centre (nested golden-section
// search on the two arc-length distances from the corner). The segments
// holding A and B are split there (shape-preserving de Casteljau through
// insertNode), every node between A and B is removed, and A→B becomes one
// cubic arc.
import { insertNode, segmentCurve } from "../path.js";
import { curve, pointAt, tangentAt } from "./polyline.js";

const P = (x, y) => ({ x, y });
const num = (n) => Number(n.toFixed(6));
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dot = (a, b) => a.x * b.x + a.y * b.y;
const perp = (t) => P(-t.y, t.x);
const bezierAt = (b, t) => {
  const s = 1 - t;
  return P(
    s * s * s * b[0].x + 3 * s * s * t * b[1].x + 3 * s * t * t * b[2].x + t * t * t * b[3].x,
    s * s * s * b[0].y + 3 * s * s * t * b[1].y + 3 * s * t * t * b[2].y + t * t * t * b[3].y,
  );
};
const segCount = (sp) => (sp.closed ? sp.nodes.length : sp.nodes.length - 1);
// Is the junction at node k tangent-continuous (no visible corner)?
function smoothAt(sp, k) {
  const n = sp.nodes.length,
    node = sp.nodes[k],
    prev = sp.nodes[(k - 1 + n) % n],
    next = sp.nodes[(k + 1) % n];
  const a = node.in ?? prev,
    b = node.out ?? next;
  const u = P(node.x - a.x, node.y - a.y),
    v = P(b.x - node.x, b.y - node.y);
  const lu = Math.hypot(u.x, u.y),
    lv = Math.hypot(v.x, v.y);
  if (lu < 1e-9 || lv < 1e-9) return false;
  return dot(u, v) / (lu * lv) > Math.cos((8 * Math.PI) / 180);
}
// Samples segment index k as points with (segment, t) tags.
function sampleSegment(sp, k, n = 128) {
  const a = sp.nodes[k],
    b = sp.nodes[(k + 1) % sp.nodes.length],
    c = segmentCurve(sp, k);
  const out = [];
  for (let j = 0; j <= n; j++) {
    const t = j / n;
    out.push({ p: c ? bezierAt(c, t) : P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t), seg: k, t });
  }
  return out;
}
// The chain of segments leaving the corner (dir = +1) or arriving at it
// (dir = -1), followed across smooth nodes, as samples ordered away from the
// corner. Stops before coming back to the corner and after `maxLength` mm.
function chain(sp, i, dir, maxLength) {
  const n = sp.nodes.length,
    segs = segCount(sp);
  const samples = [];
  let k = dir > 0 ? i : (i - 1 + n) % n,
    length = 0,
    guard = 0;
  while (guard++ < segs) {
    if (dir > 0 && !sp.closed && k >= segs) break;
    if (dir < 0 && k < 0) break;
    let s = sampleSegment(sp, k);
    if (dir < 0) s = s.reverse();
    // Drop the duplicated junction point.
    samples.push(...(samples.length ? s.slice(1) : s));
    for (let j = 1; j < s.length; j++) length += Math.hypot(s[j].p.x - s[j - 1].p.x, s[j].p.y - s[j - 1].p.y);
    const junction = dir > 0 ? (k + 1) % n : k; // node at the far end of this segment
    const nextSeg = dir > 0 ? (k + 1) % n : (k - 1 + n) % n;
    if (!sp.closed && (dir > 0 ? junction >= n - 1 : junction <= 0)) break;
    if (junction === i || nextSeg === (dir > 0 ? (i - 1 + n) % n : i)) break;
    if (!smoothAt(sp, junction) || length >= maxLength) break;
    k = nextSeg;
  }
  return samples;
}
function golden(f, lo, hi, iterations = 60) {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi, c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let k = 0; k < iterations; k++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  const x = (a + b) / 2;
  return { x, value: f(x) };
}
// (segment, t) of a chain at arc length s.
function locate(samples, c, s) {
  let i = c.s.findIndex((v) => v > s) - 1;
  if (i < 0) i = c.s.length - 2;
  i = Math.max(0, Math.min(c.s.length - 2, i));
  const l = c.s[i + 1] - c.s[i],
    f = l > 0 ? (s - c.s[i]) / l : 0;
  const a = samples[i],
    b = samples[i + 1];
  if (a.seg === b.seg) return { seg: a.seg, t: a.t + (b.t - a.t) * f };
  return f < 0.5 ? { seg: a.seg, t: a.t } : { seg: b.seg, t: b.t };
}
export function filletCurvedCorner(path, s, i, radius) {
  if (!(radius > 0)) throw Error("半径は0より大きい値です。");
  const sp = path[s];
  if (!sp) throw Error("パスがありません。");
  const n = sp.nodes.length;
  if (!sp.closed && (i <= 0 || i >= n - 1)) throw Error("端のノードには適用できません。");
  if (n < 3) throw Error("ノードが足りません。");
  const reach = Math.max(10 * radius, 50);
  const inSamples = chain(sp, i, -1, reach),
    outSamples = chain(sp, i, +1, reach);
  const cIn = curve(inSamples.map((q) => q.p), false),
    cOut = curve(outSamples.map((q) => q.p), false);
  if (cIn.length < 1e-6 || cOut.length < 1e-6) throw Error("辺の長さが0です。");
  // Turn direction at the corner decides which side the centre lies on.
  const tIn = tangentAt(cIn, 0, 0.05), // away from the corner along the incoming side
    tOut = tangentAt(cOut, 0, 0.05);
  const travelIn = P(-tIn.x, -tIn.y);
  const turn = cross(travelIn, tOut);
  if (Math.abs(turn) < 1e-4 && dot(travelIn, tOut) > 0) throw Error("この角は滑らかなため丸める必要がありません。");
  const side = turn > 0 ? 1 : -1;
  const centre = (c, d, incoming) => {
    const p = pointAt(c, d),
      t = tangentAt(c, d, 0.05),
      dir = incoming ? P(-t.x, -t.y) : t,
      nrm = perp(dir);
    return { p, dir, c: P(p.x + side * nrm.x * radius, p.y + side * nrm.y * radius) };
  };
  const gap = (dA, dB) => {
    const a = centre(cIn, dA, true), b = centre(cOut, dB, false);
    return Math.hypot(a.c.x - b.c.x, a.c.y - b.c.y);
  };
  const best = golden((dA) => golden((dB) => gap(dA, dB), 1e-6, cOut.length, 40).value, 1e-6, cIn.length, 40);
  const dA = best.x,
    dB = golden((d) => gap(dA, d), 1e-6, cOut.length, 60).x;
  if (best.value > 0.02 || dA > cIn.length - 1e-4 || dB > cOut.length - 1e-4)
    throw Error(`半径 ${radius} mm のフィレットをこの角に収められません。半径を小さくしてください。`);
  const A = centre(cIn, dA, true),
    B = centre(cOut, dB, false);
  const locA = locate(inSamples, cIn, dA),
    locB = locate(outSamples, cOut, dB);
  // Edit a tagged clone: insertNode re-clones the path, so nodes are found
  // again by a temporary tag rather than by identity.
  let work = structuredClone(path);
  work[s].nodes.forEach((q, k) => (q._fk = k));
  const at = (tag) => work[s].nodes.findIndex((q) => q._fk === tag);
  let r = insertNode(work, s, at(locA.seg), locA.t);
  work = r.path;
  work[s].nodes[(at(locA.seg) + 1) % work[s].nodes.length]._fk = "A";
  r = insertNode(work, s, at(locB.seg), locB.t);
  work = r.path;
  work[s].nodes[(at(locB.seg) + 1) % work[s].nodes.length]._fk = "B";
  const list = work[s].nodes;
  const ia = at("A"),
    ib = at("B");
  // Drop every node strictly between A and B, walking forward from A.
  const drop = new Set();
  for (let k = (ia + 1) % list.length; k !== ib; k = (k + 1) % list.length) drop.add(k);
  const aFinal = list[ia],
    bFinal = list[ib];
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(A.dir, B.dir))));
  const kk = (4 / 3) * Math.tan(phi / 4) * radius;
  aFinal.out = P(num(aFinal.x + A.dir.x * kk), num(aFinal.y + A.dir.y * kk));
  bFinal.in = P(num(bFinal.x - B.dir.x * kk), num(bFinal.y - B.dir.y * kk));
  delete aFinal.smooth;
  delete bFinal.smooth;
  work[s].nodes = list.filter((q, k) => !drop.has(k));
  for (const q of work[s].nodes) delete q._fk;
  return work;
}
