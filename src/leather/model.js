// Leather Domain Core: the LeatherPart model that lives beside the TypeFab
// items in project.leather, and its validation / migration. Nothing here is
// geometry; derive.js turns the model into holes and lines.
//
//   project.leather = {
//     schemaVersion: 1,
//     parts: [LeatherPart], joints: [StitchJoint], hardwarePresets: [preset],
//     kerf: 0 (mm, laser beam width compensation applied at export)
//   }
//   LeatherPart = { id, itemId, name, thickness, material, color, quantity,
//     side: "front"|"back", stitchLines: [StitchLine], foldLines: [FoldLine],
//     hardware: [HardwarePlacement], outlineOperation: "CUT" }
//   A line's geometry is derived from the part's outline item:
//   source = { subpath, from, to }  (node indices of the item's editable path;
//     from === to === null → the whole closed subpath; otherwise the run of
//     edges from node `from` forward to node `to`)
//   StitchLine = { id, name, source, offset (mm inward), pattern: StitchPattern }
//   FoldLine   = { id, name, source, offset, kind: "mountain"|"valley", operation: "SCORE" }
//   HardwarePlacement = { id, presetId, x, y (item-local mm), rotation }
//   StitchJoint = { id, name, a: {partId, lineId}, b: {partId, lineId},
//     reverse: boolean, master: "a" | "b" }
import { normalizePattern, DEFAULT_PATTERN } from "./stitch.js";
import { validateHardwarePreset } from "./hardware.js";
import { normalizeHistory } from "./history.js";

export const SCHEMA_VERSION = 1;
export const OPERATIONS = Object.freeze({ CUT: "CUT", PUNCH: "PUNCH", SCORE: "SCORE", ENGRAVE: "ENGRAVE" });
export const OPERATION_LABELS = Object.freeze({ CUT: "CUT 外形切断", PUNCH: "PUNCH 穴あけ", SCORE: "SCORE 折り線・位置合わせ", ENGRAVE: "ENGRAVE 彫刻" });
// Material presets with laser suitability. "unknown" is never reported as
// safe: chrome-tanned leather and coated/synthetic materials release harmful
// fumes, and the tanning of an unknown hide cannot be assumed.
export const MATERIALS = Object.freeze({
  "veg-tan": { label: "タンニンなめし革（ヌメ革）", laser: "ok", note: "レーザー加工に一般的に適します。焦げ・臭いは換気で対処。" },
  "chrome-tan": { label: "クロムなめし革", laser: "caution", note: "クロム化合物を含み、加工時の煙に有害物質が含まれる可能性があります。十分な排気がない環境では避けてください。" },
  combination: { label: "混合なめし革", laser: "caution", note: "クロムを含む可能性があります。製造者情報を確認してください。" },
  "coated-pvc": { label: "合成皮革・PVC コーティング", laser: "ng", note: "塩化ビニルは加工時に塩素ガスを発生させます。レーザー加工しないでください。" },
  pu: { label: "PU レザー（ポリウレタン）", laser: "caution", note: "基材・コーティングにより異なります。材料データシートを確認してください。" },
  unknown: { label: "不明", laser: "unknown", note: "なめし方法・コーティングが不明な革は加工適性を判断できません。製造者情報を確認してください。" },
});
export const LASER_LABELS = Object.freeze({ ok: "レーザー加工: 適", caution: "レーザー加工: 要確認", ng: "レーザー加工: 不可", unknown: "レーザー加工: 不明" });
export const DEFAULT_THICKNESS = 1.5;
export const DEFAULT_OFFSET = 3;
export const LIMITS = Object.freeze({ thickness: [0.2, 20], quantity: [1, 500], offset: [0, 200], kerf: [0, 1], coordinate: 10000 });

