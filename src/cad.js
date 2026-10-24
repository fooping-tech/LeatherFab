// Non-parametric 2D CAD operations (issue #4): polygons, mirror, patterns,
// offset, trim, extend, fillet, chamfer, measurement and reference
// dimensions. Every operation returns ordinary TypeFab items (or a new path)
// and keeps no link to its source; there is no constraint solver.
import ClipperLib from "clipper-lib";
import { transform, worldContours, bounds, shapeContours, TOLERANCE } from "./geometry.js";
import { pathContours, pathFromContours, shapePath, transformPath } from "./path.js";
import { rotateAbout, normalizeAngle } from "./edit.js";

const P = (x, y) => ({ x, y });
const sub = (a, b) => P(a.x - b.x, a.y - b.y);
const add = (a, b) => P(a.x + b.x, a.y + b.y);
const mul = (a, k) => P(a.x * k, a.y * k);
const len = (a) => Math.hypot(a.x, a.y);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a) => {
  const l = len(a);
  return l < 1e-12 ? P(0, 0) : P(a.x / l, a.y / l);
};
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dot = (a, b) => a.x * b.x + a.y * b.y;
const same = (a, b) => dist(a, b) < 1e-7;
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const num = (n) => Number(n.toFixed(6));
const SCALE = 10000;

// ---------------------------------------------------------------- Polygon
// Regular polygon vertices around (0, 0); the first vertex points up.
export function polygonVertices(sides, radius, rotation = 0) {
  const n = Math.round(sides);
  if (!(n >= 3 && n <= 100)) throw Error("頂点数は3〜100です。");
  if (!(radius > 0) || radius > 1000) throw Error("半径は0より大きく1000 mm以下です。");
  return Array.from({ length: n }, (_, k) => {
    const a = rad(rotation) - Math.PI / 2 + (2 * Math.PI * k) / n;
    return P(num(radius * Math.cos(a)), num(radius * Math.sin(a)));
  });
}
// Polygon as an editable-path outline item placed so that its centre is at
// (cx, cy). The item origin is the top-left of its bounding box.
export function polygonItem({ cx, cy, sides, radius, rotation = 0 }, id, layerId) {
  const verts = polygonVertices(sides, radius, rotation);
  const box = bounds([verts]);
  const nodes = verts.map((p) => P(num(p.x - box.x), num(p.y - box.y)));
  const path = [{ closed: true, nodes }];
  return {
    id,
    type: "outline",
    name: `正${Math.round(sides)}角形`,
    x: num(cx + box.x),
    y: num(cy + box.y),
    rotation: 0,
    layerId,
    ratioLocked: false,
    path,
    contours: pathContours(path),
  };
}

