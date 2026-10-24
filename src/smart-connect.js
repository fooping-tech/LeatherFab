// Smart Connect (issue #5): joins the separate material parts of text or fixed
// outlines with connector shapes so the letters cut as one piece. Everything
// here is pure: the editor keeps the returned plan, shows it, and applies the
// union it contains. Coordinates are world millimetres.
//
//   analyze(inputs)            material components + glyph membership
//   generate(analysis, opts)   candidates → connectors → union → diagnostics
//   nextCandidate / setConnector / moveEnd / moveConnector / removeConnector
//   finalize(analysis, plan)   the outline to store (contours + line path)
import { bounds, transform, worldContours } from "./geometry.js";
import { warpContours } from "./warp.js";
import {
  unionRegions,
  interiorPoint,
  regionContains,
  containsPoint,
  polygonArea,
  intersectionArea,
  bandAround,
  segmentsIntersect,
  offsetContours,
  isClosed,
} from "./polygon.js";

export const STYLES = {
  auto: "Auto（自動）",
  smooth: "Smooth（滑らか）",
  tapered: "Tapered（根元太め）",
  rounded: "Rounded（カプセル）",
  straight: "Straight（矩形）",
};
const STYLE_ORDER = ["smooth", "tapered", "rounded", "straight"];
export const DEFAULT_SETTINGS = {
  width: 1.5,
  maxGap: 10,
  style: "auto",
  withinCharacters: true,
  adjacentCharacters: true,
  wholePiece: true,
  japanese: "auto",
};
export const LIMITS = { width: [0.2, 50], maxGap: [0.1, 200], curvature: [0.05, 1.5] };
const MAX_CANDIDATES_PER_PAIR = 8,
  MAX_CROSSING_TESTS = 24,
  MAX_DEPTH = 80,
  EPS_AREA = 1e-4;
const P = (x, y) => ({ x, y });
const sub = (a, b) => P(a.x - b.x, a.y - b.y);
const add = (a, b) => P(a.x + b.x, a.y + b.y);
const mul = (a, k) => P(a.x * k, a.y * k);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a) => {
  const l = len(a);
  return l ? P(a.x / l, a.y / l) : P(1, 0);
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆〇]/u;

// ---- settings
export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const num = (key, [lo, hi], label) => {
    const v = Number(s[key]);
    if (!Number.isFinite(v) || v < lo || v > hi)
      throw Error(`${label}は ${lo}〜${hi} mm の数値で指定してください。`);
    s[key] = v;
  };
  num("width", LIMITS.width, "接続幅");
  num("maxGap", LIMITS.maxGap, "最大距離");
  if (!(s.style in STYLES)) throw Error("不明な接続スタイルです。");
  for (const key of ["withinCharacters", "adjacentCharacters", "wholePiece"])
    s[key] = Boolean(s[key]);
  if (!["auto", "on", "off"].includes(s.japanese)) s.japanese = "auto";
  // Distance-only scoring, kept for comparisons and tests (no UI).
  s.nearestOnly = Boolean(s.nearestOnly);
  // One piece needs both kinds of connection; switching either off drops it.
  if (s.wholePiece) s.withinCharacters = s.adjacentCharacters = true;
  return s;
}

// ---- inputs
// A text item with its laid-out glyphs (layoutGlyphs): the final outline plus
// each glyph's final outline, so components know which characters they hold.
export function textInput(item, glyphs) {
  const box = bounds(glyphs.flatMap((g) => g.contours)),
    lines = glyphLines(item, glyphs);
  return {
    id: item.id,
    contours: worldContours(item),
    glyphs: glyphs.map((g, n) => ({
      text: g.text,
      line: lines[n],
      contours: (item.warp
        ? warpContours(g.contours, box, item.warp.envelope)
        : g.contours
      ).map((c) => c.map((p) => transform(p, item))),
    })),
  };
}
// A fixed outline: geometry only, no character membership.
export const outlineInput = (item) => ({ id: item.id, contours: worldContours(item) });
function glyphLines(item, glyphs) {
  if (item.vertical) {
    let line = 0,
      previous = -1;
    return glyphs.map((g) => {
      if (g.cluster <= previous) line++;
      previous = g.cluster;
      return line;
    });
  }
  const lines = [];
  let line = 0;
  for (const ch of item.text) {
    if (ch === "\n") line++;
    else lines.push(line);
  }
  return glyphs.map((_, n) => lines[n] ?? line);
}

