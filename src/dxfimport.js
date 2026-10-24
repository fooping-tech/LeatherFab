import { parsePathData, pathContours, transformPath } from "./path.js";
import { multiply, applyMatrix } from "./svgimport.js";
import { signedArea, containsPoint } from "./polygon.js";
// DXF (ASCII) to the same shapes as the SVG import: { name, path, layer } with
// paths in millimetres, Y pointing down. Supported entities: LINE, ARC,
// CIRCLE, ELLIPSE, LWPOLYLINE and POLYLINE (with bulges), SPLINE and INSERT
// (blocks, nested). Arcs stay exact cubic Béziers. Lines that meet end to end
// are joined into one outline, and a closed outline goes into the shape of
// the outline around it as a hole, so a drawing made of separate segments
// still cuts (and stamps) as closed shapes. Everything else (text,
// dimensions, hatches, …) is counted and skipped.

const UNITS = {
  0: [1, "単位なし（mm とみなしました）"],
  1: [25.4, "インチ"],
  2: [304.8, "フィート"],
  4: [1, "mm"],
  5: [10, "cm"],
  6: [1000, "m"],
  8: [0.0000254, "マイクロインチ"],
  9: [0.0254, "ミル"],
  10: [914.4, "ヤード"],
  13: [0.001, "µm"],
  14: [100, "dm"],
};
const NAMES = {
  LINE: "線",
  ARC: "円弧",
  CIRCLE: "円",
  ELLIPSE: "楕円",
  LWPOLYLINE: "ポリライン",
  POLYLINE: "ポリライン",
  SPLINE: "スプライン",
};
// Entities that are not drawing geometry at all are not reported.
const SILENT = new Set(["VIEWPORT", "ATTDEF", "ATTRIB", "SEQEND", "VERTEX", "ENDBLK"]);
const SKIPPED = {
  TEXT: "文字（TEXT）",
  MTEXT: "文字（MTEXT）",
  DIMENSION: "寸法",
  HATCH: "ハッチング",
  SOLID: "塗りつぶし（SOLID）",
  POINT: "点",
  LEADER: "引出線",
  MLEADER: "引出線",
  IMAGE: "画像",
  "3DFACE": "3D面",
  "3DSOLID": "3Dソリッド",
  REGION: "リージョン",
  MLINE: "マルチライン",
};
export const JOIN_TOLERANCE_MM = 0.001;
const MAX_PATHS = 50000;
const MAX_DEPTH = 8;

const f = (v) => Number(v).toFixed(9);
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

// Group code / value pairs.
function pairsOf(text) {
  if (/^AutoCAD Binary DXF/.test(text))
    throw Error("バイナリ形式のDXFには対応していません。ASCII形式（テキスト）で保存してください。");
  const lines = text.split(/\r\n|\r|\n/),
    pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const t = lines[i].trim();
    if (t === "" && i + 2 >= lines.length) break;
    const code = t === "" ? Number.NaN : Number(t);
    if (!Number.isInteger(code)) throw Error("DXFとして読み込めません。ASCII形式のDXFか確認してください。");
    pairs.push([code, lines[i + 1].trim()]);
  }
  if (!pairs.some(([c, v]) => c === 0 && v === "SECTION"))
    throw Error("DXFとして読み込めません（SECTION がありません）。");
  return pairs;
}
// Splits pairs into records starting at each code 0.
function recordsOf(pairs) {
  const out = [];
  for (const [code, value] of pairs) {
    if (code === 0) out.push({ type: value, pairs: [] });
    else out.at(-1)?.pairs.push([code, value]);
  }
  return out;
}
const get = (rec, code, fallback) => {
  const p = rec.pairs.find(([c]) => c === code);
  return p ? p[1] : fallback;
};
const num = (rec, code, fallback = 0) => {
  const v = Number(get(rec, code, fallback));
  if (!Number.isFinite(v)) throw Error("数値が不正です。");
  return v;
};
const all = (rec, code) => rec.pairs.filter(([c]) => c === code).map(([, v]) => Number(v));