// ---------------------------------------------------------------- Mirror
export function reflectPoint(p, a, b) {
  const d = unit(sub(b, a));
  if (len(d) === 0) throw Error("基準線の2点が同じ位置です。");
  const v = sub(p, a),
    along = dot(v, d);
  const foot = add(a, mul(d, along));
  return sub(mul(foot, 2), p);
}
export function reflectAngle(degrees, a, b) {
  const phi = deg(Math.atan2(b.y - a.y, b.x - a.x));
  return normalizeAngle(2 * phi - degrees);
}
// Fresh ids for a set of copied items; groups and bridge owners are remapped
// inside the set, owners outside the set are dropped (the bridge stays global).
function remap(copies, originals, makeId) {
  const ids = new Map(originals.map((i) => [i.id, makeId()])),
    groups = new Map();
  copies.forEach((copy, n) => {
    copy.id = ids.get(originals[n].id);
    if (copy.targetId !== undefined) {
      if (ids.has(copy.targetId)) copy.targetId = ids.get(copy.targetId);
      else delete copy.targetId;
    }
    if (copy.groupId) {
      if (!groups.has(copy.groupId)) groups.set(copy.groupId, makeId());
      copy.groupId = groups.get(copy.groupId);
    }
  });
  return copies;
}
// Outline copy of an item from mapped world contours (and its editable path
// when it has one and is not warped). Text and warped shapes become outlines.
function mappedOutline(item, map) {
  const world = worldContours(item).map((c) => c.map(map));
  const box = bounds(world);
  const local = (p) => P(num(p.x - box.x), num(p.y - box.y));
  const { text, font, size, spacing, vertical, stretch, warp, w, h, radius, path, ...rest } = item;
  const next = {
    ...rest,
    type: "outline",
    x: num(box.x),
    y: num(box.y),
    rotation: 0,
    contours: world.map((c) => c.map(local)),
  };
  if (path && !warp) {
    next.path = transformPath(path, (p) => local(map(transform(p, item))));
    next.contours = pathContours(next.path);
  }
  return next;
}
export function mirrorItems(items, a, b, makeId) {
  const M = (p) => reflectPoint(p, a, b);
  const copies = items.map((item) => {
    const copy = structuredClone(item);
    if (item.type === "bridge") {
      Object.assign(copy, M(item), { rotation: reflectAngle(item.rotation, a, b) });
      return copy;
    }
    if (item.type === "line") {
      const p0 = M(transform(P(0, 0), item)),
        p1 = M(transform(P(item.w, 0), item));
      Object.assign(copy, p0, {
        rotation: normalizeAngle(deg(Math.atan2(p1.y - p0.y, p1.x - p0.x))),
        w: num(dist(p0, p1)),
        h: 0,
        contours: shapeContours("line", num(dist(p0, p1)), 0),
      });
      return copy;
    }
    if (["rect", "circle"].includes(item.type) && !item.warp) {
      // A mirrored rectangle/ellipse is the same shape: the mirrored bottom-left
      // corner becomes the origin because the reflection flips handedness.
      const o = M(transform(P(0, item.h), item)),
        q = M(transform(P(item.w, item.h), item));
      let rotation = normalizeAngle(deg(Math.atan2(q.y - o.y, q.x - o.x))),
        origin = o;
      // The same box turned by 180° from its opposite corner keeps the
      // rotation small (a mirrored 0° rectangle stays a 0° rectangle).
      if (Math.abs(rotation) > 90 + 1e-9) {
        origin = M(transform(P(item.w, 0), item));
        rotation = normalizeAngle(rotation + 180);
      }
      Object.assign(copy, { x: num(origin.x), y: num(origin.y), rotation });
      return copy;
    }
    return mappedOutline(item, M);
  });
  return remap(copies, items, makeId);
}
// Mirror axes through the centre of a box.
export const axisThrough = (center, direction) =>
  direction === "vertical"
    ? [P(center.x, center.y - 1), P(center.x, center.y + 1)]
    : [P(center.x - 1, center.y), P(center.x + 1, center.y)];

// ---------------------------------------------------------------- Patterns
export function rectangularPattern(items, { columns, rows, dx, dy }, makeId) {
  const c = Math.round(columns),
    r = Math.round(rows);
  if (!(c >= 1 && r >= 1 && c <= 200 && r <= 200)) throw Error("列数・行数は1〜200です。");
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw Error("間隔を数値で入力してください。");
  if (items.length * c * r > 2000) throw Error("複製後のアイテム数が2000を超えます。");
  const copies = [];
  for (let j = 0; j < r; j++)
    for (let i = 0; i < c; i++) {
      if (i === 0 && j === 0) continue;
      const cell = items.map((item) => {
        const copy = structuredClone(item);
        copy.x = num(item.x + i * dx);
        copy.y = num(item.y + j * dy);
        return copy;
      });
      copies.push(...remap(cell, items, makeId));
    }
  return copies;
}
export function circularPattern(items, { center, count, totalAngle = 360 }, makeId) {
  const n = Math.round(count);
  if (!(n >= 2 && n <= 360)) throw Error("個数は2〜360です。");
  if (!(Math.abs(totalAngle) > 0 && Math.abs(totalAngle) <= 360)) throw Error("角度は0より大きく360°以下です。");
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) throw Error("中心を指定してください。");
  if (items.length * n > 2000) throw Error("複製後のアイテム数が2000を超えます。");
  const full = Math.abs(Math.abs(totalAngle) - 360) < 1e-9;
  const step = full ? totalAngle / n : totalAngle / (n - 1);
  const copies = [];
  for (let k = 1; k < n; k++) {
    const cell = items.map((item) => {
      const turned = rotateAbout(structuredClone(item), center, step * k);
      turned.x = num(turned.x);
      turned.y = num(turned.y);
      return turned;
    });
    copies.push(...remap(cell, items, makeId));
  }
  return copies;
}