export const emptyLeather = () => ({ schemaVersion: SCHEMA_VERSION, parts: [], joints: [], hardwarePresets: [], kerf: 0 });
export const ensureLeather = (project) => {
  if (!project.leather) project.leather = emptyLeather();
  return project.leather;
};
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const num = (v, [lo, hi], fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const str = (v, fallback, max = 100) => (typeof v === "string" ? v.slice(0, max) : fallback);
const index = (v) => (v === null || v === undefined ? null : Number.isInteger(v) && v >= 0 && v < 100000 ? v : undefined);

export function normalizeSource(s = {}) {
  const from = index(s.from),
    to = index(s.to);
  if (from === undefined || to === undefined) throw Error("辺の参照が不正です。");
  if ((from === null) !== (to === null)) throw Error("辺の範囲は両端を指定してください。");
  const subpath = Number.isInteger(s.subpath) && s.subpath >= 0 && s.subpath < 10000 ? s.subpath : 0;
  return { subpath, from, to };
}
export function makeStitchLine(id, { name = "縫い線", source = { subpath: 0, from: null, to: null }, offset = DEFAULT_OFFSET, pattern = DEFAULT_PATTERN } = {}) {
  return { id, name, source: normalizeSource(source), offset: num(offset, LIMITS.offset, DEFAULT_OFFSET), pattern: normalizePattern(pattern) };
}
export function makeFoldLine(id, { name = "折り線", source, offset = 0, kind = "mountain" } = {}) {
  return { id, name, source: normalizeSource(source), offset: num(offset, LIMITS.offset, 0), kind: kind === "valley" ? "valley" : "mountain", operation: "SCORE" };
}
export function makeHardware(id, { presetId, x = 0, y = 0, rotation = 0 }) {
  if (typeof presetId !== "string" || !ID.test(presetId)) throw Error("金具プリセットが不正です。");
  return { id, presetId, x: num(x, [-LIMITS.coordinate, LIMITS.coordinate], 0), y: num(y, [-LIMITS.coordinate, LIMITS.coordinate], 0), rotation: num(rotation, [-360, 360], 0) };
}
export function makePart(id, itemId, overrides = {}) {
  if (typeof itemId !== "string" || !ID.test(itemId)) throw Error("パーツの外形参照が不正です。");
  return {
    id,
    itemId,
    name: str(overrides.name, "革パーツ"),
    thickness: num(overrides.thickness, LIMITS.thickness, DEFAULT_THICKNESS),
    material: overrides.material in MATERIALS ? overrides.material : "veg-tan",
    color: str(overrides.color, "#b07a4a", 30),
    quantity: Math.round(num(overrides.quantity, LIMITS.quantity, 1)),
    side: overrides.side === "back" ? "back" : "front",
    stitchLines: (overrides.stitchLines ?? []).map((l) => makeStitchLine(l.id, l)),
    foldLines: (overrides.foldLines ?? []).map((l) => makeFoldLine(l.id, l)),
    hardware: (overrides.hardware ?? []).map((h) => makeHardware(h.id, h)),
    outlineOperation: overrides.outlineOperation in OPERATIONS ? overrides.outlineOperation : "CUT",
    ...(overrides.mirrorOf ? { mirrorOf: normalizeMirrorOf(overrides.mirrorOf) } : {}),
    ...(overrides.history ? { history: normalizeHistory(overrides.history) } : {}),
  };
}
// A mirrored copy linked to its source part: the source's outline and
// settings are re-mirrored into the copy whenever they change (one way).
// `itemKey` / `partKey` remember what was last synced.
export function normalizeMirrorOf(m) {
  const pt = (q) => ({ x: num(q?.x, [-LIMITS.coordinate, LIMITS.coordinate], 0), y: num(q?.y, [-LIMITS.coordinate, LIMITS.coordinate], 0) });
  if (!m || typeof m.partId !== "string" || !ID.test(m.partId) || !m.axis) throw Error("ミラーのリンクが不正です。");
  return { partId: m.partId, axis: { a: pt(m.axis.a), b: pt(m.axis.b) }, itemKey: str(m.itemKey, "", 200), partKey: str(m.partKey, "", 200) };
}
export function makeJoint(id, { name = "縫合", a, b, reverse = false, master = "a" }) {
  const ref = (r) => {
    if (!r || typeof r.partId !== "string" || !ID.test(r.partId) || typeof r.lineId !== "string" || !ID.test(r.lineId)) throw Error("縫合の参照が不正です。");
    return { partId: r.partId, lineId: r.lineId };
  };
  return { id, name: str(name, "縫合"), a: ref(a), b: ref(b), reverse: Boolean(reverse), master: master === "b" ? "b" : "a" };
}
// Validates project.leather (throws on malformed data) and returns a clean
// copy. Items referenced by parts must exist; dangling references are kept
// and reported by derive.js as issues, so a file never silently loses parts.
export function validateLeather(raw, items = []) {
  if (raw === undefined || raw === null) return emptyLeather();
  if (typeof raw !== "object" || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) throw Error("LeatherFab データ形式が不正です。");
  if (raw.schemaVersion > SCHEMA_VERSION) throw Error(`このファイルは新しい LeatherFab（schema ${raw.schemaVersion}）で保存されています。`);
  const parts = Array.isArray(raw.parts) ? raw.parts : [];
  if (parts.length > 2000) throw Error("パーツ数が多すぎます。");
  const ids = new Set();
  const check = (id, what) => {
    if (typeof id !== "string" || !ID.test(id) || ids.has(id)) throw Error(`${what}のIDが不正です。`);
    ids.add(id);
  };
  const out = emptyLeather();
  for (const p of parts) {
    check(p.id, "パーツ");
    for (const l of [...(p.stitchLines ?? []), ...(p.foldLines ?? []), ...(p.hardware ?? [])]) check(l.id, "線・金具");
    out.parts.push(makePart(p.id, p.itemId, p));
  }
  for (const j of Array.isArray(raw.joints) ? raw.joints : []) {
    check(j.id, "縫合");
    out.joints.push(makeJoint(j.id, j));
  }
  out.hardwarePresets = (Array.isArray(raw.hardwarePresets) ? raw.hardwarePresets : []).map(validateHardwarePreset).filter(Boolean).slice(0, 200);
  out.kerf = num(raw.kerf, LIMITS.kerf, 0);
  void items;
  return out;
}
export const partOfItem = (leather, itemId) => leather?.parts.find((p) => p.itemId === itemId) ?? null;
export const findLine = (part, lineId) => part.stitchLines.find((l) => l.id === lineId) ?? part.foldLines.find((l) => l.id === lineId) ?? null;
// Keeps the leather data consistent when items change: deleted items drop
// their parts (and the joints that used them), replaced items are re-pointed.
export function remapItems(leather, { removed = [], replaced = {} } = {}) {
  if (!leather) return leather;
  const gone = new Set(removed);
  for (const part of leather.parts) if (replaced[part.itemId]) part.itemId = replaced[part.itemId];
  const kept = leather.parts.filter((p) => !gone.has(p.itemId));
  const partIds = new Set(kept.map((p) => p.id));
  leather.parts = kept;
  // A copy whose source is gone becomes an ordinary, unlinked part.
  for (const p of kept) if (p.mirrorOf && !partIds.has(p.mirrorOf.partId)) delete p.mirrorOf;
  leather.joints = leather.joints.filter((j) => partIds.has(j.a.partId) && partIds.has(j.b.partId));
  return leather;
}
