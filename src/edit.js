import { transform } from "./geometry.js";
// Stacking order changes happen inside each layer: items of other layers and
// unselected bridges (always drawn above shapes) keep their slots.
export function arrangeItems(items, ids, mode) {
  const selected = new Set(ids),
    result = [...items];
  for (const layerId of new Set(items.map((i) => i.layerId))) {
    const slots = [];
    items.forEach((item, index) => {
      if (
        item.layerId === layerId &&
        (item.type !== "bridge" || selected.has(item.id))
      )
        slots.push(index);
    });
    const seq = slots.map((n) => items[n]),
      isSelected = (item) => selected.has(item.id);
    let order = [...seq];
    if (mode === "front")
      order = [...seq.filter((i) => !isSelected(i)), ...seq.filter(isSelected)];
    else if (mode === "back")
      order = [...seq.filter(isSelected), ...seq.filter((i) => !isSelected(i))];
    else if (mode === "forward") {
      for (let n = order.length - 2; n >= 0; n--)
        if (isSelected(order[n]) && !isSelected(order[n + 1]))
          [order[n], order[n + 1]] = [order[n + 1], order[n]];
    } else if (mode === "backward") {
      for (let n = 1; n < order.length; n++)
        if (isSelected(order[n]) && !isSelected(order[n - 1]))
          [order[n], order[n - 1]] = [order[n - 1], order[n]];
    } else throw Error("不明な並べ替えです。");
    slots.forEach((slot, n) => (result[slot] = order[n]));
  }
  return result;
}
// Drops the items (with their scoped bridges, in their current order) right
// before or after `targetId` in stacking order, into the target's layer.
export function reorderItems(items, ids, targetId, position = "after") {
  const set = new Set(ids),
    moving = items.filter((i) => set.has(i.id)),
    rest = items.filter((i) => !set.has(i.id)),
    target = rest.find((i) => i.id === targetId);
  if (!target) throw Error("移動先のアイテムが見つかりません。");
  if (!moving.length) return items;
  const at = rest.indexOf(target) + (position === "after" ? 1 : 0),
    placed = moving.map((i) =>
      i.layerId === target.layerId ? i : { ...i, layerId: target.layerId },
    );
  return [...rest.slice(0, at), ...placed, ...rest.slice(at)];
}
// Copies the items with their scoped bridges under new ids. Bridge owners and
// groups are remapped, so copies form their own groups. Returns the copies in
// stacking order and the new ids of the requested items.
export function cloneItems(items, ids, makeId, offset = 5, layerId = null) {
  const originals = items.filter(
      (i) => ids.includes(i.id) || ids.includes(i.targetId),
    ),
    mapping = new Map(originals.map((i) => [i.id, makeId()])),
    groups = new Map();
  const copies = originals.map((i) => {
    const copy = structuredClone(i);
    copy.id = mapping.get(i.id);
    copy.x += offset;
    copy.y += offset;
    if (mapping.has(i.targetId)) copy.targetId = mapping.get(i.targetId);
    if (i.groupId) {
      if (!groups.has(i.groupId)) groups.set(i.groupId, makeId());
      copy.groupId = groups.get(i.groupId);
    }
    if (layerId) copy.layerId = layerId;
    return copy;
  });
  return {
    copies,
    ids: originals
      .filter((i) => ids.includes(i.id))
      .map((i) => mapping.get(i.id)),
  };
}
// Rotation turns an item about a world point: its origin swings around the
// point and its angle grows by the same amount (kept within -180° < a ≤ 180°).
export function normalizeAngle(deg) {
  const a = ((deg % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}
export function rotateAbout(item, center, degrees) {
  const r = (degrees * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r),
    dx = item.x - center.x,
    dy = item.y - center.y;
  return {
    ...item,
    x: center.x + dx * c - dy * s,
    y: center.y + dx * s + dy * c,
    rotation: normalizeAngle((item.rotation || 0) + degrees),
  };
}
// Centre of a selection: a single item turns about the middle of its own
// box; several turn about the middle of their combined world box.
export function selectionCenter(items, boundsOf) {
  const corners = items.flatMap((item) => {
    const b = boundsOf(item);
    return [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x, b.y + b.h],
      [b.x + b.w, b.y + b.h],
      [b.x + b.w / 2, b.y + b.h / 2],
    ].map(([x, y]) => transform({ x, y }, item));
  });
  if (items.length === 1) return corners[4];
  const xs = corners.map((p) => p.x),
    ys = corners.map((p) => p.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}