// ---- material components
export function analyze(inputs) {
  const material = inputs.flatMap((i) => i.contours.filter(isClosed));
  const components = unionRegions(material)
    .map((r) => ({ ...r, bounds: bounds([r.outer]) }))
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((r, id) => ({
      id,
      outer: r.outer,
      holes: r.holes,
      contours: [r.outer, ...r.holes],
      bounds: r.bounds,
      area: polygonArea(r.outer) - r.holes.reduce((n, h) => n + polygonArea(h), 0),
      glyphs: [],
      items: [],
      rings: null,
      index: null,
    }));
  const locate = (contours) => {
    const found = new Set();
    for (const region of unionRegions(contours.filter(isClosed))) {
      const p = interiorPoint(region),
        k = components.findIndex((c) => regionContains(c, p));
      if (k >= 0) found.add(k);
    }
    return [...found];
  };
  const glyphs = [];
  for (const input of inputs) {
    if (!input.glyphs) {
      for (const k of locate(input.contours))
        if (!components[k].items.includes(input.id)) components[k].items.push(input.id);
      continue;
    }
    const orders = new Map();
    input.glyphs.forEach((g) => {
      if (!g.contours.some(isClosed)) return;
      const order = orders.get(g.line) ?? 0;
      orders.set(g.line, order + 1);
      const glyph = {
        key: glyphs.length,
        text: g.text,
        itemId: input.id,
        line: g.line,
        order,
        japanese: JAPANESE.test(g.text),
        contours: g.contours.filter(isClosed),
        bounds: bounds(g.contours),
        components: locate(g.contours),
      };
      glyphs.push(glyph);
      for (const k of glyph.components) {
        components[k].glyphs.push(glyph.key);
        if (!components[k].items.includes(input.id)) components[k].items.push(input.id);
      }
    });
  }
  return {
    inputs,
    material,
    components,
    glyphs,
    hasGlyphInfo: inputs.some((i) => i.glyphs),
    holesBefore: components.reduce((n, c) => n + c.holes.length, 0),
  };
}

