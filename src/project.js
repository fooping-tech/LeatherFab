import { ensureLayers } from "./layers.js";
import { WARP_PRESETS, WARPABLE } from "./warp.js";
import { normalizeStamp } from "./stamp.js";
import { validateLeather } from "./leather/model.js";
const validWarp = (w) =>
  w &&
  ["none", "custom", ...WARP_PRESETS.map(([id]) => id)].includes(w.preset) &&
  Number.isFinite(w.bend) &&
  Math.abs(w.bend) <= 1 &&
  Array.isArray(w.envelope) &&
  w.envelope.length === 12 &&
  w.envelope.every(
    (p) =>
      p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      Math.abs(p.x) <= 100 &&
      Math.abs(p.y) <= 100,
  );
const validPoint = (q) =>
  q &&
  Number.isFinite(q.x) &&
  Number.isFinite(q.y) &&
  Math.abs(q.x) <= 10000 &&
  Math.abs(q.y) <= 10000;
// Editable Bézier path of a fixed outline (see path.js).
const validPath = (path) =>
  Array.isArray(path) &&
  path.length > 0 &&
  path.every(
    (s) =>
      s &&
      typeof s.closed === "boolean" &&
      Array.isArray(s.nodes) &&
      s.nodes.length >= 1 &&
      s.nodes.every(
        (n) =>
          validPoint(n) &&
          (n.in === undefined || validPoint(n.in)) &&
          (n.out === undefined || validPoint(n.out)) &&
          (n.smooth === undefined || typeof n.smooth === "boolean"),
      ),
  );