// Sections → { header, layers, blocks, entities }.
function sectionsOf(pairs) {
  const records = recordsOf(pairs),
    out = { header: [], tables: [], blocks: [], entities: [] };
  let section = null;
  for (const rec of records) {
    if (rec.type === "SECTION") {
      section = (get(rec, 2, "") || "").toUpperCase();
      // The header is a flat list of variables, not records.
      if (section === "HEADER") out.header = rec.pairs;
      continue;
    }
    if (rec.type === "ENDSEC") {
      section = null;
      continue;
    }
    if (section === "TABLES") out.tables.push(rec);
    else if (section === "BLOCKS") out.blocks.push(rec);
    else if (section === "ENTITIES") out.entities.push(rec);
  }
  return out;
}
function unitsOf(header) {
  const at = header.findIndex(([c, v]) => c === 9 && v === "$INSUNITS");
  const code = at >= 0 ? Number(header[at + 1]?.[1]) : 0;
  const [scale, label] = UNITS[code] ?? [1, "不明な単位（mm とみなしました）"];
  return { code, scale, label, assumed: !(code in UNITS) || code === 0 };
}
// Layers that are off (negative colour) or frozen are not imported.
function hiddenLayers(tables) {
  const hidden = new Set();
  for (const rec of tables)
    if (rec.type === "LAYER" && (num(rec, 62, 7) < 0 || (num(rec, 70, 0) & 1)))
      hidden.add(get(rec, 2, ""));
  return hidden;
}
function blocksOf(records) {
  const blocks = new Map();
  let current = null;
  for (const rec of records) {
    if (rec.type === "BLOCK") {
      current = { base: { x: num(rec, 10), y: num(rec, 20) }, entities: [] };
      blocks.set(get(rec, 2, ""), current);
    } else if (rec.type === "ENDBLK") current = null;
    else current?.entities.push(rec);
  }
  return blocks;
}
// POLYLINE + VERTEX… + SEQEND become one record with its vertices.
function joinPolylines(records) {
  const out = [];
  for (const rec of records) {
    if (rec.type === "VERTEX" && out.at(-1)?.type === "POLYLINE") out.at(-1).vertices.push(rec);
    else if (rec.type === "POLYLINE") out.push({ ...rec, vertices: [] });
    else out.push(rec);
  }
  return out;
}

