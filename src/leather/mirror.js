// Mirror links between parts (Leather Domain Core). A mirrored copy keeps a
// one-way link to its source: whenever the source outline or the source
// part's settings change, they are mirrored into the copy again. Edits on
// the copy never touch the source (and are overwritten by the next change
// of the source, which the UI says).
import { transform } from "../geometry.js";
import { mirrorItems, reflectPoint, reflectAngle } from "../cad.js";
import { makePart, makeStitchLine, makeFoldLine, makeHardware, makeJoint } from "./model.js";

// Short fingerprints of what the copy depends on.
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16) + ":" + s.length;
};
export const itemKey = (item) => {
  const { id, name, layerId, hidden, groupId, ...geometry } = item;
  return hash(JSON.stringify(geometry));
};
export const partKey = (part) => {
  const { id, itemId, name, side, mirrorOf, color, ...settings } = part;
  return hash(JSON.stringify(settings));
};
// Hardware of the source, reflected into the copy's local frame.
export function mirrorHardware(list, srcItem, copyItem, axis, existing = [], makeId) {
  return list.map((h, k) => {
    const world = transform({ x: h.x, y: h.y }, srcItem);
    const m = reflectPoint(world, axis.a, axis.b);
    const local = transform(m, copyItem, true);
    const rotation = reflectAngle(srcItem.rotation + h.rotation, axis.a, axis.b) - copyItem.rotation;
    return makeHardware(existing[k]?.id ?? makeId(), { ...h, x: Number(local.x.toFixed(3)), y: Number(local.y.toFixed(3)), rotation: Number((((rotation + 540) % 360) - 180).toFixed(3)) });
  });
}
// The copy's settings regenerated from the source part. Existing ids of
// the copy's lines and hardware are kept by position so joints stay valid.
export function mirroredSettings(src, srcItem, copyItem, axis, existing, makeId) {
  return {
    // Projected lines are not mirrored (their source sits on another part).
    stitchLines: src.stitchLines.filter((line) => line.source.kind !== "projected").map((line, k) => makeStitchLine(existing?.stitchLines[k]?.id ?? makeId(), { ...structuredClone(line), pattern: { ...line.pattern, flip: !line.pattern.flip } })),
    foldLines: src.foldLines.map((f, k) => makeFoldLine(existing?.foldLines[k]?.id ?? makeId(), structuredClone(f))),
    hardware: mirrorHardware(src.hardware, srcItem, copyItem, axis, existing?.hardware ?? [], makeId),
  };
}
// Creates the linked copy part for an already mirrored item.
export function createMirrorPart(src, srcItem, copyItem, axis, makeId) {
  const copy = makePart(makeId(), copyItem.id, {
    ...structuredClone(src),
    name: `${src.name} ミラー`,
    side: src.side === "front" ? "back" : "front",
    stitchLines: [],
    foldLines: [],
    hardware: [],
    mirrorOf: { partId: src.id, axis, itemKey: itemKey(srcItem), partKey: partKey(src) },
  });
  Object.assign(copy, mirroredSettings(src, srcItem, copyItem, axis, null, makeId));
  const joints = src.stitchLines.filter((line) => line.source.kind !== "projected").map((line, k) =>
    makeJoint(makeId(), { name: `${src.name} × ミラー`, a: { partId: src.id, lineId: line.id }, b: { partId: copy.id, lineId: copy.stitchLines[k].id }, reverse: false, master: "a" }),
  );
  return { copy, joints };
}
// Re-mirrors every linked copy whose source changed. Mutates the project
// (items and leather) and returns the number of copies updated.
export function syncMirrorParts(project, makeId) {
  const l = project.leather;
  if (!l?.parts.length) return 0;
  let updated = 0;
  for (const copy of l.parts) {
    const m = copy.mirrorOf;
    if (!m) continue;
    const src = l.parts.find((p) => p.id === m.partId);
    const srcItem = project.items.find((i) => i.id === src?.itemId);
    const copyIndex = project.items.findIndex((i) => i.id === copy.itemId);
    if (!src || !srcItem || copyIndex < 0) continue;
    const ik = itemKey(srcItem),
      pk = partKey(src);
    if (ik === m.itemKey && pk === m.partKey) continue;
    let copyItem = project.items[copyIndex];
    if (ik !== m.itemKey) {
      const [mirrored] = mirrorItems([srcItem], m.axis.a, m.axis.b, () => copy.itemId);
      copyItem = { ...mirrored, id: copy.itemId, name: copyItem.name, layerId: copyItem.layerId, ...(copyItem.hidden ? { hidden: true } : {}), ...(copyItem.groupId ? { groupId: copyItem.groupId } : {}) };
      project.items[copyIndex] = copyItem;
    }
    const settings = mirroredSettings(src, srcItem, copyItem, m.axis, copy, makeId);
    Object.assign(copy, settings, { thickness: src.thickness, material: src.material, quantity: src.quantity, outlineOperation: src.outlineOperation });
    m.itemKey = ik;
    m.partKey = pk;
    updated++;
  }
  return updated;
}
export function detachMirror(leather, partId) {
  const p = leather.parts.find((x) => x.id === partId);
  if (p?.mirrorOf) delete p.mirrorOf;
}