// ---- boundary samples and their local features
const sampleStep = (width) => clamp(width / 3, 0.2, 0.6);
function ensureSamples(comp, step) {
  if (comp.rings && comp.step === step) return comp.rings;
  comp.step = step;
  comp.rings = comp.contours.map((c, ci) => {
    const ring = [];
    let carry = 0;
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1],
        b = c[i],
        l = dist(a, b);
      if (l < 1e-9) continue;
      const t = unit(sub(b, a));
      while (carry <= l) {
        ring.push({ p: add(a, mul(t, carry)), t, seg: i - 1, ci });
        carry += step;
      }
      carry -= l;
    }
    // Inward normal: the left normal, flipped when a probe lands outside.
    let votes = 0;
    for (let k = 0; k < Math.min(ring.length, 7); k++) {
      const s = ring[Math.floor((k * ring.length) / Math.min(ring.length, 7))],
        left = P(-s.t.y, s.t.x);
      votes += regionContains(comp, add(s.p, mul(left, 0.02))) ? 1 : -1;
    }
    const sign = votes >= 0 ? 1 : -1;
    ring.forEach((s, n) => {
      s.nin = mul(P(-s.t.y, s.t.x), sign);
      s.nout = mul(s.nin, -1);
      s.n = n;
      s.comp = comp.id;
    });
    return ring;
  });
  comp.index = new SegmentIndex(comp.contours, 4);
  return comp.rings;
}
// Uniform grid over the segments of a component for nearest-point queries.
class SegmentIndex {
  constructor(contours, cell) {
    this.cell = cell;
    this.segments = [];
    this.cells = new Map();
    contours.forEach((c) => {
      for (let i = 1; i < c.length; i++) {
        const a = c[i - 1],
          b = c[i];
        if (dist(a, b) < 1e-9) continue;
        const id = this.segments.length;
        this.segments.push({ a, b });
        const x0 = Math.floor(Math.min(a.x, b.x) / cell),
          x1 = Math.floor(Math.max(a.x, b.x) / cell),
          y0 = Math.floor(Math.min(a.y, b.y) / cell),
          y1 = Math.floor(Math.max(a.y, b.y) / cell);
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) {
            const key = `${x},${y}`;
            if (!this.cells.has(key)) this.cells.set(key, []);
            this.cells.get(key).push(id);
          }
      }
    });
  }
  // Nearest boundary point within radius r of q, or null.
  nearest(q, r) {
    const c = this.cell,
      x0 = Math.floor((q.x - r) / c),
      x1 = Math.floor((q.x + r) / c),
      y0 = Math.floor((q.y - r) / c),
      y1 = Math.floor((q.y + r) / c);
    let best = null;
    const seen = new Set();
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (const id of this.cells.get(`${x},${y}`) ?? []) {
          if (seen.has(id)) continue;
          seen.add(id);
          const { a, b } = this.segments[id],
            d = sub(b, a),
            l2 = dot(d, d),
            t = clamp(dot(sub(q, a), d) / l2, 0, 1),
            p = add(a, mul(d, t)),
            dd = dist(q, p);
          if (dd <= r && (!best || dd < best.d)) best = { p, d: dd, seg: id, t };
        }
    return best;
  }
}
// Depth of material behind a sample: the first boundary hit along the inward
// normal. Long behind a stroke end, short beside a stroke.
function depthAt(comp, s) {
  if (s.depth !== undefined) return s.depth;
  const o = add(s.p, mul(s.nin, 1e-3)),
    d = s.nin;
  let best = MAX_DEPTH;
  for (const c of comp.contours)
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1],
        b = c[i],
        e = sub(b, a),
        den = d.x * e.y - d.y * e.x;
      if (Math.abs(den) < 1e-12) continue;
      const w = sub(a, o),
        t = (w.x * e.y - w.y * e.x) / den,
        u = (w.x * d.y - w.y * d.x) / den;
      if (t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9 && t < best) best = t;
    }
  s.depth = best + 1e-3;
  return s.depth;
}
// How much the boundary turns around the sample, over a window that grows
// with the depth (up to 3 mm): π at a flat stroke end, 0 beside a stroke.
function turnAt(comp, s, step) {
  if (s.turn !== undefined) return s.turn;
  const ring = comp.rings[s.ci],
    w = clamp(depthAt(comp, s), 0.6, 3),
    k = Math.max(1, Math.round(w / step)),
    n = ring.length;
  if (n < 3) return (s.turn = 0);
  const before = ring[(s.n - k + n * 1000) % n].t,
    after = ring[(s.n + k) % n].t;
  s.turn = Math.acos(clamp(dot(before, after), -1, 1));
  return s.turn;
}
// 0..1: a thin stroke end (much turning, much depth) versus a stroke side.
function featuresOf(comp, s, step) {
  const depth = depthAt(comp, s),
    turn = turnAt(comp, s, step),
    w = clamp(depth, 0.6, 3),
    turnScore = clamp((turn - Math.PI / 3) / ((2 * Math.PI) / 3), 0, 1),
    depthScore = clamp((depth - w) / (2 * w), 0, 1);
  return {
    p: s.p,
    nout: s.nout,
    nin: s.nin,
    t: s.t,
    depth,
    turn,
    tip: turnScore * depthScore,
    ci: s.ci,
    n: s.n,
    comp: comp.id,
  };
}
// Sample of a component nearest to a point (for manual end moves).
function nearestSample(comp, q) {
  let best = null;
  for (const ring of comp.rings)
    for (const s of ring) {
      const d = dist(s.p, q);
      if (!best || d < best.d) best = { s, d };
    }
  return best?.s ?? null;
}
// The sample of a component nearest to a boundary point on segment `seg`.
function sampleNear(comp, q) {
  return nearestSample(comp, q);
}

// ---- candidate connections between two components
const bboxGap = (a, b) =>
  Math.hypot(
    Math.max(a.x - b.x - b.w, b.x - a.x - a.w, 0),
    Math.max(a.y - b.y - b.h, b.y - a.y - a.h, 0),
  );
