import { worldContours, transform } from "./geometry.js";
import { isEditable, visibleItems } from "./layers.js";
export function selectionRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}
function inside(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
function segmentHits(a, b, r) {
  let lo = 0,
    hi = 1;
  for (const [v, w] of [
    [a.x - b.x, a.x - r.x],
    [b.x - a.x, r.x + r.w - a.x],
    [a.y - b.y, a.y - r.y],
    [b.y - a.y, r.y + r.h - a.y],
  ]) {
    if (Math.abs(v) < 1e-12) {
      if (w < 0) return false;
      continue;
    }
    if (v < 0) lo = Math.max(lo, w / v);
    else hi = Math.min(hi, w / v);
    if (lo > hi) return false;
  }
  return true;
}
function winding(p, contours) {
  let value = 0;
  for (const c of contours)
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1],
        b = c[i],
        cross = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
      if (a.y <= p.y && b.y > p.y && cross > 0) value++;
      if (a.y > p.y && b.y <= p.y && cross < 0) value--;
    }
  return value;
}
export function intersectsSelection(item, rect) {
  const contours =
    item.type === "bridge"
      ? [
          [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
            [-1, -1],
          ].map(([x, y]) =>
            transform({ x: (x * item.w) / 2, y: (y * item.h) / 2 }, item),
          ),
        ]
      : worldContours(item);
  for (const c of contours) {
    if (c.some((p) => inside(p, rect))) return true;
    for (let i = 1; i < c.length; i++)
      if (segmentHits(c[i - 1], c[i], rect)) return true;
  }
  return (
    item.type !== "line" &&
    winding({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, contours) !== 0
  );
}
export function marqueeIds(project, a, b, base = []) {
  const rect = selectionRect(a, b),
    hits = visibleItems(project)
      .filter((i) => isEditable(project, i) && intersectsSelection(i, rect))
      .map((i) => i.id);
  return [...new Set([...base, ...hits])].filter((id) =>
    isEditable(
      project,
      project.items.find((i) => i.id === id),
    ),
  );
}
// Browser rows run top layer first, and within a layer the topmost item first.
export function browserOrder(project) {
  return [...project.layers]
    .reverse()
    .flatMap((l) => project.items.filter((i) => i.layerId === l.id).reverse());
}
// Shift-click in the browser: every editable row from the anchor to the target,
// inclusive, ordered from the anchor so it stays the first selection.
export function rangeIds(project, anchorId, targetId) {
  const rows = browserOrder(project),
    a = rows.findIndex((i) => i.id === anchorId),
    b = rows.findIndex((i) => i.id === targetId);
  if (b < 0) return [];
  const range =
    a < 0 ? [rows[b]] : rows.slice(Math.min(a, b), Math.max(a, b) + 1);
  if (a > b) range.reverse();
  return range.filter((i) => isEditable(project, i)).map((i) => i.id);
}
export function layerMovePlan(project, ids, layerId) {
  const layer = project.layers.find((l) => l.id === layerId);
  if (!layer?.visible || layer.locked)
    throw Error("表示中のロックされていないレイヤーへドロップしてください。");
  const selected = project.items.filter((i) => ids.includes(i.id));
  if (!selected.length) throw Error("移動するアイテムを選択してください。");
  if (selected.some((i) => i.targetId && !ids.includes(i.targetId)))
    throw Error("対象付きブリッジは親アイテムと一緒に移動してください。");
  const moved = project.items.filter(
    (i) => ids.includes(i.id) || ids.includes(i.targetId),
  );
  if (moved.some((i) => !isEditable(project, i)))
    throw Error("ロック・非表示のアイテムは移動できません。");
  return moved;
}
export const MAX_ZOOM = 20;
export function wheelZoom(current, delta, mode = 0, pinch = false) {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? 400 : 1);
  return Math.max(
    0.25,
    Math.min(
      MAX_ZOOM,
      current *
        Math.exp(
          -Math.max(-300, Math.min(300, pixels)) * (pinch ? 0.006 : 0.002),
        ),
    ),
  );
}