// ---------------------------------------------------------------- Offset
const JOINS = {
  round: ClipperLib.JoinType.jtRound,
  miter: ClipperLib.JoinType.jtMiter,
  square: ClipperLib.JoinType.jtSquare,
};
const isClosed = (c) => c.length > 3 && same(c[0], c.at(-1));
// Offsets closed contours (holes included) with Clipper; positive = outward.
export function offsetClosed(contours, distance, join = "round") {
  if (!(join in JOINS)) throw Error("不明な角の形です。");
  const paths = ClipperLib.Clipper.SimplifyPolygons(
    contours.map((c) => c.slice(0, -1).map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }))),
    ClipperLib.PolyFillType.pftNonZero,
  );
  const co = new ClipperLib.ClipperOffset(2, TOLERANCE * SCALE);
  co.AddPaths(paths, JOINS[join], ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, distance * SCALE);
  return out
    .filter((c) => c.length >= 3)
    .map((c) => {
      const pts = c.map((p) => P(p.X / SCALE, p.Y / SCALE));
      return [...pts, { ...pts[0] }];
    });
}
// Parallel polyline of an open contour (mitred joints, positive = left side).
export function offsetOpen(points, distance) {
  const pts = points.filter((p, i) => !i || !same(p, points[i - 1]));
  if (pts.length < 2) return [];
  const normals = pts.slice(1).map((p, i) => {
    const d = unit(sub(p, pts[i]));
    return P(-d.y, d.x);
  });
  return pts.map((p, i) => {
    const n1 = normals[Math.max(0, i - 1)],
      n2 = normals[Math.min(normals.length - 1, i)];
    const m = unit(add(n1, n2)),
      cosHalf = dot(m, n2);
    const k = Math.abs(cosHalf) < 0.25 ? 1 : 1 / cosHalf;
    return add(p, mul(m, distance * Math.min(k, 4)));
  });
}
// New outline item with the offset of every contour of the item.
export function offsetItem(item, distance, join, id) {
  if (!Number.isFinite(distance) || distance === 0) throw Error("オフセット距離を入力してください。");
  if (item.type === "bridge") throw Error("ブリッジはオフセットできません。");
  const world = worldContours(item);
  const closed = world.filter(isClosed),
    open = world.filter((c) => !isClosed(c));
  const result = [
    ...(closed.length ? offsetClosed(closed, distance, join) : []),
    ...open.map((c) => offsetOpen(c, distance)).filter((c) => c.length >= 2),
  ];
  if (!result.length) throw Error("オフセット距離が大きすぎて輪郭が消えました。距離を小さくしてください。");
  const box = bounds(result);
  const local = result.map((c) => c.map((p) => P(num(p.x - box.x), num(p.y - box.y))));
  return {
    id,
    type: "outline",
    name: `${item.name} オフセット ${distance > 0 ? "+" : ""}${distance}`,
    x: num(box.x),
    y: num(box.y),
    rotation: 0,
    layerId: item.layerId,
    ratioLocked: false,
    path: pathFromContours(local),
    contours: local,
  };
}

// ---------------------------------------------------------------- Intersections
// Intersection of segments p1→p2 and p3→p4 as parameters t (on the first)
// and u (on the second), both within [0, 1].
export function segmentIntersection(p1, p2, p3, p4) {
  const r = sub(p2, p1),
    s = sub(p4, p3),
    den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const q = sub(p3, p1),
    t = cross(q, s) / den,
    u = cross(q, r) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t: Math.min(1, Math.max(0, t)), u: Math.min(1, Math.max(0, u)), point: add(p1, mul(r, t)) };
}
// Parameters (segment index + fraction) where `contour` crosses any of `others`.
export function contourCrossings(contour, others) {
  const hits = [];
  for (let i = 0; i + 1 < contour.length; i++)
    for (const o of others)
      for (let j = 0; j + 1 < o.length; j++) {
        const x = segmentIntersection(contour[i], contour[i + 1], o[j], o[j + 1]);
        if (x) hits.push({ s: i + x.t, point: x.point });
      }
  hits.sort((a, b) => a.s - b.s);
  return hits.filter((h, i) => !i || Math.abs(h.s - hits[i - 1].s) > 1e-9);
}
// Nearest contour (index) and parameter of a point on an item's world outline.
export function nearestOnContours(contours, p) {
  let best = null;
  contours.forEach((c, ci) => {
    for (let i = 0; i + 1 < c.length; i++) {
      const a = c[i],
        b = c[i + 1],
        ab = sub(b, a),
        l2 = dot(ab, ab);
      const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
      const q = add(a, mul(ab, t)),
        d = dist(p, q);
      if (!best || d < best.distance) best = { contour: ci, s: i + t, point: q, distance: d };
    }
  });
  return best;
}
const pointAt = (c, s) => {
  const i = Math.min(c.length - 2, Math.floor(s)),
    t = s - i;
  return add(c[i], mul(sub(c[i + 1], c[i]), t));
};
// Portion of a polyline between parameters s0 < s1.
const slice = (c, s0, s1) => {
  const out = [pointAt(c, s0)];
  for (let i = Math.floor(s0) + 1; i <= Math.floor(s1) && i < c.length; i++) if (i > s0 && i < s1) out.push(c[i]);
  out.push(pointAt(c, s1));
  return out.filter((p, i) => !i || !same(p, out[i - 1]));
};

