// Parametric history (Fusion-style timeline) for a part's outline. The
// outline is regenerated from a base sketch plus an ordered list of
// features, so any parameter can be changed later and everything that
// depends on the outline (stitch holes, folds, hardware) follows.
//
//   part.history = { base, features: [...], outputKey }
//   base     = { kind: "rect", w, h, radius } | { kind: "circle", w, h } | { kind: "path", path }
//   feature  = { id, kind: "fillet", node, radius }      round corner `node` (index in the path at that step)
//            | { id, kind: "chamfer", node, distance }
//            | { id, kind: "hole", x, y, d }              round cut-out at item-local (x, y)
//            | { id, kind: "slot", x, y, w, h, rotation } stadium cut-out
//
// Node indices are stable under parameter edits: a fillet or chamfer always
// turns one node into two, so later features see the same numbering no
// matter the radius. Deleting a feature shifts later node references by
// one, which the UI points out.
import { shapePath, pathContours, transformPath } from "../path.js";
import { filletCorner, chamferCorner } from "../cad.js";

export const FEATURE_LABELS = Object.freeze({ fillet: "フィレット", chamfer: "面取り", hole: "丸穴", slot: "長穴" });
const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const hashOf = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
};
export const pathKey = (path) => hashOf(JSON.stringify(path));

// The base sketch of an item as it is now (rect/ellipse keep their
// parameters; anything else becomes a fixed path).
export function baseFromItem(item, workingPath) {
  if (item.type === "rect" && !item.warp) return { kind: "rect", w: item.w, h: item.h, radius: item.radius ?? 0 };
  if (item.type === "circle" && !item.warp) return { kind: "circle", w: item.w, h: item.h };
  return { kind: "path", path: structuredClone(workingPath) };
}
export function normalizeHistory(h) {
  if (!h || typeof h !== "object" || !h.base) throw Error("操作履歴が不正です。");
  const b = h.base;
  let base;
  if (b.kind === "rect") base = { kind: "rect", w: num(b.w, 0.1, 2000, 10), h: num(b.h, 0.1, 2000, 10), radius: num(b.radius, 0, 1000, 0) };
  else if (b.kind === "circle") base = { kind: "circle", w: num(b.w, 0.1, 2000, 10), h: num(b.h, 0.1, 2000, 10) };
  else if (b.kind === "path" && Array.isArray(b.path)) base = { kind: "path", path: structuredClone(b.path) };
  else throw Error("操作履歴の基本形状が不正です。");
  const features = (Array.isArray(h.features) ? h.features : []).slice(0, 500).map(normalizeFeature);
  return { base, features, outputKey: typeof h.outputKey === "string" ? h.outputKey.slice(0, 40) : "" };
}
export function normalizeFeature(f) {
  if (!f || typeof f.id !== "string") throw Error("操作履歴の項目が不正です。");
  const node = Number.isInteger(f.node) && f.node >= 0 && f.node < 100000 ? f.node : 0;
  switch (f.kind) {
    case "fillet":
      return { id: f.id, kind: "fillet", node, radius: num(f.radius, 0.01, 500, 3), subpath: Number.isInteger(f.subpath) ? f.subpath : 0 };
    case "chamfer":
      return { id: f.id, kind: "chamfer", node, distance: num(f.distance, 0.01, 500, 2), subpath: Number.isInteger(f.subpath) ? f.subpath : 0 };
    case "hole":
      return { id: f.id, kind: "hole", x: num(f.x, -10000, 10000, 0), y: num(f.y, -10000, 10000, 0), d: num(f.d, 0.2, 500, 4) };
    case "slot":
      return { id: f.id, kind: "slot", x: num(f.x, -10000, 10000, 0), y: num(f.y, -10000, 10000, 0), w: num(f.w, 0.2, 500, 3), h: num(f.h, 0.2, 500, 10), rotation: num(f.rotation, -360, 360, 0) };
    default:
      throw Error(`不明な操作「${f.kind}」です。`);
  }
}
// A subpath traversed the other way round (inner rings must run opposite
// to the outer ring for the nonzero fill TypeFab uses).
function reversed(sub) {
  const nodes = [...sub.nodes].reverse().map((n) => {
    const out = { ...n };
    if (n.in) out.out = n.in; else delete out.out;
    if (n.out) out.in = n.out; else delete out.in;
    return out;
  });
  return { ...sub, nodes };
}
const moved = (sub, dx, dy) => transformPath([sub], (p) => ({ x: p.x + dx, y: p.y + dy }))[0];
function holeSubpath(f) {
  const circle = shapePath("circle", f.d, f.d)[0];
  return reversed(moved(circle, f.x - f.d / 2, f.y - f.d / 2));
}
function slotSubpath(f) {
  const r = Math.min(f.w, f.h) / 2;
  const rect = shapePath("rect", f.w, f.h, r)[0];
  const a = (f.rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const rot = transformPath([rect], (p) => {
    const x = p.x - f.w / 2,
      y = p.y - f.h / 2;
    return { x: f.x + x * c - y * s, y: f.y + x * s + y * c };
  })[0];
  return reversed(rot);
}
export function basePath(base) {
  if (base.kind === "rect") return shapePath("rect", base.w, base.h, base.radius);
  if (base.kind === "circle") return shapePath("circle", base.w, base.h);
  return structuredClone(base.path);
}
// Replays the history. Returns { path, errors: [{ featureId, message }] };
// a feature that fails (e.g. a radius that no longer fits) is skipped and
// reported, the rest still apply.
export function regenerate(history) {
  let path = basePath(history.base);
  const errors = [];
  for (const f of history.features) {
    try {
      if (f.kind === "fillet") path = filletCorner(path, f.subpath, f.node, f.radius);
      else if (f.kind === "chamfer") path = chamferCorner(path, f.subpath, f.node, f.distance);
      else if (f.kind === "hole") path = [...path, holeSubpath(f)];
      else if (f.kind === "slot") path = [...path, slotSubpath(f)];
    } catch (e) {
      errors.push({ featureId: f.id, message: e.message });
    }
  }
  return { path, errors };
}
// The item rebuilt from its history (keeps id, position, layer, name).
export function applyHistory(item, history) {
  const { path, errors } = regenerate(history);
  const { w, h, radius, warp, text, font, size, spacing, vertical, stretch, ...rest } = item;
  const next = { ...rest, type: "outline", path, contours: pathContours(path), ratioLocked: false };
  history.outputKey = pathKey(path);
  return { item: next, errors };
}
// True when the item's outline no longer matches what the history produced
// (edited by a tool the history does not record, e.g. a handle resize).
export function isStale(item, history, workingPath) {
  if (!history.outputKey) return false;
  return pathKey(workingPath) !== history.outputKey;
}
export function describeFeature(f) {
  if (f.kind === "fillet") return `フィレット ノード ${f.node} · R ${f.radius}`;
  if (f.kind === "chamfer") return `面取り ノード ${f.node} · ${f.distance} mm`;
  if (f.kind === "hole") return `丸穴 Ø${f.d} @ (${f.x}, ${f.y})`;
  return `長穴 ${f.w} × ${f.h} @ (${f.x}, ${f.y})`;
}
export function describeBase(b) {
  if (b.kind === "rect") return `長方形 ${b.w} × ${b.h}${b.radius ? ` R${b.radius}` : ""}`;
  if (b.kind === "circle") return `楕円 ${b.w} × ${b.h}`;
  return `パス（${b.path.reduce((n, s) => n + s.nodes.length, 0)} ノード）`;
}