function pairRelation(analysis, A, B) {
  const ga = A.glyphs.map((k) => analysis.glyphs[k]),
    gb = B.glyphs.map((k) => analysis.glyphs[k]);
  const within = ga.some((g) => B.glyphs.includes(g.key));
  const adjacent = ga.some((p) =>
    gb.some((q) => p.itemId === q.itemId && p.line === q.line && Math.abs(p.order - q.order) === 1),
  );
  const sameLine = ga.some((p) => gb.some((q) => p.itemId === q.itemId && p.line === q.line));
  const japanese = ga.some((g) => g.japanese) || gb.some((g) => g.japanese);
  return { within, adjacent, sameLine, japanese, glyphless: !ga.length || !gb.length };
}
function pairAllowed(rel, settings) {
  if (settings.wholePiece) return true;
  if (rel.glyphless) return false;
  return (settings.withinCharacters && rel.within) || (settings.adjacentCharacters && rel.adjacent);
}
function crossesMaterial(analysis, a, b, ignore) {
  const u = unit(sub(b, a)),
    d = dist(a, b);
  if (d < 2e-3) return false;
  const p = add(a, mul(u, 1e-3)),
    q = sub(b, mul(u, 1e-3)),
    box = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
  for (const comp of analysis.components) {
    if (bboxGap(comp.bounds, box) > 1e-9) continue;
    for (const c of comp.contours)
      for (let i = 1; i < c.length; i++)
        if (segmentsIntersect(p, q, c[i - 1], c[i])) return true;
    if (!ignore.includes(comp.id) && regionContains(comp, mul(add(p, q), 0.5))) return true;
  }
  return false;
}
function candidatesFor(analysis, A, B, settings, rel) {
  const step = sampleStep(settings.width),
    maxGap = settings.maxGap;
  ensureSamples(A, step);
  ensureSamples(B, step);
  const seen = new Set(),
    raw = [];
  const collect = (from, to, swap) => {
    for (const ring of from.rings)
      for (const s of ring) {
        if (bboxGap({ x: s.p.x, y: s.p.y, w: 0, h: 0 }, to.bounds) > maxGap) continue;
        const hit = to.index.nearest(s.p, maxGap);
        if (!hit || hit.d < 1e-6) continue;
        const partner = sampleNear(to, hit.p);
        if (!partner) continue;
        const sa = swap ? partner : s,
          sb = swap ? s : partner,
          key = `${sa.ci}:${sa.n}-${sb.ci}:${sb.n}`;
        if (seen.has(key)) continue;
        seen.add(key);
        raw.push({ sa, sb });
      }
  };
  collect(A, B, false);
  collect(B, A, true);
  const japanese = settings.japanese === "on" || (settings.japanese === "auto" && rel.japanese);
  const tipBonus = japanese ? 0.6 : 0.3;
  const scored = raw
    .map(({ sa, sb }) => {
      const fa = featuresOf(A, sa, step),
        fb = featuresOf(B, sb, step),
        d = dist(fa.p, fb.p);
      if (d > maxGap || d < 1e-6) return null;
      const u = unit(sub(fb.p, fa.p)),
        dirA = 1 - dot(u, fa.nout),
        dirB = 1 - dot(mul(u, -1), fb.nout),
        bend = Math.acos(clamp(-dot(fa.nout, fb.nout), -1, 1)) / Math.PI,
        thin = (end) => (end.tip > 0.5 ? 0 : clamp((settings.width - end.depth) / settings.width, 0, 1));
      const cost = settings.nearestOnly
        ? d / maxGap
        : 1.5 * (d / maxGap) +
        0.5 * ((dirA + dirB) / 2) +
        0.25 * bend -
        tipBonus * ((fa.tip + fb.tip) / 2) +
        (japanese ? 0.3 * ((dirA + dirB) / 2) * ((fa.tip + fb.tip) / 2) : 0) +
        0.2 * ((thin(fa) + thin(fb)) / 2) +
            (rel.within || rel.adjacent ? 0 : rel.sameLine ? 0.15 : 0.3);
      return { a: fa, b: fb, d, cost };
    })
    .filter(Boolean)
    .sort((p, q) => p.cost - q.cost || p.a.p.x - q.a.p.x || p.a.p.y - q.a.p.y || p.b.p.x - q.b.p.x || p.b.p.y - q.b.p.y);
  const kept = [],
    sep = Math.max(1.5 * settings.width, 1);
  let tested = 0,
    rejected = 0;
  for (const c of scored) {
    if (kept.length >= MAX_CANDIDATES_PER_PAIR || tested >= MAX_CROSSING_TESTS) break;
    if (kept.some((k) => dist(k.a.p, c.a.p) < sep && dist(k.b.p, c.b.p) < sep)) continue;
    tested++;
    if (crossesMaterial(analysis, c.a.p, c.b.p, [A.id, B.id])) {
      rejected++;
      continue;
    }
    kept.push(c);
  }
  return { candidates: kept, considered: scored.length, rejected };
}

