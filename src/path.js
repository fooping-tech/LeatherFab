import { flatten, TOLERANCE } from "./geometry.js";
// Editable Bézier paths. A path is a list of subpaths { closed, nodes }. A node
// is an anchor { x, y } with optional absolute handles `in` and `out` and a
// `smooth` flag (handles kept on one line). The segment from a node to the
// next is a cubic when either adjacent handle exists and a straight line
// otherwise, so a path maps 1:1 onto SVG path data made of M, L, C and Z.
// Coordinates are item-local millimetres.
const P = (x, y) => ({ x, y });
const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-7;
const exact = (a, b) => a.x === b.x && a.y === b.y;
const sub = (a, b) => P(a.x - b.x, a.y - b.y);
const add = (a, b) => P(a.x + b.x, a.y + b.y);
const mul = (a, k) => P(a.x * k, a.y * k);
const len = (a) => Math.hypot(a.x, a.y);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const unit = (a) => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : P(0, 0);
};
const lerp = (a, b, t) => P(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
export const nodeKey = (s, n) => `${s}:${n}`;
export const parseKey = (key) => key.split(":").map(Number);
export const nodeAt = (path, key) => {
  const [s, n] = parseKey(key);
  return path[s]?.nodes[n];
};
export const nodeKeys = (path) =>
  path.flatMap((sub, s) => sub.nodes.map((_, n) => nodeKey(s, n)));
function bezierAt(b, t) {
  const s = 1 - t;
  return P(
    s * s * s * b[0].x +
      3 * s * s * t * b[1].x +
      3 * s * t * t * b[2].x +
      t * t * t * b[3].x,
    s * s * s * b[0].y +
      3 * s * s * t * b[1].y +
      3 * s * t * t * b[2].y +
      t * t * t * b[3].y,
  );
}
// The Bézier control polygon of segment i of a subpath, or null for a line.
export function segmentCurve(sub, i) {
  const a = sub.nodes[i],
    b = sub.nodes[(i + 1) % sub.nodes.length];
  return a.out || b.in ? [a, a.out ?? a, b.in ?? b, b] : null;
}
const segmentCount = (sub) =>
  sub.closed ? sub.nodes.length : Math.max(0, sub.nodes.length - 1);
// Handles that coincide with their anchor carry no information.
function tidy(node) {
  if (node.in && exact(node.in, node)) delete node.in;
  if (node.out && exact(node.out, node)) delete node.out;
  if (!node.in || !node.out) delete node.smooth;
  return node;
}
// Nodes whose two handles are collinear through the anchor are smooth.
export function markSmooth(path) {
  for (const s of path)
    for (const node of s.nodes) {
      delete node.smooth;
      if (
        node.in &&
        node.out &&
        dot(unit(sub(node, node.in)), unit(sub(node.out, node))) > 0.9986
      )
        node.smooth = true;
    }
  return path;
}
// Shared by the SVG parser and glyph commands. Handles equal to their anchor
// are dropped exactly, so a flattened result matches the source commands
// (apart from repeated points of zero-length lines).
function builder() {
  const path = [];
  let current = null;
  const ensure = (from) => {
    if (!current || current.closed) {
      current = { closed: false, nodes: [P(from.x, from.y)] };
      path.push(current);
    }
  };
  return {
    path,
    move(p) {
      current = { closed: false, nodes: [P(p.x, p.y)] };
      path.push(current);
    },
    line(from, p) {
      ensure(from);
      // Zero-length lines (opentype.js starts TrueType contours with one)
      // would stack two nodes on the same spot.
      if (!exact(p, current.nodes.at(-1))) current.nodes.push(P(p.x, p.y));
    },
    curve(from, c1, c2, p) {
      ensure(from);
      const last = current.nodes.at(-1),
        node = P(p.x, p.y);
      if (!exact(c1, last)) last.out = P(c1.x, c1.y);
      if (!exact(c2, p)) node.in = P(c2.x, c2.y);
      current.nodes.push(node);
    },
    close() {
      if (!current || current.closed) return;
      const nodes = current.nodes;
      if (nodes.length > 1 && exact(nodes[0], nodes.at(-1))) {
        const last = nodes.pop();
        if (last.in) nodes[0].in = last.in;
      }
      current.closed = true;
    },
  };
}
const quadHandles = (from, q, to) => [
  P(from.x + (2 / 3) * (q.x - from.x), from.y + (2 / 3) * (q.y - from.y)),
  P(to.x + (2 / 3) * (q.x - to.x), to.y + (2 / 3) * (q.y - to.y)),
];
// opentype.js glyph commands (absolute M, L, C, Q, Z) to a path.
export function pathFromCommands(commands) {
  const b = builder();
  let cur = P(0, 0),
    start = cur;
  for (const c of commands) {
    if (c.type === "Z") {
      b.close();
      cur = start;
      continue;
    }
    const p = P(c.x, c.y);
    if (c.type === "M") {
      b.move(p);
      start = p;
    } else if (c.type === "L") b.line(cur, p);
    else if (c.type === "C") b.curve(cur, P(c.x1, c.y1), P(c.x2, c.y2), p);
    else if (c.type === "Q")
      b.curve(cur, ...quadHandles(cur, P(c.x1, c.y1), p), p);
    cur = p;
  }
  return markSmooth(b.path.filter((s) => s.nodes.length > 1));
}
// Elliptical arc (SVG A) as cubics of at most 90° each, following the SVG
// implementation notes (endpoint to centre parameterisation). Returns null
// when a radius is zero, which SVG draws as a straight line.
function arcCurves(p1, rx, ry, degrees, large, sweep, p2) {
  if (exact(p1, p2)) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return null;
  const phi = (degrees * Math.PI) / 180,
    cos = Math.cos(phi),
    sin = Math.sin(phi),
    hx = (p1.x - p2.x) / 2,
    hy = (p1.y - p2.y) / 2,
    x1 = cos * hx + sin * hy,
    y1 = -sin * hx + cos * hy,
    lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1,
    den = rx * rx * y1 * y1 + ry * ry * x1 * x1,
    coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den)),
    cx1 = (coef * rx * y1) / ry,
    cy1 = (-coef * ry * x1) / rx,
    cx = cos * cx1 - sin * cy1 + (p1.x + p2.x) / 2,
    cy = sin * cx1 + cos * cy1 + (p1.y + p2.y) / 2,
    angle = (ux, uy, vx, vy) =>
      Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy),
    start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle(
    (x1 - cx1) / rx,
    (y1 - cy1) / ry,
    (-x1 - cx1) / rx,
    (-y1 - cy1) / ry,
  );
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9)),
    step = delta / n,
    t = (4 / 3) * Math.tan(step / 4),
    at = (a) =>
      P(
        cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin,
        cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos,
      ),
    tangent = (a) =>
      P(
        -rx * Math.sin(a) * cos - ry * Math.cos(a) * sin,
        -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos,
      ),
    curves = [];
  for (let k = 0; k < n; k++) {
    const a0 = start + k * step,
      a1 = a0 + step,
      q0 = k ? curves[k - 1][2] : p1,
      q3 = k === n - 1 ? P(p2.x, p2.y) : at(a1);
    curves.push([
      add(q0, mul(tangent(a0), t)),
      sub(q3, mul(tangent(a1), t)),
      q3,
    ]);
  }
  return curves;
}
// SVG path data with M L H V C S Q T A Z (absolute and relative). Quadratic
// segments become the equivalent cubics, arcs cubics of up to 90°.
export function parsePathData(d) {
  if (typeof d !== "string" || d.length > 2_000_000)
    throw Error("SVGパスが不正です。");
  if (/[^\s,a-zA-Z0-9.+-]/.test(d))
    throw Error("SVGパスに使えない文字があります。");
  const tokens =
    d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const b = builder();
  let i = 0,
    cmd = null,
    cur = P(0, 0),
    start = cur,
    lastC = null,
    lastQ = null;
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || /^[a-zA-Z]$/.test(t))
      throw Error("SVGパスの数値が足りません。");
    return Number(t);
  };
  // Arc flags may be written without separators ("a5 5 0 0110 0").
  const flag = () => {
    const t = tokens[i];
    if (t === undefined || !/^[01]/.test(t))
      throw Error("円弧（A）のフラグは 0 か 1 です。");
    if (t.length === 1) i++;
    else tokens[i] = t.slice(1);
    return t[0] === "1";
  };
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd || cmd === "Z" || cmd === "z")
      throw Error("SVGパスの形式が不正です。M で始めてください。");
    const rel = cmd === cmd.toLowerCase(),
      C = cmd.toUpperCase(),
      pt = () => {
        const x = num(),
          y = num();
        return rel ? P(cur.x + x, cur.y + y) : P(x, y);
      };
    let c2 = null,
      q = null;
    if (C !== "M" && !b.path.length)
      throw Error("SVGパスは M で始めてください。");
    if (C === "M") {
      const p = pt();
      b.move(p);
      cur = start = p;
      cmd = rel ? "l" : "L";
    } else if (C === "L") {
      const p = pt();
      b.line(cur, p);
      cur = p;
    } else if (C === "H" || C === "V") {
      const v = num(),
        p =
          C === "H"
            ? P(rel ? cur.x + v : v, cur.y)
            : P(cur.x, rel ? cur.y + v : v);
      b.line(cur, p);
      cur = p;
    } else if (C === "C" || C === "S") {
      const c1 =
        C === "S"
          ? lastC
            ? P(2 * cur.x - lastC.x, 2 * cur.y - lastC.y)
            : cur
          : pt();
      c2 = pt();
      const p = pt();
      b.curve(cur, c1, c2, p);
      cur = p;
    } else if (C === "Q" || C === "T") {
      q =
        C === "T"
          ? lastQ
            ? P(2 * cur.x - lastQ.x, 2 * cur.y - lastQ.y)
            : cur
          : pt();
      const p = pt();
      b.curve(cur, ...quadHandles(cur, q, p), p);
      cur = p;
    } else if (C === "Z") {
      b.close();
      cur = start;
    } else if (C === "A") {
      const rx = num(),
        ry = num(),
        angle = num(),
        large = flag(),
        sweep = flag(),
        p = pt(),
        curves = arcCurves(cur, rx, ry, angle, large, sweep, p);
      if (!curves) b.line(cur, p);
      else for (const [c1, c2, q] of curves) b.curve(cur, c1, c2, q);
      cur = p;
    } else throw Error(`未対応のパスコマンド: ${cmd}`);
    if (![cur.x, cur.y].every(Number.isFinite))
      throw Error("SVGパスの数値が不正です。");
    lastC = c2;
    lastQ = q;
  }
  const path = b.path.filter((s) => s.nodes.length > 1);
  if (!path.length) throw Error("線を含むパスがありません。");
  return markSmooth(path);
}
// Commands for geometry.flatten: M, then L or C per segment, then Z.
export function pathCommands(path) {
  const out = [];
  for (const s of path) {
    if (!s.nodes.length) continue;
    out.push({ type: "M", x: s.nodes[0].x, y: s.nodes[0].y });
    for (let i = 0; i < segmentCount(s); i++) {
      const c = segmentCurve(s, i),
        b = s.nodes[(i + 1) % s.nodes.length];
      out.push(
        c
          ? {
              type: "C",
              x1: c[1].x,
              y1: c[1].y,
              x2: c[2].x,
              y2: c[2].y,
              x: b.x,
              y: b.y,
            }
          : { type: "L", x: b.x, y: b.y },
      );
    }
    if (s.closed) out.push({ type: "Z" });
  }
  return out;
}
// The cut outline of a path, flattened within the usual 0.02 mm.
export const pathContours = (path) => flatten(pathCommands(path));
// SVG path data (M, L, C, Z). A straight closing segment is left to Z.
export function toPathData(path) {
  const f = (v) => String(Number(v.toFixed(4))),
    xy = (x, y) => `${f(x)} ${f(y)}`;
  const commands = pathCommands(path),
    parts = [];
  let start = null;
  commands.forEach((c, i) => {
    if (c.type === "M") {
      start = c;
      parts.push(`M${xy(c.x, c.y)}`);
    } else if (c.type === "L") {
      if (commands[i + 1]?.type === "Z" && c.x === start.x && c.y === start.y)
        return;
      parts.push(`L${xy(c.x, c.y)}`);
    } else if (c.type === "C")
      parts.push(`C${xy(c.x1, c.y1)} ${xy(c.x2, c.y2)} ${xy(c.x, c.y)}`);
    else parts.push("Z");
  });
  return parts.join(" ");
}
export function transformPath(path, map) {
  return path.map((s) => ({
    ...s,
    nodes: s.nodes.map((node) => {
      const next = { ...node, ...map(node) };
      if (node.in) next.in = map(node.in);
      if (node.out) next.out = map(node.out);
      return next;
    }),
  }));
}
// Exact paths for the basic shapes (ellipse arcs as the standard 4 cubics).
const KAPPA = 0.5522847498307936;
// A rectangle may have different horizontal and vertical corner radii (as SVG
// rx/ry); a single radius is clamped to half the shorter side.
export function shapePath(type, w, h, radius = 0, radiusY) {
  if (type === "circle") {
    const cx = w / 2,
      cy = h / 2,
      kx = KAPPA * cx,
      ky = KAPPA * cy;
    return [
      {
        closed: true,
        nodes: [
          { x: w, y: cy, in: P(w, cy - ky), out: P(w, cy + ky), smooth: true },
          { x: cx, y: h, in: P(cx + kx, h), out: P(cx - kx, h), smooth: true },
          { x: 0, y: cy, in: P(0, cy + ky), out: P(0, cy - ky), smooth: true },
          { x: cx, y: 0, in: P(cx - kx, 0), out: P(cx + kx, 0), smooth: true },
        ],
      },
    ];
  }
  const rx =
      radiusY === undefined
        ? Math.min(radius || 0, w / 2, h / 2)
        : Math.min(radius || 0, w / 2),
    ry = radiusY === undefined ? rx : Math.min(radiusY || 0, h / 2);
  if (!(rx > 0 && ry > 0))
    return [{ closed: true, nodes: [P(0, 0), P(w, 0), P(w, h), P(0, h)] }];
  const kx = KAPPA * rx,
    ky = KAPPA * ry,
    raw = [
      { x: rx, y: 0, in: P(rx - kx, 0) },
      { x: w - rx, y: 0, out: P(w - rx + kx, 0) },
      { x: w, y: ry, in: P(w, ry - ky) },
      { x: w, y: h - ry, out: P(w, h - ry + ky) },
      { x: w - rx, y: h, in: P(w - rx + kx, h) },
      { x: rx, y: h, out: P(rx - kx, h) },
      { x: 0, y: h - ry, in: P(0, h - ry + ky) },
      { x: 0, y: ry, out: P(0, ry - ky) },
    ],
    nodes = [];
  // At the full radius the straight sides vanish and their ends meet.
  for (const node of raw) {
    const last = nodes.at(-1);
    if (last && same(last, node)) {
      if (node.out) last.out = node.out;
    } else nodes.push(node);
  }
  if (nodes.length > 1 && same(nodes[0], nodes.at(-1))) {
    const last = nodes.pop();
    if (last.in) nodes[0].in = last.in;
  }
  return markSmooth([{ closed: true, nodes }]);
}
// ---------------------------------------------------------------------------
// Fitting polylines (flattened or boolean outlines) with cubic curves, after
// Schneider, "An Algorithm for Automatically Fitting Digitized Curves".
// Sharp turns become corner nodes; straight runs become lines.
const CORNER = (45 * Math.PI) / 180;
export function pathFromContours(contours, error = TOLERANCE) {
  return markSmooth(contours.map((c) => fitContour(c, error)).filter(Boolean));
}
// One polyline whose closure and corners are already known (freehand
// strokes, see freehand.js): `corners` are indices into `points`; every
// other node is smooth. A closed stroke ends before its first point.
export function fitStroke(
  points,
  { closed = false, corners = [], error = TOLERANCE } = {},
) {
  const sub = fitContour(points, error, { closed, corners });
  return sub ? markSmooth([sub]) : [];
}
function fitContour(contour, error, forced = null) {
  const closed = forced
      ? forced.closed
      : contour.length > 3 && same(contour[0], contour.at(-1)),
    pts = [],
    index = [];
  for (const p of closed && !forced ? contour.slice(0, -1) : contour) {
    if (!pts.length || !same(pts.at(-1), p)) pts.push(P(p.x, p.y));
    index.push(pts.length - 1);
  }
  if (closed && pts.length > 1 && same(pts[0], pts.at(-1))) pts.pop();
  const n = pts.length;
  if (n < (closed ? 3 : 2)) return null;
  const turn = (i) => {
    const a = unit(sub(pts[i], pts[(i - 1 + n) % n])),
      b = unit(sub(pts[(i + 1) % n], pts[i]));
    return Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  };
  let corners = [];
  if (forced) {
    const set = new Set(
      forced.corners.map((i) => index[i] ?? 0).map((i) => (i >= n ? 0 : i)),
    );
    if (!closed) set.add(0).add(n - 1);
    corners = [...set].sort((a, b) => a - b);
  } else
    for (let i = 0; i < n; i++)
      if ((!closed && (i === 0 || i === n - 1)) || turn(i) > CORNER)
        corners.push(i);
  const loop = closed && !corners.length;
  if (loop) corners = [0];
  const curves = [],
    runs = closed ? corners.length : corners.length - 1;
  for (let k = 0; k < runs; k++) {
    const s = corners[k],
      e = corners[(k + 1) % corners.length],
      run = [];
    for (let i = s; ; i = (i + 1) % n) {
      run.push(pts[i]);
      if (i === e && run.length > 1) break;
    }
    // A cornerless loop starts at a smooth joint with the local tangent.
    const t1 = loop ? unit(sub(pts[1], pts[n - 1])) : unit(sub(run[1], run[0])),
      t2 = loop ? mul(t1, -1) : unit(sub(run.at(-2), run.at(-1)));
    fitCubic(run, t1, t2, error, curves, 0);
  }
  const nodes = [];
  for (const c of curves) {
    if (!nodes.length) nodes.push(P(c[0].x, c[0].y));
    const a = nodes.at(-1),
      node = P(c[3].x, c[3].y);
    if (!isLine(c, error)) {
      a.out = c[1];
      node.in = c[2];
    }
    nodes.push(node);
  }
  if (closed) {
    const last = nodes.pop();
    if (last.in) nodes[0].in = last.in;
  }
  return { closed, nodes };
}
function isLine(c, error) {
  const chord = sub(c[3], c[0]),
    l = len(chord);
  return [c[1], c[2]].every((h) => {
    const v = sub(h, c[0]);
    if (l < 1e-9) return len(v) < error;
    const t = dot(v, chord) / (l * l),
      off = Math.abs(v.x * chord.y - v.y * chord.x) / l;
    return off <= error / 2 && t > -0.01 && t < 1.01;
  });
}
function fitCubic(d, t1, t2, error, out, depth) {
  const first = d[0],
    last = d.at(-1),
    seg = dist(first, last);
  if (d.length === 2) {
    // Two points: follow the tangents unless that bows off the segment.
    const c = [
      first,
      add(first, mul(t1, seg / 3)),
      add(last, mul(t2, seg / 3)),
      last,
    ];
    out.push(
      [0.25, 0.5, 0.75].some(
        (t) => segmentDistance(bezierAt(c, t), first, last) > error,
      )
        ? [first, lerp(first, last, 1 / 3), lerp(first, last, 2 / 3), last]
        : c,
    );
    return;
  }
  let u = chordParams(d),
    curve = generate(d, u, t1, t2),
    [err, split] = maxError(d, curve, u);
  // A run that returns to its start is always split once first.
  if (seg > 1e-9 || depth > 0) {
    if (err <= error) {
      out.push(curve);
      return;
    }
    // Flattened curves are sampled exactly on the curve, so reparameterising
    // usually recovers the original cubic instead of splitting it.
    if (err <= error * 25)
      for (let k = 0; k < 40; k++) {
        u = u.map((t, i) => newton(curve, d[i], t));
        curve = generate(d, u, t1, t2);
        [err, split] = maxError(d, curve, u);
        if (err <= error) {
          out.push(curve);
          return;
        }
      }
  } else
    split = d.reduce(
      (best, p, i) => (dist(p, first) > dist(d[best], first) ? i : best),
      1,
    );
  if (depth > 32) {
    out.push(curve);
    return;
  }
  split = Math.max(1, Math.min(d.length - 2, split));
  let center = unit(sub(d[split - 1], d[split + 1]));
  if (!len(center)) center = unit(sub(d[split - 1], d[split]));
  fitCubic(d.slice(0, split + 1), t1, center, error, out, depth + 1);
  fitCubic(d.slice(split), mul(center, -1), t2, error, out, depth + 1);
}
function chordParams(d) {
  const u = [0];
  for (let i = 1; i < d.length; i++) u.push(u[i - 1] + dist(d[i], d[i - 1]));
  const total = u.at(-1) || 1;
  return u.map((v) => v / total);
}
function generate(d, u, t1, t2) {
  const first = d[0],
    last = d.at(-1);
  let c00 = 0,
    c01 = 0,
    c11 = 0,
    x0 = 0,
    x1 = 0;
  d.forEach((p, i) => {
    const t = u[i],
      s = 1 - t,
      b0 = s * s * s,
      b1 = 3 * s * s * t,
      b2 = 3 * s * t * t,
      b3 = t * t * t,
      a1 = mul(t1, b1),
      a2 = mul(t2, b2),
      tmp = sub(p, add(mul(first, b0 + b1), mul(last, b2 + b3)));
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  });
  const det = c00 * c11 - c01 * c01,
    seg = dist(first, last);
  let al = det ? (x0 * c11 - x1 * c01) / det : 0,
    ar = det ? (c00 * x1 - c01 * x0) / det : 0;
  if (al < 1e-6 * seg || ar < 1e-6 * seg) al = ar = seg / 3;
  return [first, add(first, mul(t1, al)), add(last, mul(t2, ar)), last];
}
// Error at the data points and, so curves cannot bulge between sparse
// points, between each pair against the polyline segment.
function maxError(d, curve, u) {
  let max = 0,
    split = Math.floor(d.length / 2);
  for (let i = 1; i < d.length; i++) {
    const e = dist(bezierAt(curve, u[i]), d[i]),
      m = segmentDistance(
        bezierAt(curve, (u[i - 1] + u[i]) / 2),
        d[i - 1],
        d[i],
      );
    if (i < d.length - 1 && e > max) {
      max = e;
      split = i;
    }
    if (m > max) {
      max = m;
      split = i === d.length - 1 ? i - 1 : i;
    }
  }
  return [max, split];
}
function segmentDistance(p, a, b) {
  const ab = sub(b, a),
    l = dot(ab, ab),
    t = l ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l)) : 0;
  return dist(p, add(a, mul(ab, t)));
}
function newton(q, p, t) {
  const d1 = [0, 1, 2].map((i) => mul(sub(q[i + 1], q[i]), 3)),
    d2 = [0, 1].map((i) => mul(sub(d1[i + 1], d1[i]), 2)),
    s = 1 - t,
    qt = bezierAt(q, t),
    q1 = add(add(mul(d1[0], s * s), mul(d1[1], 2 * s * t)), mul(d1[2], t * t)),
    q2 = lerp(d2[0], d2[1], t),
    diff = sub(qt, p),
    den = dot(q1, q1) + dot(diff, q2);
  return den ? Math.max(0, Math.min(1, t - dot(diff, q1) / den)) : t;
}
// ---------------------------------------------------------------------------
// Node editing. Every operation returns a new path; the input is untouched.
export function moveNodes(path, keys, dx, dy) {
  const next = structuredClone(path);
  for (const key of keys) {
    const node = nodeAt(next, key);
    if (node)
      for (const p of [node, node.in, node.out])
        if (p) {
          p.x += dx;
          p.y += dy;
        }
  }
  return next;
}
// Smooth nodes turn the opposite handle with the dragged one, keeping its
// length; corner nodes (or breakSmooth, e.g. Alt) move one handle alone.
export function moveHandle(path, key, side, point, breakSmooth = false) {
  const next = structuredClone(path),
    node = nodeAt(next, key),
    other = side === "in" ? "out" : "in";
  node[side] = P(point.x, point.y);
  if (breakSmooth) delete node.smooth;
  else if (node.smooth && node[other]) {
    const d = unit(sub(node, node[side]));
    if (len(d)) node[other] = add(node, mul(d, dist(node[other], node)));
  }
  tidy(node);
  return next;
}
// "smooth" aligns both handles through the anchor (creating them from the
// neighbours on line nodes), "corner" unlinks them, "line" removes them.
export function setNodeType(path, keys, type) {
  const next = structuredClone(path);
  for (const key of keys) {
    const [s, n] = parseKey(key),
      sp = next[s],
      node = sp?.nodes[n];
    if (!node) continue;
    const count = sp.nodes.length,
      prev = sp.closed || n > 0 ? sp.nodes[(n - 1 + count) % count] : null,
      after = sp.closed || n < count - 1 ? sp.nodes[(n + 1) % count] : null;
    if (type === "line") {
      delete node.in;
      delete node.out;
      delete node.smooth;
    } else if (type === "corner") delete node.smooth;
    else if (type === "smooth" && prev && after) {
      let dir =
        node.in && node.out
          ? unit(add(unit(sub(node.out, node)), unit(sub(node, node.in))))
          : P(0, 0);
      if (!len(dir)) dir = unit(sub(after, prev));
      if (!len(dir)) continue;
      const lin = node.in ? dist(node.in, node) : dist(node, prev) / 3,
        lout = node.out ? dist(node.out, node) : dist(after, node) / 3;
      node.in = add(node, mul(dir, -lin));
      node.out = add(node, mul(dir, lout));
      node.smooth = true;
    } else if (type !== "smooth") throw Error("不明なノードの種類です。");
  }
  return next;
}
// Splits segment i of subpath s at t; curves are split exactly (de Casteljau).
export function insertNode(path, s, i, t) {
  const next = structuredClone(path),
    sp = next[s],
    a = sp.nodes[i],
    b = sp.nodes[(i + 1) % sp.nodes.length],
    c = segmentCurve(sp, i);
  let node;
  if (c) {
    const q0 = lerp(c[0], c[1], t),
      q1 = lerp(c[1], c[2], t),
      q2 = lerp(c[2], c[3], t),
      r0 = lerp(q0, q1, t),
      r1 = lerp(q1, q2, t),
      m = lerp(r0, r1, t);
    a.out = q0;
    b.in = q2;
    node = { x: m.x, y: m.y, in: r0, out: r1, smooth: true };
    tidy(a);
    tidy(b);
    tidy(node);
  } else node = lerp(a, b, t);
  sp.nodes.splice(i + 1, 0, node);
  return { path: next, key: nodeKey(s, i + 1) };
}
// Removes nodes; neighbours keep their handles. Subpaths left without an
// area or a line disappear; the last one cannot be removed.
export function deleteNodes(path, keys) {
  const doomed = new Set(keys);
  const next = structuredClone(path)
    .map((sp, s) => ({
      ...sp,
      nodes: sp.nodes.filter((_, n) => !doomed.has(nodeKey(s, n))),
    }))
    .filter((sp) =>
      sp.closed
        ? sp.nodes.length >= 3 ||
          (sp.nodes.length === 2 && sp.nodes.some((n) => n.in || n.out))
        : sp.nodes.length >= 2,
    );
  if (!next.length)
    throw Error(
      "すべてのノードは削除できません。オブジェクトごと削除してください。",
    );
  return next;
}
// Closest point on any segment, for adding nodes by double-clicking the path.
export function nearestSegment(path, p) {
  let best = { distance: Infinity };
  path.forEach((sp, s) => {
    for (let i = 0; i < segmentCount(sp); i++) {
      const c = segmentCurve(sp, i),
        a = sp.nodes[i],
        b = sp.nodes[(i + 1) % sp.nodes.length],
        at = c ? (t) => bezierAt(c, t) : (t) => lerp(a, b, t);
      let bt = 0,
        bd = Infinity;
      for (let k = 0; k <= 32; k++) {
        const d = dist(at(k / 32), p);
        if (d < bd) {
          bd = d;
          bt = k / 32;
        }
      }
      let lo = Math.max(0, bt - 1 / 32),
        hi = Math.min(1, bt + 1 / 32);
      for (let r = 0; r < 24; r++) {
        const m1 = lo + (hi - lo) / 3,
          m2 = hi - (hi - lo) / 3;
        if (dist(at(m1), p) < dist(at(m2), p)) hi = m2;
        else lo = m1;
      }
      const t = (lo + hi) / 2,
        point = at(t),
        d = dist(point, p);
      if (d < best.distance) best = { s, i, t, distance: d, point };
    }
  });
  return best;
}
// Handles worth showing: those of selected nodes and, as in Illustrator, the
// neighbouring handles of the segments that touch them.
export function visibleHandles(path, selection) {
  const out = new Set();
  for (const key of selection) {
    const [s, n] = parseKey(key),
      sp = path[s];
    if (!sp?.nodes[n]) continue;
    const count = sp.nodes.length;
    out.add(`${key}:in`).add(`${key}:out`);
    if (sp.closed || n > 0)
      out.add(`${nodeKey(s, (n - 1 + count) % count)}:out`);
    if (sp.closed || n < count - 1)
      out.add(`${nodeKey(s, (n + 1) % count)}:in`);
  }
  return [...out]
    .map((h) => {
      const [s, n, side] = h.split(":");
      return { key: nodeKey(+s, +n), side };
    })
    .filter(({ key, side }) => nodeAt(path, key)?.[side]);
}
