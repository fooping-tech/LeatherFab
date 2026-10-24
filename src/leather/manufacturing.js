// Manufacturing Engine: turns the project plus its derived leather geometry
// into operation groups (CUT / PUNCH / SCORE / ENGRAVE), checks them, applies
// kerf compensation and writes the laser SVG. Operations are explicit data —
// never inferred from stroke colours — and each becomes its own SVG group.
import { visibleItems } from "../layers.js";
import { worldContours, bounds } from "../geometry.js";
import { offsetClosed } from "../cad.js";
import { signedArea, segmentsIntersect } from "../polygon.js";
import { isClosedPolyline, totalLength } from "./polyline.js";
import { OPERATIONS } from "./model.js";

export const OPERATION_ORDER = ["ENGRAVE", "SCORE", "PUNCH", "CUT"]; // inside-out: cut last
export const OPERATION_COLORS = Object.freeze({ CUT: "#ff0000", PUNCH: "#0000ff", SCORE: "#00a000", ENGRAVE: "#000000" });
const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-7;
// Items that are not a part's outline still cut (or engrave, for text).
export function itemOperation(item) {
  if (item.operation in OPERATIONS) return item.operation;
  return item.type === "text" ? "ENGRAVE" : "CUT";
}
// { CUT: [{ points, source }], PUNCH: [...], SCORE: [...], ENGRAVE: [...] }
// for the visible items. `derived` comes from deriveProject().
export function operationGeometry(project, derived) {
  const groups = { CUT: [], PUNCH: [], SCORE: [], ENGRAVE: [] };
  const partByItem = new Map(derived.parts.filter((d) => d.item).map((d) => [d.item.id, d]));
  for (const item of visibleItems(project)) {
    if (item.type === "bridge") continue;
    const d = partByItem.get(item.id);
    const op = d ? d.part.outlineOperation : itemOperation(item);
    for (const ring of worldContours(item)) groups[op].push({ points: ring, source: { itemId: item.id, kind: "outline", partId: d?.part.id } });
    if (!d) continue;
    for (const s of d.stitch) for (const h of s.holes) groups.PUNCH.push({ points: h.contour, source: { partId: d.part.id, lineId: s.line.id, kind: "stitch" } });
    for (const f of d.folds) groups.SCORE.push({ points: f.points, source: { partId: d.part.id, lineId: f.fold.id, kind: "fold" } });
    for (const hw of d.hardware) for (const ring of hw.contours) groups.PUNCH.push({ points: ring, source: { partId: d.part.id, lineId: hw.placement.id, kind: "hardware" } });
  }
  return groups;
}
// Kerf compensation: the beam removes `kerf` mm, so outer cut rings grow by
// kerf/2 and inner rings (holes in an outline, punched holes) shrink by it.
// Open paths and score/engrave lines are left alone.
export function applyKerf(groups, kerf) {
  if (!(kerf > 0)) return groups;
  const half = kerf / 2;
  const out = {};
  for (const [op, list] of Object.entries(groups)) {
    if (op === "SCORE" || op === "ENGRAVE") {
      out[op] = list;
      continue;
    }
    // Rings of one item share an orientation convention only after a union;
    // here the outermost ring of each item is the one with the largest area.
    const byItem = new Map();
    for (const g of list) {
      const k = g.source.kind === "outline" ? g.source.itemId : `${g.source.partId}:${g.source.lineId}:${list.indexOf(g)}`;
      if (!byItem.has(k)) byItem.set(k, []);
      byItem.get(k).push(g);
    }
    out[op] = [];
    for (const rings of byItem.values()) {
      const closed = rings.filter((g) => isClosedPolyline(g.points));
      out[op].push(...rings.filter((g) => !isClosedPolyline(g.points)));
      if (!closed.length) continue;
      let outer = closed[0];
      for (const g of closed) if (Math.abs(signedArea(g.points)) > Math.abs(signedArea(outer.points))) outer = g;
      for (const g of closed) {
        const grow = op === "PUNCH" ? -half : g === outer ? half : -half;
        const rings2 = offsetClosed([g.points], grow, "round");
        if (!rings2.length) continue; // a hole smaller than the kerf vanishes
        for (const r of rings2) out[op].push({ ...g, points: r, kerf: grow });
      }
    }
  }
  return out;
}
// Self-intersection of one polyline (O(n²) on segments, with a bounding box
// pre-check; fine for a few thousand segments).
export function selfIntersects(points) {
  const n = points.length - 1;
  if (n < 3) return false;
  const closed = isClosedPolyline(points);
  for (let i = 0; i < n; i++) {
    const a = points[i],
      b = points[i + 1];
    const minx = Math.min(a.x, b.x), maxx = Math.max(a.x, b.x), miny = Math.min(a.y, b.y), maxy = Math.max(a.y, b.y);
    for (let j = i + 2; j < n; j++) {
      if (closed && i === 0 && j === n - 1) continue;
      const c = points[j],
        d = points[j + 1];
      if (Math.max(c.x, d.x) < minx || Math.min(c.x, d.x) > maxx || Math.max(c.y, d.y) < miny || Math.min(c.y, d.y) > maxy) continue;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}
// Pre-manufacturing checks on the operation groups and the board.
export function checkManufacturing(project, groups, derived) {
  const issues = [];
  const push = (level, message, extra) => issues.push({ level, message, ...extra });
  const W = project.width,
    H = project.height;
  let open = 0, selfX = 0, tiny = 0, outside = 0, dup = 0;
  const seen = new Map();
  for (const op of OPERATION_ORDER)
    for (const g of groups[op]) {
      const pts = g.points;
      const closed = isClosedPolyline(pts);
      if (op === "CUT" && !closed && g.source.kind === "outline") open++;
      if (totalLength(pts) < 0.5 && op !== "PUNCH") tiny++;
      if (closed && selfIntersects(pts)) selfX++;
      if (pts.some((p) => p.x < -1e-6 || p.y < -1e-6 || p.x > W + 1e-6 || p.y > H + 1e-6)) outside++;
      if (op === "CUT" && closed) {
        const b = bounds([pts]);
        const key = `${b.x.toFixed(2)}:${b.y.toFixed(2)}:${b.w.toFixed(2)}:${b.h.toFixed(2)}:${totalLength(pts).toFixed(2)}`;
        if (seen.has(key)) dup++;
        seen.set(key, true);
      }
    }
  if (open) push("warning", `閉じていないカット線が ${open} 本あります（切り落とされません）。`, { code: "OPEN_PATH" });
  if (selfX) push("error", `自己交差する輪郭が ${selfX} 個あります。`, { code: "SELF_INTERSECTION" });
  if (dup) push("warning", `重複したカット線が ${dup} 本あります（二度切りで焦げます）。`, { code: "DUPLICATE_CUT" });
  if (tiny) push("warning", `0.5 mm 未満の微小パスが ${tiny} 本あります。`, { code: "TINY_PATH" });
  if (outside) push("error", `加工エリア外にはみ出すパスが ${outside} 本あります。`, { code: "OUTSIDE_BOARD" });
  return issues;
}
const num = (n) => Number(n.toFixed(4));
const pathData = (rings) =>
  rings.map((ps) => ps.map((p, i) => `${i ? "L" : "M"}${num(p.x)} ${num(p.y)}`).join(" ") + (same(ps[0], ps.at(-1)) ? " Z" : "")).join(" ");
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
// The laser SVG: mm units, one group per operation in cutting order (engrave,
// score, punch, cut) with data-operation attributes; colours are only a
// convenience for laser software that maps by colour.
export function exportLeatherSVG(project, derived, { kerf = project.leather?.kerf ?? 0, crop = false, strokeWidth = 0.1 } = {}) {
  const groups = applyKerf(operationGeometry(project, derived), kerf);
  const all = OPERATION_ORDER.flatMap((op) => groups[op].map((g) => g.points));
  if (!all.length) throw new Error("出力できる加工データがありません。");
  let ox = 0, oy = 0, width = project.width, height = project.height;
  if (crop) {
    const b = bounds(all);
    ox = b.x; oy = b.y; width = Math.max(b.w, 0.1); height = Math.max(b.h, 0.1);
  }
  const shift = (ps) => (crop ? ps.map((p) => ({ x: p.x - ox, y: p.y - oy })) : ps);
  const body = OPERATION_ORDER.filter((op) => groups[op].length)
    .map((op) => {
      const paths = groups[op]
        .map((g) => `<path d="${pathData([shift(g.points)])}" fill="none" stroke="${OPERATION_COLORS[op]}" stroke-width="${strokeWidth}"${g.source.partId ? ` data-part="${xml(g.source.partId)}"` : ""}${g.source.lineId ? ` data-line="${xml(g.source.lineId)}"` : ""}/>`)
        .join("\n");
      return `<g id="${op}" data-operation="${op}" inkscape:groupmode="layer" inkscape:label="${op}">\n${paths}\n</g>`;
    })
    .join("\n");
  const holes = groups.PUNCH.length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${num(width)}mm" height="${num(height)}mm" viewBox="0 0 ${num(width)} ${num(height)}">\n<title>LeatherFab pattern</title>\n<desc>Units: mm. Groups: ENGRAVE, SCORE, PUNCH (${holes} holes), CUT. Kerf compensation: ${kerf} mm. Flattening tolerance: 0.02 mm (holes 0.01 mm).</desc>\n${body}\n</svg>\n`;
}
// Summary numbers for the status bar / checks panel.
export function manufacturingSummary(groups) {
  const len = (op) => groups[op].reduce((n, g) => n + totalLength(g.points), 0);
  return { cut: groups.CUT.length, punch: groups.PUNCH.length, score: groups.SCORE.length, engrave: groups.ENGRAVE.length, cutLength: len("CUT"), punchLength: len("PUNCH"), scoreLength: len("SCORE") };
}