// ---- connector geometry
function bezier(p0, p1, p2, p3, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n,
      s = 1 - t;
    out.push(
      P(
        s * s * s * p0.x + 3 * s * s * t * p1.x + 3 * s * t * t * p2.x + t * t * t * p3.x,
        s * s * s * p0.y + 3 * s * s * t * p1.y + 3 * s * t * t * p2.y + t * t * t * p3.y,
      ),
    );
  }
  return out;
}
const overlapOf = (end, width) =>
  end.tip > 0.5
    ? clamp(0.9 * end.depth, 0.2, 2 * width)
    : clamp(0.9 * end.depth, 0.2, width);
// Polygon(s) of one connector. The centerline overlaps both materials so the
// union has no seam; a thin tip is covered back to where the stroke is wider.
export function connectorShape(c) {
  const { a, b, width, style } = c,
    curvature = c.curvature ?? 0.4,
    d = dist(a.p, b.p),
    u = unit(sub(b.p, a.p)),
    oa = overlapOf(a, width),
    ob = overlapOf(b, width);
  let centerline;
  if (style === "straight" || style === "rounded")
    centerline = [sub(a.p, mul(u, oa)), add(b.p, mul(u, ob))];
  else {
    const h = Math.max(0.2, d * curvature),
      n = clamp(Math.ceil((d + oa + ob) / 0.25), 8, 64);
    centerline = [
      sub(a.p, mul(a.nout, oa)),
      ...bezier(a.p, add(a.p, mul(a.nout, h)), add(b.p, mul(b.nout, h)), b.p, n),
      sub(b.p, mul(b.nout, ob)),
    ];
  }
  if (style === "tapered") return [taperedBand(centerline, width)];
  return bandAround(centerline, width, style === "rounded" ? "round" : "butt");
}
// Variable width band: 1.6× the width at both roots, the width in the middle.
function taperedBand(points, width) {
  const pts = points.filter((p, i) => !i || dist(p, points[i - 1]) > 1e-9),
    total = pts.slice(1).reduce((n, p, i) => n + dist(p, pts[i]), 0);
  let run = 0;
  const left = [],
    right = [];
  pts.forEach((p, i) => {
    if (i) run += dist(p, pts[i - 1]);
    const t0 = i ? unit(sub(p, pts[i - 1])) : unit(sub(pts[1], p)),
      t1 = i + 1 < pts.length ? unit(sub(pts[i + 1], p)) : t0,
      t = unit(add(t0, t1)),
      n = P(-t.y, t.x),
      f = total ? run / total : 0,
      w = width * (1 + 0.6 * Math.cos(Math.PI * f) ** 2);
    left.push(add(p, mul(n, w / 2)));
    right.push(sub(p, mul(n, w / 2)));
  });
  const ring = [...left, ...right.reverse()];
  return [...ring, { ...ring[0] }];
}
function connectorLength(c) {
  return dist(c.a.p, c.b.p);
}

// ---- validation of one connector against the rest
function validateConnector(analysis, c, others, settings) {
  const polygon = c.polygon;
  if (!polygon.length) return "形状を作れませんでした";
  const box = bounds(polygon);
  if (connectorLength(c) > settings.maxGap + 1e-6) return "最大距離を超えています";
  for (const comp of analysis.components) {
    if (bboxGap(comp.bounds, box) > 1e-9) continue;
    const endpoint = c.pair.includes(comp.id);
    if (!endpoint) {
      if (intersectionArea(polygon, comp.contours) > EPS_AREA) return "他の輪郭と交差しています";
      continue;
    }
    // A hole must survive: the band may cross it, not fill it.
    for (const hole of comp.holes) {
      const hb = bounds([hole]);
      if (bboxGap(hb, box) > 1e-9) continue;
      const area = polygonArea(hole);
      if (area > EPS_AREA && intersectionArea(polygon, [hole]) > 0.5 * area) return "穴を潰してしまいます";
    }
  }
  for (const o of others) {
    if (o.id === c.id || !o.polygon?.length) continue;
    if (bboxGap(bounds(o.polygon), box) > 1e-9) continue;
    if (segmentsIntersect(c.a.p, c.b.p, o.a.p, o.b.p)) return "他の接続と交差しています";
    if (intersectionArea(polygon, o.polygon) > 0.3 * settings.width * settings.width)
      return "他の接続と重なっています";
  }
  return null;
}
function buildConnector(analysis, c, others, settings) {
  const styles = c.style === "auto" ? STYLE_ORDER : [c.style, "straight"];
  let problem = null;
  for (const style of styles) {
    const polygon = connectorShape({ ...c, style });
    const trial = { ...c, polygon, resolvedStyle: style };
    problem = validateConnector(analysis, trial, others, settings);
    if (!problem) return { ...trial, problem: null, fallback: c.style !== "auto" && style !== c.style };
  }
  return { ...c, polygon: connectorShape({ ...c, style: styles[0] }), resolvedStyle: styles[0], problem };
}