// ---------------------------------------------------------------- Trim / Extend
// Removes the part of the clicked contour between its nearest crossings with
// the other contours. Returns the remaining polylines of that contour.
export function trimContour(contour, s, crossings) {
  const closed = isClosed(contour),
    n = contour.length - 1;
  const before = crossings.filter((h) => h.s < s - 1e-9).map((h) => h.s),
    after = crossings.filter((h) => h.s > s + 1e-9).map((h) => h.s);
  if (!crossings.length) throw Error("交点がありません。他の図形と交差する部分をクリックしてください。");
  if (closed) {
    if (crossings.length < 2) throw Error("閉じた輪郭を切るには交点が2つ以上必要です。");
    const lo = before.length ? before.at(-1) : crossings.at(-1).s,
      hi = after.length ? after[0] : crossings[0].s;
    // keep from hi forward around to lo
    const pts = hi < lo ? slice(contour, hi, lo) : [...slice(contour, hi, n), ...slice(contour, 0, lo).slice(1)];
    return [pts];
  }
  const pieces = [];
  if (before.length) pieces.push(slice(contour, 0, before.at(-1)));
  if (after.length) pieces.push(slice(contour, after[0], n));
  return pieces.filter((c) => c.length >= 2 && dist(c[0], c.at(-1)) > 1e-6);
}
const lineItem = (from, to, base, id) => ({
  ...base,
  id,
  type: "line",
  x: num(from.x),
  y: num(from.y),
  rotation: normalizeAngle(deg(Math.atan2(to.y - from.y, to.x - from.x))),
  w: num(dist(from, to)),
  h: 0,
  contours: shapeContours("line", num(dist(from, to)), 0),
});
// Outline item from world polylines (open or closed).
function outlineFromWorld(contours, base, id) {
  const box = bounds(contours);
  const local = contours.map((c) => c.map((p) => P(num(p.x - box.x), num(p.y - box.y))));
  const { text, font, size, spacing, vertical, stretch, warp, w, h, radius, path, ...rest } = base;
  return {
    ...rest,
    id,
    type: "outline",
    x: num(box.x),
    y: num(box.y),
    rotation: 0,
    ratioLocked: false,
    path: pathFromContours(local),
    contours: local,
  };
}
// Trim at a world point on `item`, cutting against `others` (visible items).
// Returns the items replacing `item` (possibly none).
export function trimItem(item, point, others, makeId) {
  if (item.type === "bridge") throw Error("ブリッジはトリムできません。");
  const world = worldContours(item);
  const near = nearestOnContours(world, point);
  if (!near) throw Error("輪郭が見つかりません。");
  const targets = [
    ...others.filter((o) => o.id !== item.id && o.type !== "bridge").flatMap(worldContours),
    ...world.filter((_, i) => i !== near.contour),
  ];
  const pieces = trimContour(world[near.contour], near.s, contourCrossings(world[near.contour], targets));
  const rest = world.filter((_, i) => i !== near.contour);
  if (item.type === "line")
    return pieces.map((c) => lineItem(c[0], c.at(-1), item, makeId()));
  const all = [...rest, ...pieces];
  return all.length ? [outlineFromWorld(all, item, makeId())] : [];
}
// Extends the open end of `item` nearest to `point` until it meets another
// contour. Returns the replacement item.
export function extendItem(item, point, others, makeId) {
  if (item.type === "bridge") throw Error("ブリッジは延長できません。");
  const world = worldContours(item);
  let best = null;
  world.forEach((c, ci) => {
    if (isClosed(c)) return;
    for (const end of [0, c.length - 1]) {
      const d = dist(c[end], point);
      if (!best || d < best.d) best = { ci, end, d };
    }
  });
  if (!best) throw Error("延長できる開いた線がありません。線分や開いたパスの端をクリックしてください。");
  const c = world[best.ci],
    tip = c[best.end],
    prev = c[best.end === 0 ? 1 : c.length - 2],
    dir = unit(sub(tip, prev));
  if (len(dir) === 0) throw Error("端点の方向を決められません。");
  const far = add(tip, mul(dir, 100000));
  let hit = null;
  const targets = [
    ...others.filter((o) => o.id !== item.id && o.type !== "bridge").flatMap(worldContours),
    ...world.filter((_, i) => i !== best.ci),
  ];
  for (const o of targets)
    for (let j = 0; j + 1 < o.length; j++) {
      const x = segmentIntersection(tip, far, o[j], o[j + 1]);
      if (x && x.t > 1e-9 && (!hit || x.t < hit.t)) hit = x;
    }
  if (!hit) throw Error("延長先が見つかりません。延長方向に他の図形がありません。");
  const extended = [...c];
  extended[best.end] = hit.point;
  if (item.type === "line") return lineItem(extended[0], extended[1], item, makeId());
  const all = world.map((cc, i) => (i === best.ci ? extended : cc));
  return outlineFromWorld(all, item, makeId());
}