// ---- entity → path (drawing coordinates, Y up) ----
// Arc from a to b with the given bulge (tan of a quarter of the included
// angle, positive counter-clockwise).
function bulgeArc(a, b, bulge) {
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (!bulge || chord < 1e-12) return `L${f(b.x)} ${f(b.y)}`;
  const r = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  return `A${f(r)} ${f(r)} 0 ${Math.abs(bulge) > 1 ? 1 : 0} ${bulge > 0 ? 1 : 0} ${f(b.x)} ${f(b.y)}`;
}
function polylineData(points, bulges, closed) {
  if (points.length < 2) return null;
  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length; i++) d += bulgeArc(points[i - 1], points[i], bulges[i - 1]);
  if (closed) d += `${bulgeArc(points.at(-1), points[0], bulges.at(-1))}Z`;
  return d;
}
// Arc of an ellipse (or circle) from parameter t0 counter-clockwise by span.
function ellipseData(c, major, minor, t0, span) {
  const at = (t) => ({
      x: c.x + major.x * Math.cos(t) + minor.x * Math.sin(t),
      y: c.y + major.y * Math.cos(t) + minor.y * Math.sin(t),
    }),
    rx = Math.hypot(major.x, major.y),
    ry = Math.hypot(minor.x, minor.y),
    rot = deg(Math.atan2(major.y, major.x)),
    // Sweep follows the direction from the major to the minor axis.
    sweep = major.x * minor.y - major.y * minor.x > 0 ? 1 : 0,
    full = span >= 2 * Math.PI - 1e-9;
  if (rx < 1e-12 || ry < 1e-12) return null;
  const p0 = at(t0),
    arc = (t, large) => `A${f(rx)} ${f(ry)} ${f(rot)} ${large} ${sweep} ${f(at(t).x)} ${f(at(t).y)}`;
  return full
    ? `M${f(p0.x)} ${f(p0.y)}${arc(t0 + Math.PI, 0)}${arc(t0, 0)}Z`
    : `M${f(p0.x)} ${f(p0.y)}${arc(t0 + span, span > Math.PI ? 1 : 0)}`;
}
const positiveSpan = (a, b) => {
  let s = (b - a) % (2 * Math.PI);
  if (s <= 1e-12) s += 2 * Math.PI;
  return s;
};
// Non-uniform rational B-spline sampled into a polyline (de Boor).
function splineData(rec) {
  const degree = num(rec, 71, 3),
    knots = all(rec, 40),
    xs = all(rec, 10),
    ys = all(rec, 20),
    weights = all(rec, 41),
    closed = (num(rec, 70, 0) & 1) === 1;
  const controls = xs.map((x, i) => ({ x, y: ys[i] ?? 0, w: weights[i] ?? 1 }));
  if (controls.length > degree && knots.length === controls.length + degree + 1) {
    const lo = knots[degree],
      hi = knots[controls.length],
      steps = Math.min(4000, Math.max(16, controls.length * 16)),
      points = [];
    for (let s = 0; s <= steps; s++) {
      const t = s === steps ? hi : lo + ((hi - lo) * s) / steps;
      let k = degree;
      while (k < controls.length - 1 && t >= knots[k + 1]) k++;
      const d = [];
      for (let j = 0; j <= degree; j++) {
        const c = controls[k - degree + j];
        d.push({ x: c.x * c.w, y: c.y * c.w, w: c.w });
      }
      for (let r = 1; r <= degree; r++)
        for (let j = degree; j >= r; j--) {
          const i = k - degree + j,
            den = knots[i + degree - r + 1] - knots[i],
            a = den ? (t - knots[i]) / den : 0;
          d[j] = {
            x: (1 - a) * d[j - 1].x + a * d[j].x,
            y: (1 - a) * d[j - 1].y + a * d[j].y,
            w: (1 - a) * d[j - 1].w + a * d[j].w,
          };
        }
      points.push({ x: d[degree].x / d[degree].w, y: d[degree].y / d[degree].w });
    }
    return polylineData(points, [], closed);
  }
  // Without a usable knot vector, the fit points (or controls) as a polyline.
  const fx = all(rec, 11),
    fy = all(rec, 21),
    fit = fx.length >= 2 ? fx.map((x, i) => ({ x, y: fy[i] ?? 0 })) : controls;
  return polylineData(fit, [], closed);
}
// Object coordinate systems with a downward extrusion are mirrored in X.
const mirroredOCS = (rec) => num(rec, 230, 1) < 0;
function entityData(rec) {
  switch (rec.type) {
    case "LINE":
      return `M${f(num(rec, 10))} ${f(num(rec, 20))}L${f(num(rec, 11))} ${f(num(rec, 21))}`;
    case "CIRCLE": {
      const r = num(rec, 40);
      return ellipseData({ x: num(rec, 10), y: num(rec, 20) }, { x: r, y: 0 }, { x: 0, y: r }, 0, 2 * Math.PI);
    }
    case "ARC": {
      const r = num(rec, 40),
        a0 = rad(num(rec, 50)),
        a1 = rad(num(rec, 51));
      return ellipseData({ x: num(rec, 10), y: num(rec, 20) }, { x: r, y: 0 }, { x: 0, y: r }, a0, positiveSpan(a0, a1));
    }
    case "ELLIPSE": {
      const major = { x: num(rec, 11), y: num(rec, 21) },
        ratio = num(rec, 40, 1),
        side = mirroredOCS(rec) ? -1 : 1,
        minor = { x: -major.y * ratio * side, y: major.x * ratio * side },
        t0 = num(rec, 41, 0),
        t1 = num(rec, 42, 2 * Math.PI);
      return ellipseData({ x: num(rec, 10), y: num(rec, 20) }, major, minor, t0, positiveSpan(t0, t1));
    }
    case "LWPOLYLINE": {
      // Bulges (42) belong to the vertex before them.
      const points = [],
        bulges = [];
      for (const [code, value] of rec.pairs) {
        if (code === 10) {
          points.push({ x: Number(value), y: 0 });
          bulges.push(0);
        } else if (code === 20 && points.length) points.at(-1).y = Number(value);
        else if (code === 42 && points.length) bulges[bulges.length - 1] = Number(value);
      }
      if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw Error("座標が不正です。");
      return polylineData(points, bulges, (num(rec, 70, 0) & 1) === 1);
    }
    case "POLYLINE": {
      // Meshes and polyface meshes (flags 16, 64) are 3D surfaces.
      if (num(rec, 70, 0) & (16 | 64)) return undefined;
      const points = rec.vertices.map((v) => ({ x: num(v, 10), y: num(v, 20) })),
        bulges = rec.vertices.map((v) => num(v, 42, 0));
      return polylineData(points, bulges, (num(rec, 70, 0) & 1) === 1);
    }
    case "SPLINE":
      return splineData(rec);
    default:
      return undefined;
  }
}
// OCS entities (2D ones) are mirrored in X when extruded downwards; LINE,
// SPLINE and ELLIPSE are already in world coordinates.
const OCS = new Set(["CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE"]);