export function validateProject(p) {
  if (
    !p ||
    ![1, 2].includes(p.version) ||
    !Number.isFinite(p.width) ||
    !Number.isFinite(p.height) ||
    p.width < 10 ||
    p.height < 10 ||
    p.width > 2000 ||
    p.height > 2000 ||
    !Array.isArray(p.items) ||
    p.items.length > 2000
  )
    throw Error("TypeFabプロジェクト形式またはサイズが不正です。");
  const layerIds = new Set();
  if (p.version === 2) {
    if (!Array.isArray(p.layers) || !p.layers.length || p.layers.length > 100)
      throw Error("レイヤー形式が不正です。");
    for (const l of p.layers) {
      if (
        !l ||
        typeof l.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(l.id) ||
        layerIds.has(l.id) ||
        typeof l.name !== "string" ||
        l.name.length > 100 ||
        typeof l.visible !== "boolean" ||
        typeof l.locked !== "boolean"
      )
        throw Error("レイヤー設定が不正です。");
      layerIds.add(l.id);
    }
  }
  const ids = new Set();
  let points = 0;
  for (const i of p.items) {
    if (
      !["text", "outline", "rect", "circle", "line", "bridge"].includes(
        i.type,
      ) ||
      typeof i.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(i.id) ||
      ids.has(i.id)
    )
      throw Error("オブジェクト形式が不正です。");
    ids.add(i.id);
    if (p.version === 2 && !layerIds.has(i.layerId))
      throw Error("所属レイヤーがありません。");
    if (i.ratioLocked !== undefined && typeof i.ratioLocked !== "boolean")
      throw Error("比率ロックが不正です。");
    if (i.hidden !== undefined && typeof i.hidden !== "boolean")
      throw Error("表示設定が不正です。");
    if (
      i.groupId !== undefined &&
      (typeof i.groupId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(i.groupId))
    )
      throw Error("グループ形式が不正です。");
    if (
      i.stretch !== undefined &&
      (!Number.isFinite(i.stretch) || i.stretch < 0.05 || i.stretch > 20)
    )
      throw Error("長体・平体の倍率が不正です。");
    if (
      i.warp !== undefined &&
      (!WARPABLE.includes(i.type) ||
        !validWarp(i.warp) ||
        // Fixed paths keep their unwarped outline; other shapes rebuild it.
        (i.type === "outline"
          ? !Array.isArray(i.warp.source)
          : i.warp.source !== undefined))
    )
      throw Error("ワープ設定が不正です。");
    if (i.path !== undefined) {
      if (i.type !== "outline" || !validPath(i.path))
        throw Error("編集用パスが不正です。");
      points += 3 * i.path.reduce((n, s) => n + s.nodes.length, 0);
    }
    if (
      i.radius !== undefined &&
      (i.type !== "rect" ||
        !Number.isFinite(i.radius) ||
        i.radius < 0 ||
        i.radius > 1000)
    )
      throw Error("フィレット半径が不正です。");
    for (const key of ["x", "y", "rotation"])
      if (!Number.isFinite(i[key]) || Math.abs(i[key]) > 10000)
        throw Error("座標が不正です。");
    if (i.type === "bridge" || ["rect", "circle", "line"].includes(i.type))
      for (const key of ["w", "h"])
        if (
          !Number.isFinite(i[key]) ||
          i[key] < 0 ||
          i[key] > 2000 ||
          (i.type !== "line" && i[key] === 0)
        )
          throw Error("寸法が不正です。");
    if (
      i.type === "text" &&
      (typeof i.text !== "string" ||
        i.text.length > 500 ||
        typeof i.font !== "string" ||
        !Number.isFinite(i.size) ||
        i.size < 1 ||
        i.size > 300 ||
        !Number.isFinite(i.spacing) ||
        Math.abs(i.spacing) > 100)
    )
      throw Error("文字設定が不正です。");
    if (i.type !== "bridge") {
      if (!Array.isArray(i.contours)) throw Error("輪郭がありません。");
      for (const c of [...i.contours, ...(i.warp?.source ?? [])]) {
        if (!Array.isArray(c) || c.length < 2) throw Error("輪郭が不正です。");
        points += c.length;
        if (points > 300000) throw Error("輪郭データが大きすぎます。");
        for (const q of c)
          if (
            !q ||
            !Number.isFinite(q.x) ||
            !Number.isFinite(q.y) ||
            Math.abs(q.x) > 10000 ||
            Math.abs(q.y) > 10000
          )
            throw Error("輪郭の座標が不正です。");
      }
    }
  }
  for (const i of p.items)
    if (
      i.targetId !== undefined &&
      (i.type !== "bridge" ||
        typeof i.targetId !== "string" ||
        !p.items.some(
          (owner) => owner.id === i.targetId && owner.type !== "bridge",
        ))
    )
      throw Error("ブリッジの対象が不正です。");
  // Reference dimensions (issue #4) live beside the geometry and never reach
  // the cut output. Older files simply have none.
  const annotations = validateAnnotations(p.annotations);
  // Stamp Mode (issue #12). Files without these fields are cut projects; the
  // stamp settings are kept while cutting so switching back restores them.
  if (p.fabrication !== undefined && !["cut", "stamp"].includes(p.fabrication))
    throw Error("加工の種類が不正です。");
  const stamp = p.stamp === undefined ? null : normalizeStamp(p.stamp);
  // LeatherFab: parts, stitch lines and joints live beside the items.
  const leather = validateLeather(p.leather, p.items);
  return ensureLayers({
    version: 2,
    layers: p.layers,
    name: typeof p.name === "string" ? p.name.slice(0, 100) : "無題",
    width: p.width,
    height: p.height,
    items: p.items,
    ...(annotations.length ? { annotations } : {}),
    ...(p.fabrication === "stamp" ? { fabrication: "stamp" } : {}),
    ...(stamp ? { stamp } : {}),
    // Only present when the file had it, so plain TypeFab files round-trip
    // unchanged; the editor creates it on first use (ensureLeather).
    ...(p.leather !== undefined ? { leather } : {}),
  });
}
const DIMENSIONS = ["linear", "horizontal", "vertical", "angle", "radius", "diameter"];
export function validateAnnotations(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 500) throw Error("寸法データが不正です。");
  const ok = (n) => Number.isFinite(n) && Math.abs(n) <= 10000;
  for (const d of list) {
    if (
      !d ||
      d.type !== "dimension" ||
      typeof d.id !== "string" ||
      !DIMENSIONS.includes(d.dimensionType) ||
      !Array.isArray(d.points) ||
      d.points.length !== (d.dimensionType === "angle" ? 3 : 2) ||
      d.points.some((q) => !q || !ok(q.x) || !ok(q.y)) ||
      !ok(d.value) ||
      !ok(d.offset ?? 0)
    )
      throw Error("寸法データが不正です。");
  }
  return list.map((d) => ({
    id: d.id,
    type: "dimension",
    dimensionType: d.dimensionType,
    points: d.points.map((q) => ({ x: q.x, y: q.y })),
    offset: d.offset ?? 6,
    value: d.value,
  }));
}