// ---------------------------------------------------------------- Fillet / Chamfer
const straight = (a, b) => !a.out && !b.in;
// Corner node i of subpath s must sit between two straight segments.
function cornerOf(path, s, i) {
  const sp = path[s];
  if (!sp) throw Error("パスがありません。");
  const n = sp.nodes.length;
  const prevIndex = sp.closed ? (i - 1 + n) % n : i - 1,
    nextIndex = sp.closed ? (i + 1) % n : i + 1;
  if (prevIndex < 0 || nextIndex >= n || prevIndex === nextIndex) throw Error("端のノードには適用できません。");
  const c = sp.nodes[i],
    p = sp.nodes[prevIndex],
    q = sp.nodes[nextIndex];
  if (!straight(p, c) || !straight(c, q)) throw Error("直線どうしの角にのみ適用できます（曲線の角は未対応）。");
  const u = unit(sub(p, c)),
    v = unit(sub(q, c));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
  if (theta < 1e-6 || Math.abs(theta - Math.PI) < 1e-6) throw Error("この角は直線または折り返しのため丸められません。");
  return { sp, n, prevIndex, nextIndex, c, p, q, u, v, theta };
}
function replaceCorner(path, s, i, newNodes) {
  const next = structuredClone(path);
  next[s].nodes.splice(i, 1, ...newNodes);
  return next;
}
export function filletCorner(path, s, i, radius) {
  if (!(radius > 0)) throw Error("半径は0より大きい値です。");
  const { c, p, q, u, v, theta } = cornerOf(path, s, i);
  const t = radius / Math.tan(theta / 2);
  if (t > dist(c, p) + 1e-6 || t > dist(c, q) + 1e-6)
    throw Error(`半径が大きすぎます（この角の最大は約 ${num(Math.min(dist(c, p), dist(c, q)) * Math.tan(theta / 2)).toFixed(2)} mm）。`);
  const A = add(c, mul(u, t)),
    B = add(c, mul(v, t)),
    phi = Math.PI - theta,
    k = (4 / 3) * Math.tan(phi / 4) * radius;
  const a = { x: num(A.x), y: num(A.y), out: { x: num(A.x - u.x * k), y: num(A.y - u.y * k) } },
    b = { x: num(B.x), y: num(B.y), in: { x: num(B.x - v.x * k), y: num(B.y - v.y * k) } };
  return replaceCorner(path, s, i, [a, b]);
}
export function chamferCorner(path, s, i, distance) {
  if (!(distance > 0)) throw Error("距離は0より大きい値です。");
  const { c, p, q, u, v } = cornerOf(path, s, i);
  if (distance > dist(c, p) + 1e-6 || distance > dist(c, q) + 1e-6)
    throw Error(`距離が大きすぎます（この角の最大は約 ${num(Math.min(dist(c, p), dist(c, q))).toFixed(2)} mm）。`);
  const A = add(c, mul(u, distance)),
    B = add(c, mul(v, distance));
  return replaceCorner(path, s, i, [P(num(A.x), num(A.y)), P(num(B.x), num(B.y))]);
}
// Editable path of an item in local coordinates (rect/ellipse become exact
// paths, other outlines are fitted).
export function workingPathOf(item) {
  if (item.path) return item.path;
  if (["rect", "circle"].includes(item.type) && !item.warp) return shapePath(item.type, item.w, item.h, item.radius ?? 0);
  return pathFromContours(item.contours);
}
// Nearest path node of an item to a world point.
export function nearestNode(path, item, point) {
  let best = null;
  path.forEach((sp, s) =>
    sp.nodes.forEach((node, i) => {
      const d = dist(transform(node, item), point);
      if (!best || d < best.d) best = { s, i, d };
    }),
  );
  return best;
}
// Two line items that share an end point become one open path with a corner.
export function joinLines(a, b) {
  const ends = (l) => [transform(P(0, 0), l), transform(P(l.w, 0), l)];
  const [a0, a1] = ends(a),
    [b0, b1] = ends(b);
  let shared = null,
    outerA,
    outerB;
  for (const [pa, oa] of [[a0, a1], [a1, a0]])
    for (const [pb, ob] of [[b0, b1], [b1, b0]])
      if (dist(pa, pb) < 0.5 && !shared) {
        shared = mul(add(pa, pb), 0.5);
        outerA = oa;
        outerB = ob;
      }
  if (!shared) throw Error("2本の線分の端点が接していません。");
  return [outerA, shared, outerB];
}
// Applies a corner operation (fillet or chamfer) to the item's corner nearest
// to `point`; returns an outline item with the new path.
export function cornerItem(item, point, amount, kind, id) {
  if (item.warp) throw Error("ワープ中の図形には適用できません。先にワープを解除してください。");
  const path = workingPathOf(item);
  const near = nearestNode(path, item, point);
  if (!near) throw Error("ノードが見つかりません。");
  const next = kind === "fillet" ? filletCorner(path, near.s, near.i, amount) : chamferCorner(path, near.s, near.i, amount);
  const { text, font, size, spacing, vertical, stretch, warp, w, h, radius, ...rest } = item;
  return { ...rest, id, type: "outline", path: next, contours: pathContours(next), ratioLocked: false };
}
// Same for two lines meeting at a corner: one open path.
export function cornerOfLines(a, b, amount, kind, id) {
  const [p0, c, p1] = joinLines(a, b);
  const box = bounds([[p0, c, p1]]);
  const local = (p) => P(num(p.x - box.x), num(p.y - box.y));
  const path = [{ closed: false, nodes: [local(p0), local(c), local(p1)] }];
  const next = kind === "fillet" ? filletCorner(path, 0, 1, amount) : chamferCorner(path, 0, 1, amount);
  return {
    id,
    type: "outline",
    name: kind === "fillet" ? "フィレット" : "面取り",
    x: num(box.x),
    y: num(box.y),
    rotation: 0,
    layerId: a.layerId,
    ratioLocked: false,
    path: next,
    contours: pathContours(next),
  };
}