// Walks entities (and block references) into world paths with their layer.
function collect(records, matrix, blocks, hidden, state, depth = 0, parentLayer = null) {
  for (const rec of joinPolylines(records)) {
    if (num(rec, 67, 0) === 1) continue; // paper space
    const own = get(rec, 8, "0"),
      layer = own === "0" && parentLayer !== null ? parentLayer : own;
    if (hidden.has(layer)) continue;
    if (rec.type === "INSERT") {
      const block = blocks.get(get(rec, 2, ""));
      if (!block || depth >= MAX_DEPTH) {
        state.invalid++;
        continue;
      }
      const angle = rad(num(rec, 50, 0)),
        sx = num(rec, 41, 1),
        sy = num(rec, 42, 1),
        c = Math.cos(angle),
        s = Math.sin(angle);
      let m = multiply(matrix, mirroredOCS(rec) ? [-1, 0, 0, 1, 0, 0] : [1, 0, 0, 1, 0, 0]);
      m = multiply(m, [1, 0, 0, 1, num(rec, 10), num(rec, 20)]);
      m = multiply(m, [c, s, -s, c, 0, 0]);
      m = multiply(m, [sx, 0, 0, sy, 0, 0]);
      m = multiply(m, [1, 0, 0, 1, -block.base.x, -block.base.y]);
      collect(block.entities, m, blocks, hidden, state, depth + 1, layer);
      continue;
    }
    if (SILENT.has(rec.type)) continue;
    let d;
    try {
      d = entityData(rec);
    } catch {
      state.invalid++;
      continue;
    }
    if (d === undefined) {
      const label = SKIPPED[rec.type] ?? rec.type;
      state.skipped[label] = (state.skipped[label] ?? 0) + 1;
      continue;
    }
    if (!d) {
      state.invalid++;
      continue;
    }
    if (++state.count > MAX_PATHS) throw Error("DXFの図形が多すぎます。");
    const m = OCS.has(rec.type) && mirroredOCS(rec) ? multiply(matrix, [-1, 0, 0, 1, 0, 0]) : matrix;
    try {
      const path = transformPath(parsePathData(d), (p) => applyMatrix(m, p));
      for (const sub of path)
        state.pieces.push({ sub, layer, name: NAMES[rec.type] ?? rec.type });
    } catch {
      state.invalid++;
    }
  }
}