// ---- union of everything
class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i) {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]];
    return i;
  }
  union(a, b) {
    const ra = this.find(a),
      rb = this.find(b);
    if (ra === rb) return false;
    this.parent[rb] = ra;
    return true;
  }
  groups(n) {
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const r = this.find(i);
      if (!map.has(r)) map.set(r, []);
      map.get(r).push(i);
    }
    return [...map.values()];
  }
}
// Connectors overlap the material they join, so the result never relies on
// vertex contacts; the strict (slow) simplification is skipped here.
function unite(analysis, connectors) {
  return unionRegions(
    [...analysis.material, ...connectors.filter((c) => !c.problem).flatMap((c) => c.polygon)],
    { strict: false },
  );
}
let nextId = 1;
const newId = () => `c${nextId++}`;

// ---- generation
export function generate(analysis, input = {}) {
  const settings = normalizeSettings(input);
  const comps = analysis.components,
    pairs = [];
  const diagnostics = [];
  for (let i = 0; i < comps.length; i++)
    for (let j = i + 1; j < comps.length; j++) {
      if (bboxGap(comps[i].bounds, comps[j].bounds) > settings.maxGap) continue;
      const rel = pairRelation(analysis, comps[i], comps[j]);
      if (!pairAllowed(rel, settings)) continue;
      const { candidates, considered, rejected } = candidatesFor(analysis, comps[i], comps[j], settings, rel);
      pairs.push({ pair: [i, j], rel, candidates, considered, rejected });
    }
  const edges = pairs
    .flatMap((p) => p.candidates.map((c, index) => ({ ...c, pair: p.pair, candidates: p.candidates, index })))
    .sort((p, q) => p.cost - q.cost || p.pair[0] - q.pair[0] || p.pair[1] - q.pair[1] || p.index - q.index);
  const uf = new UnionFind(comps.length),
    connectors = [];
  for (const e of edges) {
    if (uf.find(e.pair[0]) === uf.find(e.pair[1])) continue;
    const built = buildConnector(
      analysis,
      {
        id: newId(),
        pair: e.pair,
        candidates: e.candidates,
        index: e.index,
        a: e.a,
        b: e.b,
        width: settings.width,
        style: settings.style,
        curvature: 0.4,
        manual: false,
      },
      connectors,
      settings,
    );
    if (built.problem) continue;
    connectors.push(built);
    uf.union(e.pair[0], e.pair[1]);
  }
  const plan = {
    settings,
    connectors,
    pairsConsidered: pairs.length,
    pairInfo: pairs.map((p) => ({ pair: p.pair, candidates: p.candidates.length, considered: p.considered, rejected: p.rejected })),
  };
  return evaluate(analysis, plan, diagnostics);
}
// Recomputes shapes, validity, the union and the diagnostics of a plan.
export function rebuild(analysis, plan) {
  const settings = plan.settings,
    connectors = [];
  for (const c of plan.connectors) {
    const built = buildConnector(analysis, { ...c, polygon: undefined, problem: null }, connectors, settings);
    connectors.push(built);
  }
  return evaluate(analysis, { ...plan, connectors }, []);
}
function evaluate(analysis, plan, diagnostics) {
  const comps = analysis.components,
    settings = plan.settings;
  const uf = new UnionFind(comps.length);
  for (const c of plan.connectors) if (!c.problem) uf.union(c.pair[0], c.pair[1]);
  let groups = uf.groups(comps.length);
  const regions = unite(analysis, plan.connectors),
    after = regions.length;
  // Connectors are meant to join two parts each; anything joined twice is
  // dropped so the result has no more connectors than it needs.
  let connectors = plan.connectors;
  if (after < groups.length) {
    for (const c of [...connectors].reverse()) {
      if (c.problem || c.manual) continue;
      const rest = connectors.filter((o) => o !== c);
      if (unite(analysis, rest).length === after) connectors = rest;
    }
    const uf2 = new UnionFind(comps.length);
    for (const c of connectors) if (!c.problem) uf2.union(c.pair[0], c.pair[1]);
    groups = uf2.groups(comps.length);
  }
  const holesAfter = regions.reduce((n, r) => n + r.holes.length, 0);
  const problems = connectors.filter((c) => c.problem);
  const unconnected = groups.length > 1 ? groups : [];
  const messages = [...diagnostics];
  if (problems.length) messages.push(`${problems.length} 本の接続に問題があります（${[...new Set(problems.map((c) => c.problem))].join("、")}）。`);
  if (settings.wholePiece && unconnected.length)
    messages.push(
      `全体を1つにできません: ${unconnected.length} 個の部品が残ります。${unconnectedReasons(analysis, plan, groups, settings)}`,
    );
  if (holesAfter < analysis.holesBefore) messages.push(`穴が ${analysis.holesBefore - holesAfter} 個減ります。接続位置を変えてください。`);
  const thin = thinContacts(analysis, settings.width);
  if (thin.length) messages.push(`接続幅より狭い接触があります（元の形状）: ${thin.join("、")}`);
  const ok =
    !problems.length &&
    (!settings.wholePiece || !unconnected.length) &&
    holesAfter >= analysis.holesBefore &&
    (comps.length === 0 || regions.length > 0);
  return {
    ...plan,
    connectors,
    before: comps.length,
    after,
    holesBefore: analysis.holesBefore,
    holesAfter,
    unconnected,
    union: regions.flatMap((r) => [r.outer, ...r.holes]),
    problems: problems.map((c) => ({ id: c.id, problem: c.problem })),
    messages,
    warnings: thin,
    ok,
  };
}
function unconnectedReasons(analysis, plan, groups, settings) {
  const comps = analysis.components,
    parts = groups.map((g) => g.map((k) => label(analysis, comps[k])).join("+"));
  const reasons = new Set();
  for (const g of groups) {
    const near = comps.some(
      (c) => !g.includes(c.id) && g.some((k) => bboxGap(comps[k].bounds, c.bounds) <= settings.maxGap),
    );
    if (!near) reasons.add(`最大距離 ${settings.maxGap} mm 以内に相手がない`);
    else {
      const info = plan.pairInfo.filter((p) => g.includes(p.pair[0]) !== g.includes(p.pair[1]));
      if (!info.length) reasons.add("接続対象の設定で候補がない");
      else if (info.every((p) => !p.considered)) reasons.add(`輪郭どうしの距離が最大距離 ${settings.maxGap} mm を超える`);
      else if (info.every((p) => !p.candidates)) reasons.add("候補が輪郭と交差するため使えない");
      else reasons.add("候補が他の接続・輪郭と衝突した（自動生成できなかった）");
    }
  }
  return `未接続: ${parts.slice(0, 6).join(" / ")}${parts.length > 6 ? " …" : ""}。原因: ${[...reasons].join("、")}。`;
}
export function label(analysis, comp) {
  const texts = [...new Set(comp.glyphs.map((k) => analysis.glyphs[k].text))];
  return texts.length ? `「${texts.join("")}」` : `部品${comp.id + 1}`;
}
// Characters that only touch through material narrower than the connector
// width (a hairline overlap) are reported; the geometry is left as it is.
function thinContacts(analysis, width) {
  const out = [];
  for (const comp of analysis.components) {
    if (comp.glyphs.length < 2) continue;
    const eroded = erode(comp.contours, width / 2);
    if (!eroded.length) continue;
    const uf = new UnionFind(comp.glyphs.length);
    for (const r of eroded) {
      const region = [r.outer, ...r.holes],
        box = bounds([r.outer]),
        inside = [];
      comp.glyphs.forEach((k, gi) => {
        const g = analysis.glyphs[k];
        if (bboxGap(g.bounds, box) > 1e-9) return;
        if (intersectionArea(region, g.contours) > EPS_AREA) inside.push(gi);
      });
      for (let i = 1; i < inside.length; i++) uf.union(inside[0], inside[i]);
    }
    if (uf.groups(comp.glyphs.length).length > 1)
      out.push(comp.glyphs.map((k) => analysis.glyphs[k].text).join(""));
  }
  return out;
}
const erode = (contours, distance) => unionRegions(offsetContours(contours, -distance));