// ---------------------------------------------------------------- Measure
export function measurePoints(a, b) {
  return {
    distance: num(dist(a, b)),
    dx: num(Math.abs(b.x - a.x)),
    dy: num(Math.abs(b.y - a.y)),
    angle: num(normalizeAngle(deg(Math.atan2(b.y - a.y, b.x - a.x)))),
  };
}
export function angleAt(vertex, a, b) {
  const u = unit(sub(a, vertex)),
    v = unit(sub(b, vertex));
  return num(deg(Math.acos(Math.max(-1, Math.min(1, dot(u, v))))));
}
// Measurements of a single item: lines give length/angle, circles radius.
export function measureItem(item) {
  if (item.type === "line") return { kind: "line", length: num(item.w), angle: num(normalizeAngle(item.rotation)) };
  if (item.type === "circle" && !item.warp) {
    const round = Math.abs(item.w - item.h) < 1e-6;
    return round
      ? { kind: "circle", radius: num(item.w / 2), diameter: num(item.w) }
      : { kind: "ellipse", rx: num(item.w / 2), ry: num(item.h / 2) };
  }
  const b = bounds(worldContours(item));
  return { kind: "box", width: num(b.w), height: num(b.h) };
}
// Snaps a point to the nearest contour vertex within `tolerance` (mm).
export function snapToVertex(p, items, tolerance) {
  let best = null;
  for (const item of items)
    for (const c of worldContours(item))
      for (const q of c) {
        const d = dist(p, q);
        if (d <= tolerance && (!best || d < best.d)) best = { point: P(num(q.x), num(q.y)), d };
      }
  return best ? best.point : P(num(p.x), num(p.y));
}

