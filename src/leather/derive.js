// Dependency Engine: everything a LeatherPart owns is derived from its
// outline item on demand. There is no stored hole geometry; deriveProject()
// rebuilds stitch lines, holes, fold lines and hardware from the current
// items, so moving, resizing or node-editing the outline moves them too.
// Dependencies form a DAG (joint → stitch line → part → item), so there is
// no cycle to detect; an unresolved reference becomes an issue on the part
// and the dependent element is simply absent — never silently wrong.
import { transform, worldContours } from "../geometry.js";
import { pathContours } from "../path.js";
import { workingPathOf } from "../cad.js";
import { placeHoles, holeContour } from "./stitch.js";
import { curve, offsetInward, isClosedPolyline, nearestOnPolyline, totalLength, pointAt, slice, nearestArcLength } from "./polyline.js";
import { presetById, hardwareContours } from "./hardware.js";
import { MATERIALS } from "./model.js";

const issue = (level, message, extra = {}) => ({ level, message, ...extra });
// Applies a line's `skipped` list to placed holes: for each recorded
// position the nearest hole (within 0.6 pitch) is marked skipped. Returns
// { holes (kept), skippedHoles, orphans (skips that matched nothing) }.
export function applySkips(holes, line, result) {
  const L = result?.length ?? 0;
  const skips = line.skipped ?? [];
  if (!skips.length || !holes.length || !(L > 0)) return { holes, skippedHoles: [], orphans: [] };
  const pitch = line.pattern?.pitch ?? 4;
  const taken = new Set();
  const orphans = [];
  for (const k of skips) {
    let best = null;
    for (const h of holes) {
      if (taken.has(h)) continue;
      let d = Math.abs(h.s / L - k.u);
      if (result.closed) d = Math.min(d, 1 - d);
      if (!best || d < best.d) best = { d, h };
    }
    if (best && best.d * L <= pitch * 0.6) taken.add(best.h);
    else orphans.push(k);
  }
  return { holes: holes.filter((h) => !taken.has(h)), skippedHoles: holes.filter((h) => taken.has(h)), orphans };
}
// The editable path of the outline item in item-local coordinates.
export const outlinePath = (item) => workingPathOf(item);
// Flattened local polyline of the source run: {points, closed} or an error.
export function resolveSource(path, source) {
  const sub = path[source.subpath];
  if (!sub) return { error: `サブパス ${source.subpath + 1} がありません。` };
  const n = sub.nodes.length;
  if (source.from === null) {
    if (!sub.closed) return { error: "開いたパスには辺の範囲を指定してください。" };
    const pts = pathContours([sub])[0];
    return pts && pts.length > 2 ? { points: pts, closed: true } : { error: "輪郭が短すぎます。" };
  }
  if (source.from >= n || source.to >= n) return { error: `辺の参照（ノード ${source.from}→${source.to}）が外形のノード数 ${n} を超えています。外形のノードが減ったため無効です。` };
  // Nodes from `from` forward to `to` (wrapping on closed subpaths).
  const nodes = [];
  let i = source.from;
  for (let guard = 0; guard <= n; guard++) {
    nodes.push(structuredClone(sub.nodes[i]));
    if (i === source.to && guard > 0) break;
    if (!sub.closed && i === n - 1) return { error: "開いたパスの辺の範囲が終点を越えています。" };
    i = (i + 1) % n;
    if (i === source.from && guard > 0) {
      // from === to on a closed path: the full loop starting at that node.
      nodes.push(structuredClone(sub.nodes[i]));
      break;
    }
  }
  if (nodes.length < 2) return { error: "辺の範囲が短すぎます。" };
  delete nodes[0].in;
  delete nodes.at(-1).out;
  const closed = source.from === source.to;
  const pts = pathContours([{ closed: false, nodes }])[0];
  return pts && pts.length > 1 ? { points: pts, closed } : { error: "辺の長さが0です。" };
}
const toWorld = (pts, item) => pts.map((p) => transform(p, item));
// Geometry of one line of a part: the offset polyline in world mm.
export function resolveLine(item, path, line, ring) {
  const run = resolveSource(path, line.source);
  if (run.error) return { error: run.error };
  const world = toWorld(run.points, item);
  if (!(line.offset > 0)) return { points: world, closed: run.closed };
  if (!run.closed && ring && isClosedPolyline(ring)) {
    // A run of edges of a closed outline: inset the whole outline and keep
    // the stretch between the run's end nodes, so the line also stops
    // `offset` short of the neighbouring edges (as a stitch line should).
    const inner = offsetInward(ring, line.offset, { closed: true });
    if (!inner) return { error: `オフセット ${line.offset} mm で輪郭が消えました。距離を小さくしてください。` };
    const c = curve(inner, true);
    // Each end is the point of the inset ring nearest to the end node pushed
    // inward along the normal of the run's end edge: the inset corner at a
    // convex corner, the end of this edge's offset at a concave one.
    let sum = 0;
    for (let i = 1; i < ring.length; i++) sum += ring[i - 1].x * ring[i].y - ring[i].x * ring[i - 1].y;
    const side = sum > 0 ? 1 : -1;
    const pushed = (node, a, b) => {
      const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: node.x + (side * -(b.y - a.y) * line.offset) / l, y: node.y + (side * (b.x - a.x) * line.offset) / l };
    };
    const n = world.length;
    const s0 = nearestArcLength(c, pushed(world[0], world[0], world[1])),
      s1 = nearestArcLength(c, pushed(world[n - 1], world[n - 2], world[n - 1]));
    const pts = slice(c, s0, s1);
    return pts.length >= 2 ? { points: pts, closed: false } : { error: "辺の範囲が短すぎます。" };
  }
  const off = offsetInward(world, line.offset, { closed: run.closed, ring });
  if (!off) return { error: `オフセット ${line.offset} mm で輪郭が消えました。距離を小さくしてください。` };
  return { points: off, closed: run.closed };
}
export function derivePart(project, part) {
  const item = project.items.find((i) => i.id === part.itemId);
  const d = { part, item: item ?? null, outline: [], ring: null, stitch: [], folds: [], hardware: [], issues: [] };
  if (!item) {
    d.issues.push(issue("error", `パーツ「${part.name}」の外形オブジェクトが見つかりません。`, { partId: part.id }));
    return d;
  }
  if (item.type === "bridge" || item.type === "line") {
    d.issues.push(issue("error", `「${item.name}」は革パーツの外形にできません（閉じた図形を使ってください）。`, { partId: part.id }));
    return d;
  }
  d.outline = worldContours(item);
  const path = outlinePath(item);
  d.path = path;
  const closedRings = d.outline.filter(isClosedPolyline);
  if (!closedRings.length) d.issues.push(issue("error", `パーツ「${part.name}」の外形が閉じていません。`, { partId: part.id }));
  // The ring of the first subpath decides the inside for open runs.
  d.ring = closedRings[0] ?? null;
  for (const line of part.stitchLines) {
    if (line.source.kind === "projected") {
      d.stitch.push({ line, projected: true, holes: [], points: [], closed: false, result: null });
      continue; // resolved in deriveProject once the source part is derived
    }
    const sub = path[line.source.subpath];
    const ring = sub ? toWorld(pathContours([{ ...sub, closed: true }])[0] ?? [], item) : d.ring;
    const g = resolveLine(item, path, line, ring);
    if (g.error) {
      d.issues.push(issue("error", `縫い線「${line.name}」: ${g.error}`, { partId: part.id, lineId: line.id }));
      d.stitch.push({ line, error: g.error, holes: [] });
      continue;
    }
    const result = placeHoles(g.points, line.pattern, { closed: g.closed });
    const allHoles = result.holes.map((h) => ({ ...h, contour: holeContour(h, line.pattern) }));
    const sk = applySkips(allHoles, line, result);
    for (const w of result.warnings) d.issues.push(issue("warning", `縫い線「${line.name}」: ${w}`, { partId: part.id, lineId: line.id }));
    if (sk.orphans.length) d.issues.push(issue("warning", `縫い線「${line.name}」: 消した穴の記録 ${sk.orphans.length} 件が現在の穴と対応しません（ピッチや形が大きく変わりました）。`, { partId: part.id, lineId: line.id }));
    d.stitch.push({ line, points: g.points, closed: g.closed, result, holes: sk.holes, allHoles, skippedHoles: sk.skippedHoles });
  }
  for (const fold of part.foldLines) {
    if (fold.source.kind === "projected") continue;
    const sub = path[fold.source.subpath];
    const ring = sub ? toWorld(pathContours([{ ...sub, closed: true }])[0] ?? [], item) : d.ring;
    const g = resolveLine(item, path, fold, ring);
    if (g.error) {
      d.issues.push(issue("error", `折り線「${fold.name}」: ${g.error}`, { partId: part.id, lineId: fold.id }));
      continue;
    }
    d.folds.push({ fold, points: g.points, closed: g.closed, length: totalLength(g.points) });
  }
  for (const h of part.hardware) {
    const preset = presetById(h.presetId, project.leather?.hardwarePresets);
    if (!preset) {
      d.issues.push(issue("error", `金具プリセット「${h.presetId}」がありません。`, { partId: part.id, lineId: h.id }));
      continue;
    }
    const a = ((item.rotation + h.rotation) * Math.PI) / 180,
      c = Math.cos(a),
      s = Math.sin(a),
      center = transform({ x: h.x, y: h.y }, item);
    const contours = hardwareContours(preset).map((ring) => ring.map((p) => ({ x: center.x + p.x * c - p.y * s, y: center.y + p.x * s + p.y * c })));
    d.hardware.push({ placement: h, preset, center, contours, rotation: item.rotation + h.rotation });
  }
  const mat = MATERIALS[part.material] ?? MATERIALS.unknown;
  if (mat.laser !== "ok") d.issues.push(issue(mat.laser === "ng" ? "error" : "warning", `${mat.label}: ${mat.note}`, { partId: part.id }));
  return d;
}
// Matches the holes of two stitch lines that will be sewn together. Both
// lines are placed with their own pattern first; when the counts differ the
// slave line is re-placed with the master's count so every hole has a
// partner. Positions are compared in normalised seam coordinates (0..1 along
// the line, optionally reversed), which is what matters when the two edges
// are sewn together, and reported as deviations in mm on the slave line.
export function deriveJoint(joint, derivedParts) {
  const find = (ref) => {
    const dp = derivedParts.find((d) => d.part.id === ref.partId);
    const st = dp?.stitch.find((s) => s.line.id === ref.lineId);
    return dp && st && !st.error ? { dp, st } : null;
  };
  const A = find(joint.a),
    B = find(joint.b);
  if (!A || !B) return { joint, error: "縫合する縫い線が見つからないか、計算できません。", issues: [issue("error", `縫合「${joint.name}」: 縫い線が見つかりません。`, { jointId: joint.id })] };
  const [master, slave] = joint.master === "b" ? [B, A] : [A, B];
  // Pair on the full placements; holes erased on either side drop out of
  // both so the pieces still match hole for hole.
  const masterAll = master.st.allHoles ?? master.st.holes;
  const count = masterAll.length;
  let slaveResult = slave.st.result,
    slaveHoles = slave.st.allHoles ?? slave.st.holes,
    adjusted = false;
  if (slaveHoles.length !== count && count > 0) {
    slaveResult = placeHoles(slave.st.points, { ...slave.st.line.pattern, fit: "count", count }, { closed: slave.st.closed });
    slaveHoles = slaveResult.holes.map((h) => ({ ...h, contour: holeContour(h, slave.st.line.pattern) }));
    adjusted = true;
  }
  const issues = [];
  const lenA = master.st.result.length,
    lenB = slaveResult.length;
  const lengthDiff = Math.abs(lenA - lenB);
  if (lengthDiff > 0.5) issues.push(issue("warning", `縫合「${joint.name}」: 辺の長さが ${lenA.toFixed(1)} mm と ${lenB.toFixed(1)} mm で ${lengthDiff.toFixed(1)} mm 違います。`, { jointId: joint.id }));
  if (slaveHoles.length !== count) issues.push(issue("error", `縫合「${joint.name}」: 穴数が一致しません（${count} と ${slaveHoles.length}）。`, { jointId: joint.id }));
  // Pairing: hole i of the master ↔ hole i (or count-1-i when reversed) of
  // the slave; deviation = distance along the slave line between the
  // partner's actual position and the master's normalised position.
  const pairs = [];
  let maxDeviation = 0;
  let masterKept = master.st.holes,
    slaveKept = slaveHoles;
  if (slaveHoles.length === count && count > 0) {
    const slaveCurve = curve(slave.st.points, slave.st.closed);
    const masterSkipped = new Set((master.st.skippedHoles ?? []).map((h) => h.index));
    const slaveSkipped = new Set(applySkips(slaveHoles, slave.st.line, slaveResult).skippedHoles.map((h) => h.index));
    const keepA = new Set(), keepB = new Set();
    for (let i = 0; i < count; i++) {
      const j = joint.reverse ? count - 1 - i : i;
      const u = lenA > 0 ? masterAll[i].s / lenA : 0;
      const expectedS = joint.reverse ? lenB * (1 - u) : lenB * u;
      let dev = Math.abs(slaveHoles[j].s - expectedS);
      if (slave.st.closed) dev = Math.min(dev, lenB - dev);
      maxDeviation = Math.max(maxDeviation, dev);
      const erased = masterSkipped.has(masterAll[i].index) || slaveSkipped.has(slaveHoles[j].index);
      if (erased) continue;
      keepA.add(masterAll[i]);
      keepB.add(slaveHoles[j]);
      pairs.push({ a: masterAll[i], b: slaveHoles[j], deviation: dev, expected: pointAt(slaveCurve, expectedS) });
    }
    masterKept = masterAll.filter((h) => keepA.has(h));
    slaveKept = slaveHoles.filter((h) => keepB.has(h));
    if (maxDeviation > 1) issues.push(issue("warning", `縫合「${joint.name}」: 穴位置の最大ずれ ${maxDeviation.toFixed(2)} mm（縫い合わせると革がよれる可能性があります）。`, { jointId: joint.id }));
  }
  return { joint, master: master.st, slave: slave.st, masterHoles: masterKept, slaveHoles: slaveKept, slaveResult, adjusted, count, lengthDiff, maxDeviation, pairs, issues };
}
// Composition of a part item's world transform with a placement given in
// that item's local frame: the virtual item where the source part sat.
export function composePlacement(item, placement) {
  const origin = transform({ x: placement.x, y: placement.y }, item);
  return { x: origin.x, y: origin.y, rotation: item.rotation + placement.rotation };
}
// The placement of `topItem` expressed in `bottomItem`'s local frame.
export function relativePlacement(bottomItem, topItem) {
  const local = transform({ x: topItem.x, y: topItem.y }, bottomItem, true);
  return { x: Number(local.x.toFixed(4)), y: Number(local.y.toFixed(4)), rotation: Number((topItem.rotation - bottomItem.rotation).toFixed(4)) };
}
function insideRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
// Resolves one projected line of `d` from the (already derived) source part.
function deriveProjected(project, d, st, parts) {
  const src = st.line.source;
  const sp = parts.find((x) => x.part.id === src.partId);
  const sl = sp?.stitch.find((s) => s.line.id === src.lineId);
  if (!sp?.item || !sl || sl.error) return `投影元の縫い線が見つからないか、計算できません。`;
  if (sl.projected) return "投影された縫い線をさらに投影することはできません。";
  // The source line placed where the source item was when it was captured.
  const virtual = { ...sp.item, ...composePlacement(d.item, src.placement) };
  const path = outlinePath(virtual);
  const sub = path[sl.line.source.subpath];
  const ring = sub ? toWorld(pathContours([{ ...sub, closed: true }])[0] ?? [], virtual) : null;
  const g = resolveLine(virtual, path, sl.line, ring);
  if (g.error) return g.error;
  const result = placeHoles(g.points, sl.line.pattern, { closed: g.closed });
  const outer = d.ring;
  let dropped = 0;
  const holes = [];
  for (const h of result.holes) {
    if (outer && !insideRing(h, outer)) {
      dropped++;
      continue;
    }
    holes.push({ ...h, contour: holeContour(h, sl.line.pattern) });
  }
  const sk = applySkips(holes, st.line, result);
  Object.assign(st, { points: g.points, closed: g.closed, result, holes: sk.holes, allHoles: holes, skippedHoles: sk.skippedHoles, sourcePart: sp.part, sourceLine: sl.line, dropped });
  if (dropped) d.issues.push(issue("warning", `縫い線「${st.line.name}」: 投影した穴のうち ${dropped} 個がこのパーツの外にあるため省きました。`, { partId: d.part.id, lineId: st.line.id }));
  if (!holes.length) d.issues.push(issue("warning", `縫い線「${st.line.name}」: 投影した穴がこのパーツに1つもかかっていません。`, { partId: d.part.id, lineId: st.line.id }));
  return null;
}
// Second pass: projected lines, once every source part is derived.
export function resolveProjectedLines(project, parts) {
  for (const d of parts)
    for (const st of d.stitch)
      if (st.projected && d.item) {
        const error = deriveProjected(project, d, st, parts);
        if (error) {
          st.error = error;
          d.issues.push(issue("error", `縫い線「${st.line.name}」: ${error}`, { partId: d.part.id, lineId: st.line.id }));
        }
      }
  return parts;
}
// Everything derived for the project. Joints may replace the slave line's
// holes, so the returned parts already carry the harmonised holes.
export function deriveProject(project) {
  const leather = project.leather;
  const parts = (leather?.parts ?? []).map((p) => derivePart(project, p));
  resolveProjectedLines(project, parts);
  const joints = (leather?.joints ?? []).map((j) => deriveJoint(j, parts));
  for (const dj of joints) {
    if (dj.error) continue;
    if (dj.masterHoles && dj.masterHoles.length !== dj.master.holes.length) dj.master.holes = dj.masterHoles;
    if (dj.adjusted || (dj.slaveHoles && dj.slaveHoles.length !== dj.slave.holes.length)) {
      dj.slave.holes = dj.slaveHoles;
      dj.slave.result = dj.slaveResult;
      if (dj.adjusted) dj.slave.joined = dj.joint.id;
    }
  }
  const issues = [...parts.flatMap((d) => d.issues), ...joints.flatMap((j) => j.issues)];
  return { parts, joints, issues };
}
// Design-rule checks on derived geometry (reported, never enforced).
export function checkParts(derived, { edgeDistance = 1.0 } = {}) {
  const out = [];
  for (const d of derived.parts) {
    if (!d.item) continue;
    const all = d.stitch.flatMap((s) => s.holes.map((h) => ({ ...h, line: s.line })));
    // Hole to outline distance.
    for (const h of all) {
      let min = Infinity;
      for (const ring of d.outline) min = Math.min(min, nearestOnPolyline(ring, h).d);
      const need = edgeDistance + Math.max(h.contour ? 0 : 0, 0);
      if (min < need) out.push(issue("warning", `パーツ「${d.part.name}」: 穴が外形から ${min.toFixed(2)} mm しか離れていません（${h.line.name}）。`, { partId: d.part.id, lineId: h.line.id }));
      if (min === Infinity) break;
    }
    // Hole to hole interference across lines (same line is handled in placement).
    const grid = new Map();
    const key = (x, y) => `${Math.floor(x / 2)}:${Math.floor(y / 2)}`;
    let clashes = 0;
    for (const h of all) {
      const k = key(h.x, h.y);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          for (const g of grid.get(`${Math.floor(h.x / 2) + dx}:${Math.floor(h.y / 2) + dy}`) ?? [])
            if (g.line !== h.line && Math.hypot(g.x - h.x, g.y - h.y) < Math.max(h.line.pattern.length, h.line.pattern.width)) clashes++;
        }
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(h);
    }
    if (clashes) out.push(issue("warning", `パーツ「${d.part.name}」: 別の縫い線の穴どうしが ${clashes} か所で干渉しています。`, { partId: d.part.id }));
    // Hardware inside the outline.
    for (const hw of d.hardware)
      if (d.ring && nearestOnPolyline(d.ring, hw.center).d < (hw.preset.outer ?? 0) / 2)
        out.push(issue("warning", `パーツ「${d.part.name}」: 金具「${hw.preset.label}」が外形に近すぎます。`, { partId: d.part.id, lineId: hw.placement.id }));
  }
  return out;
}