// ---- manual adjustment (before Apply)
const withConnector = (plan, id, fn) => ({
  ...plan,
  connectors: plan.connectors.map((c) => (c.id === id ? fn(c) : c)),
});
export function nextCandidate(analysis, plan, id) {
  return rebuild(
    analysis,
    withConnector(plan, id, (c) => {
      if (!c.candidates?.length) return c;
      const index = (c.index + 1) % c.candidates.length,
        cand = c.candidates[index];
      return { ...c, index, a: cand.a, b: cand.b, manual: true };
    }),
  );
}
export function setConnector(analysis, plan, id, patch) {
  const next = { ...patch };
  if ("width" in next) {
    const v = Number(next.width);
    if (!Number.isFinite(v) || v < LIMITS.width[0] || v > LIMITS.width[1])
      throw Error(`接続幅は ${LIMITS.width[0]}〜${LIMITS.width[1]} mm で指定してください。`);
    next.width = v;
  }
  if ("curvature" in next) {
    const v = Number(next.curvature);
    if (!Number.isFinite(v) || v < LIMITS.curvature[0] || v > LIMITS.curvature[1])
      throw Error(`曲率は ${LIMITS.curvature[0]}〜${LIMITS.curvature[1]} で指定してください。`);
    next.curvature = v;
  }
  if ("style" in next && !(next.style in STYLES)) throw Error("不明な接続スタイルです。");
  return rebuild(analysis, withConnector(plan, id, (c) => ({ ...c, ...next, manual: true })));
}
export function removeConnector(analysis, plan, id) {
  return rebuild(analysis, { ...plan, connectors: plan.connectors.filter((c) => c.id !== id) });
}
// Moves one end to the boundary point of its component nearest to `point`.
export function moveEnd(analysis, plan, id, end, point) {
  const step = sampleStep(plan.settings.width);
  return rebuild(
    analysis,
    withConnector(plan, id, (c) => {
      const comp = analysis.components[c.pair[end === "a" ? 0 : 1]];
      ensureSamples(comp, step);
      const s = nearestSample(comp, point);
      if (!s) return c;
      return { ...c, [end]: featuresOf(comp, s, step), manual: true };
    }),
  );
}
// Slides the whole connector: both ends move by the delta and snap back to
// their boundaries.
export function moveConnector(analysis, plan, id, delta) {
  const step = sampleStep(plan.settings.width);
  return rebuild(
    analysis,
    withConnector(plan, id, (c) => {
      const [A, B] = c.pair.map((k) => analysis.components[k]);
      ensureSamples(A, step);
      ensureSamples(B, step);
      const sa = nearestSample(A, add(c.a.p, delta)),
        sb = nearestSample(B, add(c.b.p, delta));
      if (!sa || !sb) return c;
      return { ...c, a: featuresOf(A, sa, step), b: featuresOf(B, sb, step), manual: true };
    }),
  );
}
// Adds a connector between the boundary points nearest to two clicked points
// (they must lie on different components).
export function addConnector(analysis, plan, p, q) {
  const step = sampleStep(plan.settings.width);
  const at = (pt) => {
    let best = null;
    for (const comp of analysis.components) {
      ensureSamples(comp, step);
      const s = nearestSample(comp, pt);
      if (s && (!best || dist(s.p, pt) < best.d)) best = { comp, s, d: dist(s.p, pt) };
    }
    return best;
  };
  const a = at(p),
    b = at(q);
  if (!a || !b || a.comp === b.comp) throw Error("別々の部品の輪郭付近を2点クリックしてください。");
  const c = {
    id: newId(),
    pair: [a.comp.id, b.comp.id],
    candidates: [],
    index: 0,
    a: featuresOf(a.comp, a.s, step),
    b: featuresOf(b.comp, b.s, step),
    width: plan.settings.width,
    style: plan.settings.style,
    curvature: 0.4,
    manual: true,
  };
  return rebuild(analysis, { ...plan, connectors: [...plan.connectors, c] });
}

// ---- result
// Closed line-node path of contours (no curve fitting, so joints and holes
// stay exactly as the union made them).
export function polylinePath(contours) {
  return contours
    .filter(isClosed)
    .map((c) => ({ closed: true, nodes: c.slice(0, -1).map((p) => P(p.x, p.y)) }))
    .filter((s) => s.nodes.length >= 3);
}
export function finalize(analysis, plan) {
  const checked = rebuild(analysis, plan);
  if (!checked.ok) throw Error(checked.messages[0] ?? "接続結果が有効ではありません。");
  if (!checked.union.length) throw Error("結果が空です。");
  return { contours: checked.union, path: polylinePath(checked.union), plan: checked };
}
// Utility used by the UI and tests: number of separate material pieces of a
// set of closed contours.
export const pieceCount = (contours) => unionRegions(contours).length;
export { containsPoint };