// ---------------------------------------------------------------- Dimensions
export const DIMENSION_TYPES = ["linear", "horizontal", "vertical", "angle", "radius", "diameter"];
// Reference dimension annotation: the value is computed from its points and
// never drives the geometry.
export function makeDimension(dimensionType, points, id, offset = 6) {
  if (!DIMENSION_TYPES.includes(dimensionType)) throw Error("不明な寸法の種類です。");
  const need = dimensionType === "angle" ? 3 : 2;
  if (!Array.isArray(points) || points.length < need) throw Error("寸法の点が足りません。");
  const pts = points.slice(0, need).map((p) => P(num(p.x), num(p.y)));
  let value;
  if (dimensionType === "linear") value = num(dist(pts[0], pts[1]));
  else if (dimensionType === "horizontal") value = num(Math.abs(pts[1].x - pts[0].x));
  else if (dimensionType === "vertical") value = num(Math.abs(pts[1].y - pts[0].y));
  else if (dimensionType === "angle") value = angleAt(pts[0], pts[1], pts[2]);
  else if (dimensionType === "radius") value = num(dist(pts[0], pts[1]));
  else value = num(dist(pts[0], pts[1]) * 2);
  return { id, type: "dimension", dimensionType, points: pts, offset, value };
}
export function dimensionLabel(d) {
  return d.dimensionType === "angle"
    ? `${d.value.toFixed(1)}°`
    : `${d.dimensionType === "radius" ? "R" : d.dimensionType === "diameter" ? "⌀" : ""}${d.value.toFixed(2)} mm`;
}
// Geometry for drawing a dimension: line ends, extension lines and the label.
export function dimensionGeometry(d) {
  const [a, b, c] = d.points;
  if (d.dimensionType === "angle") {
    const r = Math.max(4, Math.min(dist(a, b), dist(a, c)) * 0.5);
    const a1 = Math.atan2(b.y - a.y, b.x - a.x),
      a2 = Math.atan2(c.y - a.y, c.x - a.x);
    let sweep = a2 - a1;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const mid = a1 + sweep / 2;
    return {
      kind: "angle",
      arc: { cx: a.x, cy: a.y, r, start: a1, sweep },
      rays: [[a, b], [a, c]],
      label: P(a.x + Math.cos(mid) * (r + 3), a.y + Math.sin(mid) * (r + 3)),
    };
  }
  if (["radius", "diameter"].includes(d.dimensionType)) {
    const from = d.dimensionType === "diameter" ? sub(mul(a, 2), b) : a;
    return { kind: "leader", line: [from, b], label: P((from.x + b.x) / 2, (from.y + b.y) / 2 - 2) };
  }
  let p = a,
    q = b;
  if (d.dimensionType === "horizontal") q = P(b.x, a.y);
  if (d.dimensionType === "vertical") q = P(a.x, b.y);
  // Screen y grows downward, so a positive offset puts the line "above" a
  // left-to-right dimension.
  const dir = unit(sub(q, p)),
    nrm = P(dir.y, -dir.x),
    off = mul(nrm, d.offset);
  const p1 = add(p, off),
    q1 = add(q, off);
  return {
    kind: "linear",
    line: [p1, q1],
    extensions: [[a, add(p1, mul(nrm, 1))], [b, add(q1, mul(nrm, 1))]],
    label: add(mul(add(p1, q1), 0.5), mul(nrm, 1.5)),
    angle: deg(Math.atan2(dir.y, dir.x)),
  };
}
