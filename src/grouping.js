import {
  bounds,
  transform,
  worldContours,
  crossesContour,
} from "./geometry.js";
import { warpContours } from "./warp.js";
import { unionRegions } from "./polygon.js";
const isClosed = (c) =>
  c.length > 3 && Math.hypot(c[0].x - c.at(-1).x, c[0].y - c.at(-1).y) < 1e-7;
const shift = (contours, d) =>
  contours.map((c) => c.map((p) => ({ x: p.x - d.x, y: p.y - d.y })));
// One editable text item per glyph cluster from layoutGlyphs. Each keeps the
// owner's settings and rotation, and its glyph stays exactly where it was.
export function splitCharacters(item, glyphs) {
  const { id, ...rest } = item;
  return glyphs
    .filter((g) => g.contours.length)
    .map((g) => ({
      ...rest,
      ...transform(g.origin, item),
      text: g.text,
      name: g.text,
      contours: shift(g.contours, g.origin),
    }));
}
// Each connected filled region (an outer contour with its holes) becomes a
// fixed outline. Islands inside a hole, such as the centre of 回, are parts too.
export function splitParts(item) {
  const {
      id,
      text,
      font,
      size,
      spacing,
      vertical,
      stretch,
      warp,
      path,
      ...rest
    } = item,
    closed = item.contours.filter(isClosed);
  const groups = [
    ...(closed.length ? filledRegions(closed) : []),
    ...item.contours.filter((c) => !isClosed(c)).map((c) => [c]),
  ];
  return groups
    .filter((g) => g.length)
    .map((contours) => ({ box: bounds(contours), contours }))
    .sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y)
    .map(({ box, contours }, n) => ({
      ...rest,
      type: "outline",
      name: `${item.name}・部位${n + 1}`,
      ...transform(box, item),
      contours: shift(contours, box),
    }));
}
// Nonzero union of closed contours, grouped as [outer, ...holes] per region.
const filledRegions = (contours) =>
  unionRegions(contours).map((r) => [r.outer, ...r.holes]);
// A bridge scoped to a split item keeps acting on every piece it crosses, so
// the cut geometry is unchanged: it is retargeted to the first such piece and
// copied for the others. A bridge crossing none goes to the nearest piece.
// Returns the copies, which the caller adds to the project.
export function reassignBridges(items, ownerId, pieces, makeId) {
  const candidates = pieces.map((piece) => {
    const contours = worldContours(piece);
    return { piece, contours, box: bounds(contours) };
  });
  const copies = [];
  for (const bridge of items.filter(
    (i) => i.type === "bridge" && i.targetId === ownerId,
  )) {
    const gap = ({ box }) =>
      Math.hypot(
        Math.max(box.x - bridge.x, 0, bridge.x - box.x - box.w),
        Math.max(box.y - bridge.y, 0, bridge.y - box.y - box.h),
      );
    let owners = candidates.filter((c) =>
      c.contours.some((points) => crossesContour(points, bridge)),
    );
    if (!owners.length)
      owners = [candidates.reduce((a, b) => (gap(b) < gap(a) ? b : a))];
    owners.forEach(({ piece }, n) => {
      const target = n ? { ...bridge, id: makeId() } : bridge;
      target.targetId = piece.id;
      target.layerId = piece.layerId;
      if (n) copies.push(target);
    });
  }
  return copies;
}
// Groups are a shared groupId on flat items. Grouping flattens earlier groups,
// puts the members (and their scoped bridges) on one layer and stacks them
// together where the topmost member was. Scoped bridges follow their owner
// instead of joining. Returns the member ids in stacking order.
export function groupItems(project, ids, groupId, layerId) {
  const members = project.items.filter(
    (i) => ids.includes(i.id) && !i.targetId,
  );
  if (members.length < 2)
    throw Error("グループ化するアイテムを2つ以上選択してください。");
  const top = Math.max(...members.map((i) => project.items.indexOf(i))),
    rest = project.items.filter((i) => !members.includes(i)),
    below = project.items
      .slice(0, top + 1)
      .filter((i) => !members.includes(i)).length;
  rest.splice(below, 0, ...members);
  project.items = rest;
  for (const item of project.items)
    if (members.includes(item) || members.some((m) => m.id === item.targetId))
      item.layerId = layerId;
  for (const item of members) item.groupId = groupId;
  return members.map((i) => i.id);
}
// Releases every group that any of the ids belongs to; returns released ids.
export function ungroupItems(project, ids) {
  const groups = groupsOf(project, ids),
    released = project.items.filter((i) => groups.has(i.groupId));
  for (const item of released) delete item.groupId;
  return released.map((i) => i.id);
}
// The ids plus every member of the groups they belong to.
export function expandGroups(project, ids) {
  const groups = groupsOf(project, ids);
  return [
    ...new Set([
      ...ids,
      ...project.items.filter((i) => groups.has(i.groupId)).map((i) => i.id),
    ]),
  ];
}
// Deleting or combining members can leave a group of one; that is no group.
export function normalizeGroups(project) {
  const counts = new Map();
  for (const i of project.items)
    if (i.groupId) counts.set(i.groupId, (counts.get(i.groupId) || 0) + 1);
  for (const i of project.items)
    if (i.groupId && counts.get(i.groupId) < 2) delete i.groupId;
}
const groupsOf = (project, ids) =>
  new Set(
    project.items
      .filter((i) => ids.includes(i.id) && i.groupId)
      .map((i) => i.groupId),
  );
// Characters of warped text become fixed outlines that keep their warped
// shape: each glyph goes through the envelope placed on the whole text.
export function splitWarpedCharacters(item, glyphs) {
  const { id, text, font, size, spacing, vertical, stretch, warp, ...rest } =
      item,
    box = bounds(glyphs.flatMap((g) => g.contours));
  return glyphs
    .filter((g) => g.contours.length)
    .map((g) => ({
      ...rest,
      type: "outline",
      name: g.text,
      contours: warpContours(g.contours, box, warp.envelope),
    }));
}