// ---- joining and nesting ----
const near = (a, b, tol) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
function reversed(sub) {
  return {
    closed: sub.closed,
    nodes: sub.nodes
      .slice()
      .reverse()
      .map(({ in: i, out: o, ...n }) => ({ ...n, ...(o ? { in: o } : {}), ...(i ? { out: i } : {}) })),
  };
}
// Appends b to a (b starts where a ends): the shared anchor keeps a's
// incoming handle and b's outgoing one.
function append(a, b) {
  const last = a.nodes.at(-1),
    first = b.nodes[0];
  const joint = { ...last };
  delete joint.out;
  if (first.out) joint.out = first.out;
  delete joint.smooth;
  return { closed: false, nodes: [...a.nodes.slice(0, -1), joint, ...b.nodes.slice(1)] };
}
// Joins open subpaths whose ends meet (within tol) into longer ones, and
// closes those that come back to their start. Endpoints are indexed on a
// grid of the tolerance, so large drawings stay fast.
export function joinOpenPaths(pieces, tol = JOIN_TOLERANCE_MM) {
  const open = pieces.filter((p) => !p.sub.closed && p.sub.nodes.length >= 2),
    done = pieces.filter((p) => p.sub.closed || p.sub.nodes.length < 2);
  const key = (p) => `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`,
    index = new Map(),
    used = new Set();
  const add = (p, n) => {
    const k = key(p);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(n);
  };
  open.forEach((piece, n) => {
    add(piece.sub.nodes[0], n);
    add(piece.sub.nodes.at(-1), n);
  });
  const find = (p, layer) => {
    const [gx, gy] = key(p).split(",").map(Number);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const n of index.get(`${gx + dx},${gy + dy}`) ?? []) {
          if (used.has(n) || open[n].layer !== layer) continue;
          const s = open[n].sub;
          if (near(s.nodes[0], p, tol)) return { n, sub: s };
          if (near(s.nodes.at(-1), p, tol)) return { n, sub: reversed(s) };
        }
    return null;
  };
  open.forEach((piece, n) => {
    if (used.has(n)) return;
    used.add(n);
    let sub = piece.sub,
      joined = 0;
    // Grow forwards from the end, then backwards from the start.
    for (let next; (next = find(sub.nodes.at(-1), piece.layer)); joined++) {
      used.add(next.n);
      sub = append(sub, next.sub);
    }
    for (let prev; (prev = find(sub.nodes[0], piece.layer)); joined++) {
      used.add(prev.n);
      sub = reversed(append(reversed(sub), prev.sub));
    }
    if (sub.nodes.length > 2 && near(sub.nodes[0], sub.nodes.at(-1), tol)) {
      const last = sub.nodes.at(-1),
        first = { ...sub.nodes[0] };
      delete first.in;
      if (last.in) first.in = last.in;
      delete first.smooth;
      sub = { closed: true, nodes: [first, ...sub.nodes.slice(1, -1)] };
    }
    done.push({ sub, layer: piece.layer, name: joined ? (sub.closed ? "輪郭" : "線") : piece.name });
  });
  return done;
}
// Closed outlines of one layer grouped as outer + direct holes (even–odd
// nesting); holes are wound against their outer so the nonzero fill used
// everywhere in TypeFab shows them as holes. Open lines stay on their own.
export function nestShapes(pieces) {
  const closed = pieces
      .filter((p) => p.sub.closed)
      .map((p) => {
        const contour = pathContours([p.sub])[0] ?? [];
        return { ...p, contour, area: Math.abs(signedArea(contour)) };
      })
      .filter((p) => p.contour.length > 3 && p.area > 1e-9)
      .sort((a, b) => b.area - a.area),
    shapes = [];
  for (const [n, p] of closed.entries()) {
    const probe = p.contour[0],
      parents = closed.slice(0, n).filter((q) => q.layer === p.layer && containsPoint(probe, q.contour));
    p.depth = parents.length;
    p.parent = parents.at(-1) ?? null;
    const wantPositive = p.depth % 2 === 0;
    if (signedArea(p.contour) > 0 !== wantPositive) p.sub = reversed(p.sub);
  }
  for (const outer of closed.filter((p) => p.depth % 2 === 0)) {
    const holes = closed.filter((p) => p.parent === outer && p.depth % 2 === 1);
    shapes.push({
      name: holes.length ? "輪郭" : outer.name,
      path: [outer.sub, ...holes.map((h) => h.sub)],
      layer: outer.layer,
    });
  }
  for (const p of pieces.filter((q) => !q.sub.closed))
    shapes.push({ name: p.name, path: [p.sub], layer: p.layer });
  return shapes;
}

// DXF text → { shapes, skipped, invalid, units }. Layer "0" maps to the
// active layer (null); other layer names are kept.
export function dxfShapes(text) {
  const { header, tables, blocks, entities } = sectionsOf(pairsOf(text)),
    units = unitsOf(header),
    state = { pieces: [], skipped: {}, invalid: 0, count: 0 };
  // Units to mm and Y up (drawing) to Y down (screen).
  collect(entities, [units.scale, 0, 0, -units.scale, 0, 0], blocksOf(blocks), hiddenLayers(tables), state);
  const shapes = nestShapes(joinOpenPaths(state.pieces)).map((s) => ({
    ...s,
    layer: s.layer === "0" ? null : s.layer,
  }));
  return { shapes, skipped: state.skipped, invalid: state.invalid, units };
}
