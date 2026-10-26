// LeatherFab UI layer: everything the editor shows and does for leather
// parts, written as an extension that main.js calls at a few hook points
// (toolbar, properties, canvas overlay, checks, export, pointer events).
// Geometry and the model stay in src/leather/*; this file only renders and
// edits project.leather.
import { transform, worldContours, bounds } from "./geometry.js";
import { mirrorItems, axisThrough } from "./cad.js";
import { createMirrorPart, syncMirrorParts, detachMirror } from "./leather/mirror.js";
import { baseFromItem, applyHistory, isStale, describeFeature, describeBase, FEATURE_LABELS, normalizeFeature } from "./leather/history.js";
import { nearestNode } from "./cad.js";
import { nearestSegment } from "./path.js";
import { isClosed } from "./polygon.js";
import {
  ensureLeather, makePart, makeStitchLine, makeFoldLine, makeHardware, makeJoint, partOfItem, remapItems, rebaseItemFrames,
  MATERIALS, LASER_LABELS, LIMITS, OPERATIONS, OPERATION_LABELS, DEFAULT_OFFSET,
} from "./leather/model.js";
import { HOLE_SHAPES, SPACINGS, FITS, CORNER_MODES, PITCH_PRESETS, PATTERN_LIMITS, DEFAULT_PATTERN, spiOf } from "./leather/stitch.js";
import { derivePart, deriveJoint, checkParts, outlinePath, relativePlacement, composePlacement, finishDerivation as deriveProjectForProjected } from "./leather/derive.js";
import { curve as makeCurve, pointAt as curvePointAt } from "./leather/polyline.js";
import { operationGeometry, applyKerf, checkManufacturing, exportLeatherSVG, manufacturingSummary, OPERATION_COLORS, OPERATION_ORDER } from "./leather/manufacturing.js";
import { HARDWARE_PRESETS, HARDWARE_TYPES, presetById } from "./leather/hardware.js";
import { TEMPLATES } from "./leather/templates.js";
import { pathContours } from "./path.js";

export const LEATHER_TOOLS = Object.freeze({
  "hole-erase": { label: "穴を消す", icon: "⊘", hint: "穴をタップで1つ消す · ドラッグで囲んでまとめて消す · Shift（スマホは「複数選択」）を押して別の穴をタップすると、直前に消した穴からその穴までの区間を消す · 薄い印をタップで戻す · Escで終了" },
  "stitch-edge": { label: "辺に縫い線", icon: "⋯", hint: "革パーツの辺をクリックして縫い線を追加 · 隣の辺を続けてクリックすると1本につながる · Escで終了" },
  seam: { label: "縫い合わせ", icon: "⟗", hint: "縫い合わせる辺を2つクリック: 1つ目のパーツの辺 → 相手のパーツの辺 · 両方に同じ設定の縫い線を作り、穴数と位置を合わせます · Escで終了" },
  "fold-edge": { label: "辺に折り線", icon: "⌇", hint: "革パーツの辺をクリックして、その辺に平行な折り線（SCORE）を追加 · Escで終了" },
  hardware: { label: "金具", icon: "◎", hint: "革パーツの上をクリックして金具（穴）を配置 · Escで終了" },
});
const num = (v, d = 2) => Number(v.toFixed(d)).toString();
const pathD = (rings) => rings.map((ps) => ps.map((p, i) => `${i ? "L" : "M"}${num(p.x, 4)} ${num(p.y, 4)}`).join(" ") + (ps.length > 2 && Math.hypot(ps[0].x - ps.at(-1).x, ps[0].y - ps.at(-1).y) < 1e-7 ? " Z" : "")).join(" ");

export function createLeatherUI(ctx) {
  const { $, esc, uid } = ctx;
  const project = () => ctx.project();
  const leather = () => ensureLeather(project());
  // ---- derivation with a per-part cache keyed by the part and its item.
  const cache = new Map();
  function derived() {
    const p = project(),
      l = leather(),
      seen = new Set();
    const parts = l.parts.map((part) => {
      const item = p.items.find((i) => i.id === part.itemId);
      const key = JSON.stringify(part) + "|" + (item ? JSON.stringify(item) : "") + "|" + JSON.stringify(l.hardwarePresets);
      seen.add(part.id);
      const hit = cache.get(part.id);
      if (hit && hit.key === key) return structuredClone(hit.value);
      const value = derivePart(p, part);
      cache.set(part.id, { key, value: structuredClone(value) });
      return value;
    });
    for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
    resolveProjected(parts);
    const joints = l.joints.map((j) => deriveJoint(j, parts, p));
    for (const dj of joints) {
      if (dj.error) continue;
      if (dj.masterHoles && dj.masterHoles.length !== dj.master.holes.length) dj.master.holes = dj.masterHoles;
      if (dj.adjusted || (dj.slaveHoles && dj.slaveHoles.length !== dj.slave.holes.length)) {
        dj.slave.holes = dj.slaveHoles;
        dj.slave.result = dj.slaveResult;
        if (dj.adjusted) dj.slave.joined = dj.joint.id;
      }
    }
    return { parts, joints, issues: [...parts.flatMap((d) => d.issues), ...joints.flatMap((j) => j.issues)] };
  }
  // Projected lines need the other parts, so they are resolved after the
  // per-part cache (deriveProject does the same for the non-cached path).
  function resolveProjected(parts) {
    const p = project();
    const pseudo = { ...p, leather: { ...leather(), parts: parts.map((d) => d.part) } };
    const full = deriveProjectForProjected(pseudo, parts);
    void full;
  }
  const partOf = (itemId) => partOfItem(leather(), itemId);
  const partById = (id) => leather().parts.find((p) => p.id === id) ?? null;
  const canBePart = (item) => item && !["bridge", "line", "text"].includes(item.type) && worldContours(item).some(isClosed);
  const isLeatherTool = (tool) => tool in LEATHER_TOOLS;
  let hover = null; // { itemId, s, i } edge under the pointer in an edge tool
  let continuing = null; // { partId, lineId, kind } line being extended edge by edge
  let live = false; // a checkpoint has been taken for the current slider/number session

  // ---- mutations (each is one undo step)
  function mutate(fn, message) {
    try {
      ctx.checkpoint();
      const r = fn(leather());
      ctx.commit();
      if (message) ctx.notify(typeof message === "function" ? message(r) : message);
      return r;
    } catch (e) {
      ctx.notify(e.message);
      return null;
    }
  }
  function makePartFrom(item, withStitch) {
    if (!canBePart(item)) throw Error("閉じた図形（長方形・楕円・多角形・パス）だけを革パーツにできます。");
    if (partOf(item.id)) return partOf(item.id);
    const lines = withStitch ? [makeStitchLine(uid(), { name: "外周", source: { subpath: 0, from: null, to: null }, ...templateLine() })] : [];
    const part = makePart(uid(), item.id, { name: item.name, stitchLines: lines });
    leather().parts.push(part);
    return part;
  }
  const convertSelection = (withStitch) =>
    mutate(() => {
      const items = ctx.selectedItems().filter(canBePart);
      if (!items.length) throw Error("閉じた図形を選択してください。");
      const targets = [];
      let made = 0,
        stitched = 0,
        already = 0;
      const seed = templateLine(items.map((i) => partOf(i.id)).filter(Boolean));
      for (const item of items) {
        const existing = partOf(item.id);
        const part = makePartFrom(item, false);
        if (!existing) made++;
        if (!withStitch) continue;
        // A part that already has its own stitch line is left alone; one
        // without (converted earlier, mirrored, template…) gets the outline line.
        if (part.stitchLines.some((l) => l.source.kind !== "projected")) {
          already++;
          continue;
        }
        const line = makeStitchLine(uid(), { name: "外周", source: { subpath: 0, from: null, to: null }, ...seed });
        part.stitchLines.push(line);
        rememberStitch(line);
        stitched++;
        targets.push(...projectLineDown(part, line));
      }
      return { made, stitched, already, targets, seed };
    }, ({ made, stitched, already, targets, seed }) =>
      withStitch
        ? `${stitched ? `${stitched} 個のパーツの外周に縫い穴を作りました（縁から ${seed.offset} mm${seed.pattern ? "・既存の縫い線と同じ設定" : ""}）。` : ""}${already ? `${already} 個は既に縫い線があるのでそのままです（追加するにはパネルの「＋ 全周に縫い線」）。` : ""}${made && !stitched ? `${made} 個を革パーツにしました。` : ""}${projectNotice(targets)}`
        : `${made} 個の図形を革パーツにしました。${items.length - made ? `${items.length - made} 個は既に革パーツです。` : ""}`);
  function addFullStitch() {
    mutate(() => {
      const items = ctx.selectedItems().filter(canBePart);
      if (!items.length) throw Error("閉じた図形または革パーツを選択してください。");
      const targets = [];
      for (const item of items) {
        const part = makePartFrom(item, false);
        const line = makeStitchLine(uid(), { name: `外周 ${part.stitchLines.length + 1}`, source: { subpath: 0, from: null, to: null }, ...templateLine([part]) });
        part.stitchLines.push(line);
        rememberStitch(line);
        targets.push(...projectLineDown(part, line));
      }
      return targets;
    }, (targets) => `外周に縫い線を追加しました。${projectNotice(targets)}`);
  }
  // Parts drawn under `part` (earlier in stacking order) whose outline
  // contains most of the holes of `line` receive a projected copy of it.
  function projectLineDown(part, line) {
    const p = project();
    const d = derivePart(p, part);
    const st = d.stitch.find((s) => s.line.id === line.id);
    if (!st || st.error || !st.holes.length || !d.item) return [];
    const topIndex = p.items.findIndex((i) => i.id === part.itemId);
    const targets = [];
    for (const other of leather().parts) {
      if (other.id === part.id) continue;
      const item = p.items.find((i) => i.id === other.itemId);
      const idx = p.items.findIndex((i) => i.id === other.itemId);
      if (!item || idx < 0 || idx > topIndex) continue;
      const ring = worldContours(item).find(isClosed);
      if (!ring) continue;
      const inside = st.holes.filter((h) => insidePolygon(h, ring)).length;
      if (inside < Math.max(2, st.holes.length * 0.5)) continue;
      if (other.stitchLines.some((l) => l.source.kind === "projected" && l.source.lineId === line.id)) continue;
      // Already stitched there (e.g. both pieces carry the same perimeter
      // line): a projection would just double the holes, so leave it out.
      const existing = derivePart(p, other).stitch.flatMap((s) => s.holes);
      const covered = st.holes.filter((h) => existing.some((g) => Math.hypot(g.x - h.x, g.y - h.y) < 1.5)).length;
      if (existing.length && covered >= st.holes.length * 0.5) {
        skippedProjection.push(other);
        continue;
      }
      other.stitchLines.push(makeStitchLine(uid(), { name: `${part.name} / ${line.name}（投影）`, source: { kind: "projected", partId: part.id, lineId: line.id, placement: relativePlacement(item, d.item) }, offset: 0, pattern: line.pattern }));
      targets.push(other);
    }
    return targets;
  }
  let skippedProjection = [];
  const projectNotice = (targets) => {
    const skipped = skippedProjection;
    skippedProjection = [];
    return (targets.length ? ` 下に重なるパーツ「${targets.map((t) => t.name).join("」「")}」にも同じ穴を付けました（上のパーツを動かしても下の穴は残ります）。` : "") + (skipped.length ? ` 「${skipped.map((t) => t.name).join("」「")}」には既に同じ位置の穴があるため投影しませんでした。` : "");
  };
  function recapturePlacement(partId, lineId) {
    mutate(() => {
      const part = partById(partId), line = part?.stitchLines.find((l) => l.id === lineId);
      const bottom = project().items.find((i) => i.id === part?.itemId);
      const src = partById(line?.source.partId);
      const top = project().items.find((i) => i.id === src?.itemId);
      if (!line || !bottom || !top) throw Error("投影元が見つかりません。");
      line.source = { ...line.source, placement: relativePlacement(bottom, top) };
    }, "今の重なり位置で穴の位置を取り直しました。");
  }
  function unmakePart(partId) {
    mutate((l) => remapItems(l, { removed: [partById(partId)?.itemId] }), "革パーツを解除しました（図形は残ります）。");
  }
  function removeEntry(partId, entryId) {
    mutate((l) => {
      const part = l.parts.find((p) => p.id === partId);
      if (!part) return;
      part.stitchLines = part.stitchLines.filter((s) => s.id !== entryId);
      part.foldLines = part.foldLines.filter((s) => s.id !== entryId);
      part.hardware = part.hardware.filter((s) => s.id !== entryId);
      l.joints = l.joints.filter((j) => j.a.lineId !== entryId && j.b.lineId !== entryId);
    });
  }
  function removeJoint(id) {
    mutate((l) => (l.joints = l.joints.filter((j) => j.id !== id)));
  }
  // Applies a field edit. `live` edits (sliders, typing) checkpoint once and
  // only redraw the canvas; the final change commits and re-renders.
  function applyField(target, value, final) {
    const [kind, partId, entryId, key] = target.split("|");
    const l = leather();
    const apply = () => {
      if (kind === "part") {
        const part = l.parts.find((p) => p.id === partId);
        if (!part) return;
        if (key === "material" && !(value in MATERIALS)) return;
        if (key === "thickness" || key === "quantity") value = Number(value);
        if (key === "side") value = value === "back" ? "back" : "front";
        if (key === "outlineOperation" && !(value in OPERATIONS)) return;
        const next = makePart(part.id, part.itemId, { ...part, [key]: value });
        Object.assign(part, next);
      } else if (kind === "kerf") l.kerf = Math.min(LIMITS.kerf[1], Math.max(0, Number(value) || 0));
      else if (kind === "history") applyHistoryField(partId, entryId, key, value);
      else if (kind === "joint") {
        const j = l.joints.find((x) => x.id === partId);
        if (!j) return;
        if (key === "reverse") j.reverse = Boolean(value);
        if (key === "master") j.master = value === "b" ? "b" : "a";
        if (key === "name") j.name = String(value).slice(0, 100);
      } else {
        const part = l.parts.find((p) => p.id === partId);
        const line = part?.stitchLines.find((s) => s.id === entryId);
        const fold = part?.foldLines.find((s) => s.id === entryId);
        const hw = part?.hardware.find((s) => s.id === entryId);
        if (line) {
          queueMicrotask(() => rememberStitch(line));
          if (key === "name") line.name = String(value).slice(0, 100);
          else if (key === "offset") line.offset = Math.min(LIMITS.offset[1], Math.max(0, Number(value) || 0));
          else if (key === "shape") {
            const base = HOLE_SHAPES[value];
            if (base) Object.assign(line.pattern, makeStitchLine(line.id, { ...line, pattern: { ...line.pattern, shape: value, width: base.width, length: base.length, angle: base.angle } }).pattern);
          } else {
            const v = ["spacing", "fit", "corner"].includes(key) ? value : ["reverse", "flip"].includes(key) ? Boolean(value) : Number(value);
            Object.assign(line, makeStitchLine(line.id, { ...line, pattern: { ...line.pattern, [key]: v } }));
          }
        } else if (fold) {
          const v = key === "offset" ? Number(value) : value;
          Object.assign(fold, makeFoldLine(fold.id, { ...fold, [key]: v }));
        } else if (hw) {
          if (key === "presetId" && !presetById(value, l.hardwarePresets)) return;
          Object.assign(hw, makeHardware(hw.id, { ...hw, [key]: ["x", "y", "rotation"].includes(key) ? Number(value) : value }));
        }
      }
    };
    if (final) {
      if (!live) ctx.checkpoint();
      live = false;
      apply();
      ctx.commit();
    } else {
      if (!live) {
        ctx.checkpoint();
        live = true;
      }
      apply();
      ctx.renderCanvas();
      refreshStats();
    }
  }
  // ---- edge picking for the edge tools
  function edgeAt(p, itemId) {
    const item = project().items.find((i) => i.id === itemId);
    if (!item || !partOf(itemId)) return null;
    const path = outlinePath(item);
    const local = transform(p, item, true);
    const hit = nearestSegment(path, local);
    return Number.isFinite(hit.distance) ? { itemId, ...hit, path } : null;
  }
  // Nearest part edge within `radius` mm of p, over all part items.
  function pickEdge(p, radius) {
    let best = null;
    for (const part of leather().parts) {
      const e = edgeAt(p, part.itemId);
      if (e && e.distance <= radius && (!best || e.distance < best.distance)) best = { ...e, partId: part.id };
    }
    return best;
  }
  function edgeOutline(e) {
    const item = project().items.find((i) => i.id === e.itemId);
    const sp = e.path[e.s];
    const a = structuredClone(sp.nodes[e.i]),
      b = structuredClone(sp.nodes[(e.i + 1) % sp.nodes.length]);
    delete a.in;
    delete b.out;
    return (pathContours([{ closed: false, nodes: [a, b] }])[0] ?? []).map((q) => transform(q, item));
  }
  function addEdgeLine(e, kind) {
    const part = partById(e.partId);
    const sp = e.path[e.s],
      n = sp.nodes.length,
      from = e.i,
      to = (e.i + 1) % n;
    mutate(() => {
      // Extend the line being built when the clicked edge touches its end or start.
      const list = kind === "fold" ? part.foldLines : part.stitchLines;
      const cur = continuing && continuing.partId === part.id && continuing.kind === kind ? list.find((s) => s.id === continuing.lineId) : null;
      if (cur && cur.source.subpath === e.s && cur.source.from !== null) {
        if (cur.source.to === from && to !== cur.source.from) {
          cur.source.to = to;
          return "extended";
        }
        if (cur.source.from === to && from !== cur.source.to) {
          cur.source.from = from;
          return "extended";
        }
        if ((cur.source.to === from && to === cur.source.from) || (cur.source.from === to && from === cur.source.to)) {
          cur.source.from = cur.source.to = from;
          return "closed";
        }
      }
      const id = uid();
      const nth = list.length + 1;
      if (kind === "fold") part.foldLines.push(makeFoldLine(id, { name: `折り線 ${nth}`, source: { subpath: e.s, from, to }, offset: 0 }));
      else {
        const line = makeStitchLine(id, { name: `縫い線 ${nth}`, source: { subpath: e.s, from, to }, ...templateLine([part]) });
        part.stitchLines.push(line);
        rememberStitch(line);
        lastProjection = projectLineDown(part, line);
      }
      continuing = { partId: part.id, lineId: id, kind };
      return "new";
    }, (r) => (r === "extended" ? "隣の辺をつなげました。" : r === "closed" ? "一周つながりました。" : kind === "fold" ? "折り線を追加しました。続けて隣の辺をクリックすると延長できます。" : `縫い線を追加しました。続けて隣の辺をクリックすると1本につながります。${projectNotice(lastProjection)}`));
  }
  function addHardwareAt(p) {
    const items = project().items.filter((i) => partOf(i.id) && worldContours(i).some((ring) => isClosed(ring) && insidePolygon(p, ring)));
    const item = items.at(-1);
    if (!item) return ctx.notify("革パーツの上をクリックしてください。");
    const local = transform(p, item, true);
    mutate(() => {
      const part = partOf(item.id);
      part.hardware.push(makeHardware(uid(), { presetId: lastPreset, x: Number(local.x.toFixed(2)), y: Number(local.y.toFixed(2)) }));
    }, "金具を配置しました。右側で種類・位置を変更できます。");
  }
  function insidePolygon(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  let lastPreset = "snap-spring-m";
  // ---- mirror: a mirrored copy of a part keeps every stitch line, fold line
  // and hardware (in item-local coordinates they are the same; the item's
  // geometry is mirrored), with hole slants flipped so the holes of the two
  // pieces are mirror images. The copy is independent afterwards — edit one
  // side only — and a joint keeps the hole counts equal.
  function mirrorPartsFor(oldItems, newItems, axis) {
    const l = leather();
    let made = 0;
    oldItems.forEach((item, k) => {
      const src = partOf(item.id),
        copyItem = newItems[k];
      if (!src || !copyItem || partOf(copyItem.id)) return;
      const { copy, joints } = createMirrorPart(src, item, copyItem, axis, uid);
      l.parts.push(copy);
      l.joints.push(...joints);
      made++;
    });
    return made;
  }
  // Re-mirrors linked copies whose source changed (called on every render).
  function syncMirrors() {
    return syncMirrorParts(project(), uid);
  }
  // Mirror copy of the selected parts about a vertical axis just right of them.
  function mirrorSelection() {
    mutate(() => {
      const items = ctx.selectedItems().filter((i) => partOf(i.id));
      if (!items.length) throw Error("革パーツを選択してください。");
      const box = bounds(items.flatMap((i) => worldContours(i)));
      const gap = 10;
      const [a, b] = axisThrough({ x: box.x + box.w + gap / 2, y: box.y + box.h / 2 }, "vertical");
      const copies = mirrorItems(items, a, b, uid);
      project().items.push(...copies);
      const made = mirrorPartsFor(items, copies, { a, b });
      ctx.selectIds(copies.map((i) => i.id));
      return made;
    }, (n) => `ミラーコピーを作成しました（${n} パーツ）。元を編集するとコピーに反映されます。コピー側の編集は元に影響しません。`);
  }
  let lastProjection = [];
  // Settings of the stitch line edited or created most recently: new lines
  // start from them (and, in a multi-selection, from a line already there).
  let lastStitch = null; // { offset, pattern }
  const rememberStitch = (line) => {
    if (line && line.source.kind !== "projected") lastStitch = { offset: line.offset, pattern: { ...line.pattern } };
  };
  const templateLine = (fromParts = []) => {
    const own = fromParts.flatMap((p) => p.stitchLines).filter((l) => l.source.kind !== "projected");
    const src = own.at(-1) ?? lastStitch;
    return src ? { offset: src.offset, pattern: { ...src.pattern } } : { offset: DEFAULT_OFFSET };
  };
  let hwDrag = null; // { partId, hwId, item, start, origin, moved }
  // Snap a hardware position (item-local mm) to the part's centre lines,
  // other hardware on the part, and the 1 mm grid.
  function snapHardware(part, item, hw, local, mmPerPx) {
    const tol = mmPerPx * 8;
    const box = bounds(worldContours(item).map((ring) => ring.map((q) => transform(q, item, true))));
    const xs = [box.x + box.w / 2], ys = [box.y + box.h / 2];
    for (const other of part.hardware) if (other.id !== hw.id) { xs.push(other.x); ys.push(other.y); }
    const guides = [];
    const pick = (v, cands) => {
      let best = null;
      for (const c of cands) if (Math.abs(c - v) <= tol && (!best || Math.abs(c - v) < Math.abs(best - v))) best = c;
      return best;
    };
    let x = pick(local.x, xs), y = pick(local.y, ys);
    if (x !== null) guides.push({ axis: "x", value: x }); else x = Math.round(local.x);
    if (y !== null) guides.push({ axis: "y", value: y }); else y = Math.round(local.y);
    return { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), guides };
  }
  function hardwarePointerDown(e, p) {
    const t = e.target.closest?.("[data-hardware]");
    if (!t || ctx.tool() !== "select") return false;
    const [partId, hwId] = t.dataset.hardware.split("|");
    const part = partById(partId), hw = part?.hardware.find((h) => h.id === hwId);
    const item = project().items.find((i) => i.id === part?.itemId);
    if (!hw || !item) return false;
    ctx.selectIds([item.id]);
    hwDrag = { partId, hwId, item, start: transform(p, item, true), origin: { x: hw.x, y: hw.y }, moved: false, guides: [] };
    $("#canvas").setPointerCapture?.(e.pointerId);
    return true;
  }
  function hardwarePointerMove(p, mmPerPx) {
    if (!hwDrag) return false;
    const part = partById(hwDrag.partId), hw = part?.hardware.find((h) => h.id === hwDrag.hwId);
    if (!hw) { hwDrag = null; return false; }
    if (!hwDrag.moved) { ctx.checkpoint(); hwDrag.moved = true; }
    const local = transform(p, hwDrag.item, true);
    const raw = { x: hwDrag.origin.x + local.x - hwDrag.start.x, y: hwDrag.origin.y + local.y - hwDrag.start.y };
    const snapped = snapHardware(part, hwDrag.item, hw, raw, mmPerPx);
    hw.x = snapped.x; hw.y = snapped.y;
    hwDrag.guides = snapped.guides;
    return true;
  }
  function pointerUp() {
    if (eraseDrag) {
      const d = eraseDrag;
      eraseDrag = null;
      if (d.moved) eraseInRect(d.start, d.current);
      else eraseAt(d.start, d.mmPerPx, d.extend);
      ctx.renderCanvas();
      return true;
    }
    return hardwarePointerUp();
  }
  function hardwarePointerUp() {
    if (!hwDrag) return false;
    const moved = hwDrag.moved;
    hwDrag = null;
    if (moved) ctx.commit();
    return true;
  }
  const dragging = () => Boolean(hwDrag || eraseDrag);
  // ---- parametric history (timeline). A part's outline can be rebuilt from
  // its base sketch plus features; see leather/history.js.
  function ensureHistory(part, item) {
    if (!part.history) part.history = { base: baseFromItem(item, outlinePath(item)), features: [], outputKey: "" };
    return part.history;
  }
  const historyStale = (part, item) => Boolean(part.history) && isStale(item, part.history, outlinePath(item));
  // Rebuilds the part's item from its history in place; returns the errors.
  function rebuildFromHistory(part) {
    const p = project();
    const k = p.items.findIndex((i) => i.id === part.itemId);
    if (k < 0) return [];
    const { item, errors } = applyHistory(p.items[k], part.history);
    p.items[k] = item;
    return errors;
  }
  // Fillet/chamfer from the CAD tool on a part: recorded as a feature and
  // replayed, instead of baking the result into the path. Returns the new
  // item, or null when the part should fall back to the plain operation.
  function recordCorner(item, point, kind, amount) {
    const part = partOf(item.id);
    if (!part || item.warp) return null;
    if (part.history && historyStale(part, item)) {
      ctx.notify("外形が履歴の外で編集されているため、この操作は履歴に記録せず直接適用しました。履歴パネルで「再適用」か「履歴を破棄」を選べます。");
      return null;
    }
    const history = ensureHistory(part, item);
    const path = outlinePath(item);
    const near = nearestNode(path, item, point);
    if (!near) return null;
    const feature = normalizeFeature({ id: uid(), kind, node: near.i, subpath: near.s, radius: amount, distance: amount });
    const trial = applyHistory(item, { ...history, features: [...history.features, feature] });
    const failed = trial.errors.find((e) => e.featureId === feature.id);
    if (failed) throw Error(failed.message);
    history.features.push(feature);
    history.outputKey = "";
    const { item: next } = applyHistory(item, history);
    return next;
  }
  function historyPanel(part, item) {
    const h = part.history;
    if (!h) return `<h4>操作履歴 <span>タイムライン</span></h4><p class="note">フィレット・面取り・穴をこのパーツに適用すると、ここに履歴として残り、あとから寸法を変更できます。</p><div class="leather-add"><button data-leather-action="history-start" data-part="${part.id}">◷ 履歴を開始（現在の形を基本形状に）</button></div>`;
    const stale = historyStale(part, item);
    const f = (featureId, key) => `history|${part.id}|${featureId}|${key}`;
    const base = h.base.kind === "rect"
      ? `<div class="fields">${numField(f("base", "w"), "幅", h.base.w, 0.5, [0.1, 2000])}${numField(f("base", "h"), "高さ", h.base.h, 0.5, [0.1, 2000])}${numField(f("base", "radius"), "角 R", h.base.radius, 0.5, [0, 1000])}</div>`
      : h.base.kind === "circle"
        ? `<div class="fields">${numField(f("base", "w"), "幅", h.base.w, 0.5, [0.1, 2000])}${numField(f("base", "h"), "高さ", h.base.h, 0.5, [0.1, 2000])}</div>`
        : `<p class="note">基本形状は固定パスです（パス編集で変えた形が基準になります）。</p>`;
    const rows = h.features
      .map((ft, k) => {
        const fields =
          ft.kind === "fillet" ? numField(f(ft.id, "radius"), "半径 R", ft.radius, 0.5, [0.01, 500])
          : ft.kind === "chamfer" ? numField(f(ft.id, "distance"), "距離", ft.distance, 0.5, [0.01, 500])
          : ft.kind === "hole" ? numField(f(ft.id, "d"), "直径", ft.d, 0.5, [0.2, 500]) + numField(f(ft.id, "x"), "X", ft.x, 0.5, [-10000, 10000]) + numField(f(ft.id, "y"), "Y", ft.y, 0.5, [-10000, 10000])
          : numField(f(ft.id, "w"), "幅", ft.w, 0.5, [0.2, 500]) + numField(f(ft.id, "h"), "長さ", ft.h, 0.5, [0.2, 500]) + numField(f(ft.id, "x"), "X", ft.x, 0.5, [-10000, 10000]) + numField(f(ft.id, "y"), "Y", ft.y, 0.5, [-10000, 10000]) + numField(f(ft.id, "rotation"), "回転", ft.rotation, 5, [-360, 360], "°");
        const err = lastHistoryErrors.get(ft.id);
        return `<details class="leather-line history-step ${err ? "has-error" : ""}"><summary><span>${k + 1}. ${esc(FEATURE_LABELS[ft.kind])}</span><small>${esc(describeFeature(ft))}</small></summary>${err ? `<p class="leather-error">この操作は現在の寸法では適用できず、飛ばしています: ${esc(err)}</p>` : ""}<div class="fields">${fields}</div>${["fillet", "chamfer"].includes(ft.kind) ? `<p class="note">ノード ${ft.node} は、この操作の時点でのパスの頂点番号です。</p>` : ""}<button class="text-link danger" data-leather-action="history-remove" data-part="${part.id}" data-feature="${ft.id}">この操作を削除</button></details>`;
      })
      .join("");
    return `<h4>操作履歴 <span>タイムライン · ${h.features.length} 操作</span></h4>
${stale ? `<p class="note mirror-note">⚠ 外形が履歴の外（拡縮ハンドル・パス編集・ブール演算など）で変更されています。<button class="text-link" data-leather-action="history-reapply" data-part="${part.id}">履歴を再適用（変更を捨てる）</button> / <button class="text-link" data-leather-action="history-rebase" data-part="${part.id}">今の形を新しい基本形状にする</button></p>` : ""}
<details class="leather-line history-step" open><summary><span>0. 基本形状</span><small>${esc(describeBase(h.base))}</small></summary>${base}</details>
${rows}
<div class="leather-add"><button data-leather-action="history-hole" data-part="${part.id}">＋ 丸穴</button><button data-leather-action="history-slot" data-part="${part.id}">＋ 長穴</button><button data-tool="fillet" title="CAD のフィレットツール。角をクリックすると履歴に追加">◜ フィレット</button><button data-tool="chamfer" title="CAD の面取りツール。角をクリックすると履歴に追加">◺ 面取り</button><button class="text-link danger" data-leather-action="history-drop" data-part="${part.id}">履歴を破棄（形は残す）</button></div>
<p class="note">どの段階の寸法も変更でき、外形・縫い穴・金具が追従します。操作を削除すると、それ以降の角の番号がずれることがあります。</p>`;
  }
  const lastHistoryErrors = new Map();
  function historyAction(action, partId, featureId) {
    const part = partById(partId);
    const item = project().items.find((i) => i.id === part?.itemId);
    if (!part || !item) return;
    mutate(() => {
      if (action === "history-start") ensureHistory(part, item);
      else if (action === "history-drop") delete part.history;
      else if (action === "history-rebase") {
        part.history = { base: baseFromItem(item, outlinePath(item)), features: [], outputKey: "" };
        rebuildFromHistory(part);
      } else if (action === "history-reapply") rebuildFromHistory(part);
      else if (action === "history-remove") {
        part.history.features = part.history.features.filter((x) => x.id !== featureId);
        rebuildFromHistory(part);
      } else if (action === "history-hole" || action === "history-slot") {
        const h = ensureHistory(part, item);
        const box = bounds(worldContours(item).map((ring) => ring.map((q) => transform(q, item, true))));
        const c = { x: Number((box.x + box.w / 2).toFixed(2)), y: Number((box.y + box.h / 2).toFixed(2)) };
        h.features.push(normalizeFeature(action === "history-hole" ? { id: uid(), kind: "hole", ...c, d: 4 } : { id: uid(), kind: "slot", ...c, w: 3, h: 12, rotation: 0 }));
        rebuildFromHistory(part);
      }
      return part;
    }, action === "history-start" ? "履歴を開始しました。これ以降のフィレット・面取り・穴が記録されます。" : action === "history-drop" ? "履歴を破棄しました。形はそのまま残ります。" : null);
  }
  function applyHistoryField(partId, featureId, key, value) {
    const part = partById(partId);
    if (!part?.history) return;
    if (featureId === "base") {
      if (!(key in part.history.base)) return;
      part.history.base[key] = Number(value);
    } else {
      const ft = part.history.features.find((x) => x.id === featureId);
      if (!ft || !(key in ft)) return;
      ft[key] = Number(value);
    }
    const errors = rebuildFromHistory(part);
    lastHistoryErrors.clear();
    for (const e of errors) lastHistoryErrors.set(e.featureId, e.message);
  }
  // ---- seam tool: two edge clicks on two parts → matching stitch lines + joint.
  let seamFirst = null; // { partId, e }
  function seamClick(p, mmPerPx) {
    const edge = pickEdge(p, mmPerPx * 12);
    if (!edge) return ctx.notify(seamFirst ? "相手の革パーツの辺をクリックしてください。" : "縫い合わせる1つ目の辺（革パーツの縁）をクリックしてください。");
    if (!seamFirst) {
      seamFirst = { partId: edge.partId, e: edge };
      ctx.selectIds([edge.itemId]);
      ctx.renderCanvas();
      return ctx.notify("1つ目の辺を選びました。次に相手のパーツの縫い合わせる辺をクリックしてください。");
    }
    if (edge.partId === seamFirst.partId) {
      seamFirst = { partId: edge.partId, e: edge };
      ctx.renderCanvas();
      return ctx.notify("同じパーツの辺です。相手のパーツの辺をクリックしてください（1つ目を選び直しました）。");
    }
    const first = seamFirst;
    seamFirst = null;
    mutate(() => {
      const A = partById(first.partId), B = partById(edge.partId);
      const seed = templateLine([A, B]);
      // Reuse a line that already covers exactly this edge, else create one.
      const lineFor = (part, e, label) => {
        const n = e.path[e.s].nodes.length, from = e.i, to = (e.i + 1) % n;
        let line = part.stitchLines.find((l) => l.source.kind !== "projected" && l.source.subpath === e.s && l.source.from === from && l.source.to === to);
        if (!line) {
          line = makeStitchLine(uid(), { name: `縫い合わせ ${label}`, source: { subpath: e.s, from, to }, ...seed });
          part.stitchLines.push(line);
        }
        return line;
      };
      const la = lineFor(A, first.e, A.name), lb = lineFor(B, edge, B.name);
      rememberStitch(la);
      // Direction: pair start with start unless the pieces are laid out so
      // that the start of one faces the end of the other.
      const pa = derivePart(project(), A).stitch.find((s) => s.line.id === la.id), pb = derivePart(project(), B).stitch.find((s) => s.line.id === lb.id);
      let reverse = false;
      if (pa?.points?.length && pb?.points?.length) {
        const d = (u, v) => Math.hypot(u.x - v.x, u.y - v.y);
        reverse = d(pa.points[0], pb.points.at(-1)) + d(pa.points.at(-1), pb.points[0]) < d(pa.points[0], pb.points[0]) + d(pa.points.at(-1), pb.points.at(-1));
      }
      const l = leather();
      l.joints = l.joints.filter((j) => !((j.a.lineId === la.id && j.b.lineId === lb.id) || (j.a.lineId === lb.id && j.b.lineId === la.id)));
      l.joints.push(makeJoint(uid(), { name: `${A.name} × ${B.name}`, a: { partId: A.id, lineId: la.id }, b: { partId: B.id, lineId: lb.id }, reverse, master: "a" }));
      ctx.selectIds([B.itemId]);
      return { A, B, reverse, seed };
    }, ({ A, B, reverse, seed }) => `「${A.name}」と「${B.name}」の辺を縫い合わせました（縁から ${seed.offset} mm${reverse ? "・逆向きに対応" : ""}）。穴数を合わせ、長さの差と位置ずれは右パネルの「縫合」に表示します。`);
  }
  // ---- hole eraser: tap a hole to leave it out, tap its ghost to bring it back.
  let holeHover = null; // { x, y, kind: "hole" | "ghost" }
  let eraseDrag = null; // { start, current, moved }
  let lastErased = null; // { partId, lineId, u }
  function holeTargets() {
    const out = [];
    for (const dp of derived().parts) {
      if (!dp.item) continue;
      for (const st of dp.stitch) {
        if (st.error || !st.result) continue;
        for (const h of st.holes) out.push({ kind: "hole", x: h.x, y: h.y, part: dp.part, st, u: st.result.length ? h.s / st.result.length : 0 });
        const c = st.points?.length > 1 ? makeCurve(st.points, st.closed) : null;
        for (const k of st.line.skipped ?? []) {
          const p = c ? curvePointAt(c, k.u * c.length) : null;
          if (p) out.push({ kind: "ghost", x: p.x, y: p.y, part: dp.part, st, skip: k });
        }
      }
    }
    return out;
  }
  function nearestHole(p, radius) {
    let best = null;
    for (const t of holeTargets()) {
      const d = Math.hypot(t.x - p.x, t.y - p.y);
      if (d <= radius && (!best || d < best.d)) best = { ...t, d };
    }
    return best;
  }
  function eraseAt(p, mmPerPx, extend = false) {
    const t = nearestHole(p, Math.max(mmPerPx * 14, 1.5));
    if (!t) return ctx.notify("縫い穴の上をタップしてください。ドラッグで囲むとまとめて消せます。");
    if (t.part.mirrorOf) return ctx.notify("ミラーコピーの穴は、元のパーツ側で消してください（鏡像の穴が一緒に消えます）。コピーだけで消したい場合は、パネルで「リンクを解除」してから行います。");
    // Shift / multi-select: erase the run from the last erased hole to this one.
    if (extend && t.kind === "hole" && lastErased && lastErased.lineId === t.st.line.id && lastErased.partId === t.part.id) {
      const L = t.st.result.length, closed = t.st.closed;
      const u0 = lastErased.u, u1 = t.u;
      let lo = Math.min(u0, u1), hi = Math.max(u0, u1), wrap = false;
      if (closed && hi - lo > 0.5) { wrap = true; [lo, hi] = [hi, lo]; } // the shorter way round
      const inRun = (u) => (wrap ? u >= lo - 1e-9 || u <= hi + 1e-9 : u >= lo - 1e-9 && u <= hi + 1e-9);
      const us = t.st.holes.map((h) => h.s / L).filter(inRun);
      return mutate(() => {
        const line = partById(t.part.id)?.stitchLines.find((l) => l.id === t.st.line.id);
        if (!line) return 0;
        const have = new Set((line.skipped ?? []).map((k) => k.u.toFixed(6)));
        const add = us.filter((u) => !have.has(u.toFixed(6))).map((u) => ({ u: Number(u.toFixed(6)) }));
        line.skipped = [...(line.skipped ?? []), ...add];
        lastErased = { partId: t.part.id, lineId: t.st.line.id, u: t.u };
        return add.length;
      }, (n) => `区間の穴を ${n} 個消しました。`);
    }
    mutate(() => {
      // derived() hands out clones; edit the real part.
      const line = partById(t.part.id)?.stitchLines.find((l) => l.id === t.st.line.id);
      if (!line) return;
      if (t.kind === "hole") {
        line.skipped = [...(line.skipped ?? []), { u: Number(t.u.toFixed(6)) }];
        lastErased = { partId: t.part.id, lineId: t.st.line.id, u: t.u };
      } else line.skipped = (line.skipped ?? []).filter((k) => k !== t.skip && Math.abs(k.u - t.skip.u) > 1e-9);
      if (line.skipped && !line.skipped.length) delete line.skipped;
      ctx.selectIds([t.part.itemId]);
      return t.kind;
    }, (k) => (k === "hole" ? "穴を1つ消しました。Shift＋タップで区間、ドラッグで囲んでまとめて消せます。薄い印をタップすると戻せます。" : "穴を戻しました。"));
  }
  // Marquee: every hole inside the rectangle is erased (ghosts inside are restored).
  function eraseInRect(a, b) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const all = holeTargets().filter((t) => t.x >= x0 && t.x <= x1 && t.y >= y0 && t.y <= y1);
    const hits = all.filter((t) => !t.part.mirrorOf);
    if (!hits.length) return ctx.notify(all.length ? "ミラーコピーの穴は元のパーツ側で消してください（鏡像が一緒に消えます）。" : "囲んだ範囲に縫い穴がありません。");
    mutate(() => {
      let erased = 0, restored = 0;
      for (const t of hits) {
        const line = partById(t.part.id)?.stitchLines.find((l) => l.id === t.st.line.id);
        if (!line) continue;
        if (t.kind === "hole") {
          line.skipped = [...(line.skipped ?? []), { u: Number(t.u.toFixed(6)) }];
          erased++;
        } else {
          line.skipped = (line.skipped ?? []).filter((k) => Math.abs(k.u - t.skip.u) > 1e-9);
          if (!line.skipped.length) delete line.skipped;
          restored++;
        }
      }
      return { erased, restored };
    }, ({ erased, restored }) => `${erased ? `穴を ${erased} 個消しました。` : ""}${restored ? `消していた穴を ${restored} 個戻しました。` : ""}`);
  }
  function restoreAll(partId, lineId) {
    mutate(() => {
      const line = partById(partId)?.stitchLines.find((l) => l.id === lineId);
      if (line) delete line.skipped;
    }, "消した穴をすべて戻しました。");
  }
  // ---- joints
  function createJoint(aPart, aLine, bPart, bLine, reverse) {
    mutate((l) => {
      if (!aLine || !bLine || aLine === bLine) throw Error("縫合する2本の縫い線を選んでください。");
      l.joints.push(makeJoint(uid(), { name: `${partById(aPart)?.name ?? "?"} × ${partById(bPart)?.name ?? "?"}`, a: { partId: aPart, lineId: aLine }, b: { partId: bPart, lineId: bLine }, reverse }));
    }, "縫合を作成しました。穴数が違う場合は相手側を同じ穴数に合わせます。");
  }
  // ---- templates
  function placeTemplate(id) {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    mutate((l) => {
      const p = project();
      const layerId = ctx.activeLayer();
      const built = t.build(uid, layerId, { x: 20, y: 20 });
      // Keep the pieces inside the board: shift right of what is already there.
      const used = p.items.length ? Math.max(0, ...p.items.flatMap((i) => worldContours(i).flat().map((q) => q.x))) : 0;
      const dx = used ? used + 15 - 20 : 0;
      for (const item of built.items) item.x += dx;
      p.items.push(...built.items);
      l.parts.push(...built.parts);
      l.joints.push(...built.joints);
      ctx.selectIds(built.items.map((i) => i.id));
    }, `${t.label}を配置しました。各パーツを選ぶと縫い穴の設定を変更できます。`);
  }

  // ---- rendering helpers
  const sel = (name, options, value, extra = "") => `<select data-leather-field="${name}" ${extra}>${Object.entries(options).map(([k, v]) => `<option value="${k}" ${k === value ? "selected" : ""}>${esc(typeof v === "string" ? v : v.label)}</option>`).join("")}</select>`;
  const numField = (name, label, value, step, [min, max], unit = "mm") => `<label>${label} <span>${unit}</span><input data-leather-field="${name}" type="number" value="${Number(Number(value).toFixed(3))}" step="${step}" min="${min}" max="${max}"></label>`;
  const check = (name, label, on) => `<label class="check"><input data-leather-field="${name}" type="checkbox" ${on ? "checked" : ""}> ${label}</label>`;
  function sourceLabel(src) {
    return src.from === null ? "全周" : src.from === src.to ? `全周（ノード ${src.from} から）` : `ノード ${src.from} → ${src.to}`;
  }
  function statsHTML(st) {
    if (!st || st.error) return `<p class="leather-error">${esc(st?.error ?? "計算できません")}</p>`;
    const r = st.result;
    const dev = r.pitch.target ? Math.abs(r.pitch.mean - r.pitch.target) / r.pitch.target : 0;
    return `<dl class="measure leather-stats"><dt>穴数</dt><dd><b>${st.holes.length}</b>${st.skippedHoles?.length ? ` （消した穴 ${st.skippedHoles.length}）` : ""}${st.joined ? " · 縫合で穴数を合わせています" : ""}</dd><dt>実ピッチ（弦長）</dt><dd class="${dev > st.line.pattern.maxDeviation ? "warn" : ""}">${num(r.pitch.mean)} mm（${num(r.pitch.min)}〜${num(r.pitch.max)}）· ${num(spiOf(r.pitch.mean || st.line.pattern.pitch), 1)} SPI</dd><dt>縫い線の長さ</dt><dd>${num(r.length, 1)} mm${r.closed ? "（閉）" : ""} · 区間 ${r.spans.length} · 角 ${r.corners ?? 0}</dd></dl>${r.warnings.length ? `<ul class="leather-warnings">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}`;
  }
  function stitchBlock(part, line, st) {
    const f = (key) => `stitch|${part.id}|${line.id}|${key}`;
    if (line.source.kind === "projected") {
      const src = partById(line.source.partId);
      return `<details class="leather-line projected" open><summary><span>${esc(line.name)}</span><small>投影 · ${st?.holes.length ?? 0} 穴</small></summary><p class="note">⤓ 上のパーツ「${esc(src?.name ?? "?")}」の縫い線の穴を、重ねたときの位置でこのパーツに写しています。ピッチ・穴の形は元の縫い線で変更します。上のパーツを動かしても、この穴の位置は変わりません。</p>${st?.error ? `<p class="leather-error">${esc(st.error)}</p>` : ""}${st?.dropped ? `<p class="note warn">このパーツの外にある ${st.dropped} 個の穴は省いています。</p>` : ""}${line.skipped?.length ? `<p class="note warn">消した穴 ${line.skipped.length} 個 <button class="text-link" data-leather-action="restore-holes" data-part="${part.id}" data-entry="${line.id}">すべて戻す</button></p>` : ""}<div class="leather-add"><button data-leather-action="recapture" data-part="${part.id}" data-entry="${line.id}">今の重なり位置で取り直す</button><button data-tool="hole-erase" class="${ctx.tool() === "hole-erase" ? "active" : ""}">⊘ 穴を消す／戻す</button></div><button class="text-link danger" data-leather-action="remove-entry" data-part="${part.id}" data-entry="${line.id}">この投影を削除</button></details>`;
    }
    const p = line.pattern;
    return `<details class="leather-line" open><summary><span>${esc(line.name)}</span><small>${esc(sourceLabel(line.source))} · ${st?.holes.length ?? 0} 穴</small></summary>
<div class="fields"><label>名前<input data-leather-field="${f("name")}" type="text" value="${esc(line.name)}" maxlength="100"></label>${numField(f("offset"), "縁からの距離", line.offset, 0.5, LIMITS.offset)}</div>
<h5>ピッチ</h5><div class="pitch-presets">${PITCH_PRESETS.map((v) => `<button data-leather-pitch="${part.id}|${line.id}|${v}" class="${Math.abs(p.pitch - v) < 1e-9 ? "active" : ""}" title="${num(spiOf(v), 1)} SPI">${v}</button>`).join("")}</div>
<div class="fields">${numField(f("pitch"), "ピッチ", p.pitch, 0.05, PATTERN_LIMITS.pitch)}<label>間隔の基準${sel(f("spacing"), SPACINGS, p.spacing)}</label></div>
<div class="fields"><label>配置${sel(f("fit"), FITS, p.fit)}</label>${p.fit === "count" ? numField(f("count"), "穴数", p.count, 1, PATTERN_LIMITS.count, "") : numField(f("maxDeviation"), "許容ずれ", p.maxDeviation * 100, 1, [0, 50], "%")}</div>
<h5>穴の形</h5><div class="fields"><label>形状${sel(f("shape"), HOLE_SHAPES, p.shape)}</label>${numField(f("angle"), "角度", p.angle, 1, PATTERN_LIMITS.angle, "°")}${numField(f("width"), "幅", p.width, 0.1, PATTERN_LIMITS.width)}${numField(f("length"), "長さ", p.length, 0.1, PATTERN_LIMITS.length)}</div>
<h5>角と端</h5><div class="fields"><label>角の処理${sel(f("corner"), CORNER_MODES, p.corner)}</label>${numField(f("cornerAngle"), "角とみなす角度", p.cornerAngle, 5, PATTERN_LIMITS.cornerAngle, "°")}${line.source.from === null || line.source.from === line.source.to ? numField(f("startOffset"), "開始位置", p.startOffset, 0.5, [-1000, 1000]) : numField(f("startMargin"), "始端の余白", p.startMargin, 0.5, PATTERN_LIMITS.startMargin) + numField(f("endMargin"), "終端の余白", p.endMargin, 0.5, PATTERN_LIMITS.endMargin)}</div>
<div class="leather-checks">${check(f("reverse"), "逆目打ち（進行方向を反転）", p.reverse)}${check(f("flip"), "ミラー（裏から加工・穴の傾きを反転）", p.flip)}</div>
<div data-leather-stats="${line.id}">${statsHTML(st)}</div>
${line.skipped?.length ? `<p class="note warn">消した穴 ${line.skipped.length} 個（「穴を消す」ツールで薄い印をタップすると個別に戻せます） <button class="text-link" data-leather-action="restore-holes" data-part="${part.id}" data-entry="${line.id}">すべて戻す</button></p>` : ""}
<div class="leather-add"><button data-tool="hole-erase" class="${ctx.tool() === "hole-erase" ? "active" : ""}">⊘ 穴を1つずつ消す／戻す</button></div>
<button class="text-link danger" data-leather-action="remove-entry" data-part="${part.id}" data-entry="${line.id}">この縫い線を削除</button></details>`;
  }
  function foldBlock(part, fold, df) {
    const f = (key) => `fold|${part.id}|${fold.id}|${key}`;
    return `<details class="leather-line"><summary><span>${esc(fold.name)}</span><small>${esc(sourceLabel(fold.source))} · ${fold.kind === "valley" ? "谷折り" : "山折り"}${df ? ` · ${num(df.length, 1)} mm` : ""}</small></summary><div class="fields"><label>名前<input data-leather-field="${f("name")}" type="text" value="${esc(fold.name)}" maxlength="100"></label>${numField(f("offset"), "辺からの距離", fold.offset, 0.5, LIMITS.offset)}<label>折り方${sel(f("kind"), { mountain: "山折り", valley: "谷折り" }, fold.kind)}</label></div><p class="note">折り線は SCORE レイヤーに出力します。辺からの距離は折り位置の寸法です。</p><button class="text-link danger" data-leather-action="remove-entry" data-part="${part.id}" data-entry="${fold.id}">この折り線を削除</button></details>`;
  }
  function hardwareBlock(part, hw) {
    const f = (key) => `hardware|${part.id}|${hw.id}|${key}`;
    const presets = Object.fromEntries([...leather().hardwarePresets, ...HARDWARE_PRESETS].map((p) => [p.id, `${HARDWARE_TYPES[p.type] ?? p.type}: ${p.label}`]));
    const preset = presetById(hw.presetId, leather().hardwarePresets);
    return `<details class="leather-line"><summary><span>${esc(preset?.label ?? hw.presetId)}</span><small>${num(hw.x, 1)}, ${num(hw.y, 1)} mm</small></summary><label class="full-label">種類${sel(f("presetId"), presets, hw.presetId)}</label><div class="fields">${numField(f("x"), "X（パーツ内）", hw.x, 0.5, [-LIMITS.coordinate, LIMITS.coordinate])}${numField(f("y"), "Y（パーツ内）", hw.y, 0.5, [-LIMITS.coordinate, LIMITS.coordinate])}${numField(f("rotation"), "回転", hw.rotation, 1, [-360, 360], "°")}</div><p class="note">穴径は目安です。金具の実物と革厚で確認してください。</p><button class="text-link danger" data-leather-action="remove-entry" data-part="${part.id}" data-entry="${hw.id}">この金具を削除</button></details>`;
  }
  function jointsBlock(part, d) {
    const l = leather();
    const mine = l.joints.filter((j) => j.a.partId === part.id || j.b.partId === part.id);
    const rows = mine
      .map((j) => {
        const dj = d.joints.find((x) => x.joint.id === j.id);
        const other = j.a.partId === part.id ? j.b : j.a;
        const otherPart = partById(other.partId);
        const status = !dj || dj.error ? `<span class="warn">${esc(dj?.error ?? "")}</span>` : `穴 ${dj.count} 組 · 長さ差 ${num(dj.lengthDiff, 1)} mm · 位置ずれ最大 ${num(dj.maxDeviation)} mm${dj.adjusted ? " · 相手の穴数を合わせました" : ""}`;
        return `<details class="leather-line"><summary><span>${esc(j.name)}</span><small>${esc(otherPart?.name ?? "?")}</small></summary><p class="note">${status}</p><div class="leather-checks">${check(`joint|${j.id}||reverse`, "相手の辺を逆向きに対応させる", j.reverse)}</div><label class="full-label">穴数の基準${sel(`joint|${j.id}||master`, { a: `${partById(j.a.partId)?.name ?? "A"} 側`, b: `${partById(j.b.partId)?.name ?? "B"} 側` }, j.master)}</label><button class="text-link danger" data-leather-action="remove-joint" data-joint="${j.id}">この縫合を削除</button></details>`;
      })
      .join("");
    const others = l.parts.filter((p) => p.id !== part.id && p.stitchLines.length);
    const form =
      part.stitchLines.length && others.length
        ? `<div class="leather-joint-form"><label class="full-label">このパーツの縫い線<select id="leather-joint-a">${part.stitchLines.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></label><label class="full-label">相手の縫い線<select id="leather-joint-b">${others.flatMap((p) => p.stitchLines.map((s) => `<option value="${p.id}|${s.id}">${esc(p.name)} / ${esc(s.name)}</option>`)).join("")}</select></label><label class="check"><input type="checkbox" id="leather-joint-reverse"> 逆向きに対応</label><button class="wide-button" data-leather-action="create-joint" data-part="${part.id}">⟗ 縫合を作成 <small>穴数・位置を一致させる</small></button></div>`
        : `<p class="note">縫合するには、相手のパーツにも縫い線が必要です。</p>`;
    return rows + `<div class="leather-add"><button data-tool="seam" class="${ctx.tool() === "seam" ? "active" : ""}">⟗ 辺を2つクリックして縫い合わせ</button></div>` + form;
  }
  // The properties section for a selected item that is a part.
  function partPanel(item) {
    const part = partOf(item.id);
    if (!part) return "";
    const d = derived();
    const dp = d.parts.find((x) => x.part.id === part.id);
    const mat = MATERIALS[part.material] ?? MATERIALS.unknown;
    const f = (key) => `part|${part.id}||${key}`;
    const issues = (dp?.issues ?? []).filter((i) => !i.lineId);
    return `<section class="leather-panel"><div class="object-type">LEATHER PART / 革パーツ</div><h3>${esc(part.name)}</h3>
<div class="fields"><label>パーツ名<input data-leather-field="${f("name")}" type="text" value="${esc(part.name)}" maxlength="100"></label>${numField(f("thickness"), "革厚", part.thickness, 0.1, LIMITS.thickness)}${numField(f("quantity"), "必要枚数", part.quantity, 1, LIMITS.quantity, "枚")}<label>表裏${sel(f("side"), { front: "表（銀面を上）", back: "裏（ミラーで加工）" }, part.side)}</label></div>
<label class="full-label">材料${sel(f("material"), Object.fromEntries(Object.entries(MATERIALS).map(([k, v]) => [k, v.label])), part.material)}</label><p class="note material-${mat.laser}">${LASER_LABELS[mat.laser]} · ${esc(mat.note)}</p>
<label class="full-label">外形の加工${sel(f("outlineOperation"), OPERATION_LABELS, part.outlineOperation)}</label>
${issues.length ? `<ul class="leather-warnings">${issues.map((i) => `<li class="${i.level}">${esc(i.message)}</li>`).join("")}</ul>` : ""}
${part.mirrorOf ? `<p class="note mirror-note">⇔ ミラー元「${esc(partById(part.mirrorOf.partId)?.name ?? "?")}」にリンク中。元の外形・縫い線・折り線・金具・革厚の変更がこのコピーに反映されます（コピー側で変えた設定は、元が変わると上書きされます）。<button class="text-link" data-leather-action="detach-mirror" data-part="${part.id}">リンクを解除して独立させる</button></p>` : ""}
${(() => { const copies = leather().parts.filter((p) => p.mirrorOf?.partId === part.id); return copies.length ? `<p class="note">⇔ このパーツのミラーコピー: ${copies.map((c) => esc(c.name)).join("、")}（このパーツの変更が反映されます）</p>` : ""; })()}
${historyPanel(part, item)}
<h4>縫い線 <span>${part.stitchLines.length}</span></h4>${part.stitchLines.map((line) => stitchBlock(part, line, dp?.stitch.find((s) => s.line.id === line.id))).join("")}
<div class="leather-add"><button data-leather-action="add-full-stitch">＋ 全周に縫い線</button><button data-tool="stitch-edge" class="${ctx.tool() === "stitch-edge" ? "active" : ""}">＋ 辺を選んで縫い線</button></div>
<h4>折り線 <span>${part.foldLines.length}</span></h4>${part.foldLines.map((fold) => foldBlock(part, fold, dp?.folds.find((x) => x.fold.id === fold.id))).join("")}
<div class="leather-add"><button data-tool="fold-edge" class="${ctx.tool() === "fold-edge" ? "active" : ""}">＋ 辺を選んで折り線</button></div>
<h4>金具 <span>${part.hardware.length}</span></h4>${part.hardware.map((hw) => hardwareBlock(part, hw)).join("")}
<div class="leather-add"><label class="full-label">追加する金具<select id="leather-hardware-preset">${[...leather().hardwarePresets, ...HARDWARE_PRESETS].map((p) => `<option value="${p.id}" ${p.id === lastPreset ? "selected" : ""}>${esc(HARDWARE_TYPES[p.type] ?? p.type)}: ${esc(p.label)}</option>`).join("")}</select></label><button data-leather-action="add-hardware-center" data-part="${part.id}">＋ 中央に配置</button><button data-tool="hardware" class="${ctx.tool() === "hardware" ? "active" : ""}">＋ クリックで配置</button></div>
<h4>縫合（パーツ間の穴合わせ） <span>${leather().joints.filter((j) => j.a.partId === part.id || j.b.partId === part.id).length}</span></h4>${jointsBlock(part, d)}
<h4>複製・合成</h4><div class="leather-add"><button data-leather-action="mirror">⇔ ミラーコピー <small>左右対称の相手パーツ</small></button><button data-leather-action="boolean-union" ${ctx.selectedItems().length > 1 ? "" : "disabled"}>∪ 合体</button><button data-leather-action="boolean-difference" ${ctx.selectedItems().length > 1 ? "" : "disabled"}>− 抜く</button></div><p class="note">ミラーコピーは縫い穴の傾きも反転した独立パーツで、縫合により穴数を合わせます。合体・抜くは Shift で 2 つ以上選んでから（最初の選択が土台）。</p>
<button class="text-link danger" data-leather-action="unmake-part" data-part="${part.id}">革パーツを解除（図形は残す）</button></section>`;
  }
  // Offer for a closed shape that is not a part yet.
  function offerPanel(item) {
    if (!canBePart(item) || partOf(item.id)) return "";
    return `<section class="leather-panel leather-offer"><div class="object-type">LEATHER / 革パーツ</div><button class="wide-button primary-dashed" data-leather-action="convert-stitch">✦ 縫い穴を作る <small>革パーツにして外周に縫い線</small></button><button class="wide-button" data-leather-action="convert">◈ 革パーツにする <small>革厚・材料・金具を設定</small></button></section>`;
  }
  function multiPanel(items) {
    const convertible = items.filter((i) => canBePart(i) && !partOf(i.id));
    return convertible.length ? `<section class="leather-panel"><button class="wide-button" data-leather-action="convert-stitch">✦ ${convertible.length} 個を革パーツにして縫い穴を作る</button></section>` : "";
  }
  function templatesPanel() {
    const l = leather();
    return `<section class="leather-panel"><div class="object-type">TEMPLATES / 型紙</div><h3>型紙テンプレート</h3>${TEMPLATES.map((t) => `<button class="wide-button" data-leather-template="${t.id}">＋ ${esc(t.label)} <small>配置</small></button><p class="note">${esc(t.note)}</p>`).join("")}<h4>加工設定</h4><div class="fields">${numField("kerf|||kerf", "カーフ補正", l.kerf, 0.05, LIMITS.kerf)}</div><p class="note">レーザーのビーム幅。外形は半分だけ外へ、穴は半分だけ内へ補正して書き出します（0 で補正なし）。</p></section>`;
  }
  function panelHTML(items) {
    if (!items.length) return templatesPanel();
    if (items.length === 1) return partPanel(items[0]) || offerPanel(items[0]);
    return multiPanel(items);
  }
  function refreshStats() {
    const d = derived();
    for (const el of document.querySelectorAll("[data-leather-stats]")) {
      const st = d.parts.flatMap((p) => p.stitch).find((s) => s.line.id === el.dataset.leatherStats);
      if (st) el.innerHTML = statsHTML(st);
    }
  }
  // ---- canvas
  function overlay(scale, { selectedIds = [] } = {}) {
    const d = derived();
    let html = "";
    const thin = 0.25 / Math.max(scale / 4, 0.5);
    for (const dp of d.parts) {
      if (!dp.item) continue;
      const on = selectedIds.includes(dp.item.id);
      for (const st of dp.stitch) {
        if (st.error) continue;
        html += `<path d="${pathD([st.points])}" fill="none" stroke="${on ? "#2a6fb0" : "#7a98b5"}" stroke-width="${thin}" stroke-dasharray="${thin * 4} ${thin * 3}" pointer-events="none"/>`;
        html += `<path d="${pathD(st.holes.map((h) => h.contour))}" fill="${on ? "#1a3b5c" : "#4d6378"}" fill-rule="nonzero" stroke="none" pointer-events="none"/>`;
        if (on && st.holes.length) {
          const h0 = st.holes[0];
          html += `<circle cx="${h0.x}" cy="${h0.y}" r="${thin * 4}" fill="none" stroke="#2a6fb0" stroke-width="${thin}" pointer-events="none"><title>開始</title></circle>`;
        }
      }
      for (const fd of dp.folds) html += `<path d="${pathD([fd.points])}" fill="none" stroke="#2f9e5f" stroke-width="${thin * 1.5}" stroke-dasharray="${fd.fold.kind === "valley" ? `${thin * 6} ${thin * 3} ${thin} ${thin * 3}` : `${thin * 6} ${thin * 3}`}" pointer-events="none"/>`;
      for (const hw of dp.hardware) {
        const r = Math.max((hw.preset.outer ?? 0) / 2, 2.5);
        html += `<g data-hardware="${dp.part.id}|${hw.placement.id}" class="hardware-handle" style="cursor:move"><circle cx="${hw.center.x}" cy="${hw.center.y}" r="${r}" fill="#ffffff" fill-opacity="0.01"/><path d="${pathD(hw.contours)}" fill="#1a3b5c" fill-opacity="0.8" stroke="none"/>${hw.preset.outer ? `<circle cx="${hw.center.x}" cy="${hw.center.y}" r="${hw.preset.outer / 2}" fill="none" stroke="#8a6a4a" stroke-width="${thin}" stroke-dasharray="${thin * 2} ${thin * 2}"/>` : ""}</g>`;
      }
      if (hwDrag?.guides?.length && hwDrag.item.id === dp.item.id) {
        const box = bounds(dp.outline);
        for (const g of hwDrag.guides) {
          const a = g.axis === "x" ? transform({ x: g.value, y: -1000 }, dp.item) : transform({ x: -1000, y: g.value }, dp.item);
          const b = g.axis === "x" ? transform({ x: g.value, y: 1000 }, dp.item) : transform({ x: 1000, y: g.value }, dp.item);
          html += `<path d="M${a.x} ${a.y} L${b.x} ${b.y}" stroke="#e0552e" stroke-width="${thin}" stroke-dasharray="${thin * 3} ${thin * 2}" pointer-events="none"/>`;
        }
        void box;
      }
    }
    for (const dj of d.joints) {
      if (dj.error || !selectedIds.length) continue;
      const involved = [dj.master, dj.slave].some((st) => d.parts.some((p) => selectedIds.includes(p.item?.id) && p.stitch.includes(st)));
      if (!involved) continue;
      // First pair marked on both parts so the start correspondence is visible.
      const pr = dj.pairs[0];
      if (pr) html += `<path d="M${pr.a.x} ${pr.a.y} L${pr.b.x} ${pr.b.y}" stroke="#d08a2e" stroke-width="${thin}" stroke-dasharray="${thin * 2} ${thin * 2}" fill="none" pointer-events="none"/>`;
    }
    if (eraseDrag?.moved) {
      const a = eraseDrag.start, b = eraseDrag.current;
      html += `<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" fill="#b3453b" fill-opacity="0.08" stroke="#b3453b" stroke-width="${thin}" stroke-dasharray="${thin * 3} ${thin * 2}" pointer-events="none"/>`;
    }
    if (ctx.tool() === "hole-erase") {
      for (const t of holeTargets())
        if (t.kind === "ghost") html += `<circle cx="${t.x}" cy="${t.y}" r="${thin * 3}" fill="none" stroke="#b3453b" stroke-width="${thin}" stroke-dasharray="${thin * 1.5} ${thin}" pointer-events="none"/>`;
      if (holeHover) html += `<circle cx="${holeHover.x}" cy="${holeHover.y}" r="${thin * 5}" fill="${holeHover.kind === "hole" ? "#b3453b" : "#2f9e5f"}" fill-opacity="0.25" stroke="${holeHover.kind === "hole" ? "#b3453b" : "#2f9e5f"}" stroke-width="${thin}" pointer-events="none"/>`;
    }
    if (seamFirst) {
      const pts = edgeOutline(seamFirst.e);
      if (pts.length) html += `<path d="${pathD([pts])}" fill="none" stroke="#d08a2e" stroke-width="${thin * 6}" stroke-linecap="round" pointer-events="none"/>`;
    }
    if (hover) {
      const pts = edgeOutline(hover);
      if (pts.length) html += `<path d="${pathD([pts])}" fill="none" stroke="#e08a2e" stroke-opacity="0.8" stroke-width="${thin * 6}" stroke-linecap="round" pointer-events="none"/>`;
    }
    return html ? `<g class="leather-overlay">${html}</g>` : "";
  }
  // Manufacturing preview: the operation groups in their colours.
  function previewHTML() {
    const d = derived();
    const groups = applyKerf(operationGeometry(project(), d), leather().kerf);
    return OPERATION_ORDER.map((op) => (groups[op].length ? `<path d="${pathD(groups[op].map((g) => g.points))}" fill="none" stroke="${OPERATION_COLORS[op]}" stroke-width="0.25"/>` : "")).join("");
  }
  const partColor = (itemId) => partOf(itemId)?.color ?? null;
  // ---- checks panel
  function checksHTML() {
    const p = project(),
      d = derived();
    const groups = operationGeometry(p, d);
    const summary = manufacturingSummary(groups);
    const issues = [...d.issues, ...checkParts(d), ...checkManufacturing(p, groups, d)];
    const errors = issues.filter((i) => i.level === "error"),
      warnings = issues.filter((i) => i.level !== "error");
    const row = (label, value, cls = "") => `<div class="check-row ${cls}"><span>${label}</span><b>${value}</b></div>`;
    const sheets = leather().parts.reduce((n, part) => n + part.quantity, 0);
    return (
      row("革パーツ", `${leather().parts.length}（計 ${sheets} 枚）`) +
      row("縫い穴 PUNCH", summary.punch) +
      row("カット線 CUT", `${summary.cut} · ${num(summary.cutLength / 10, 1)} cm`) +
      row("折り線 SCORE", summary.score) +
      row("彫刻 ENGRAVE", summary.engrave) +
      row("縫合", `${d.joints.length}`) +
      row("エラー", errors.length, errors.length ? "warning" : "success") +
      row("警告", warnings.length, warnings.length ? "warning" : "success") +
      `<div class="check-summary ${errors.length ? "warning" : ""}">${errors.length ? "! 書き出す前に修正してください" : warnings.length ? "△ 警告があります。内容を確認してください" : leather().parts.length ? "✓ 加工プレビューで CUT / PUNCH / SCORE を確認" : "図形を選んで「縫い穴を作る」か、テンプレートを配置してください"}</div>` +
      (issues.length ? `<ul class="leather-issues">${issues.slice(0, 30).map((i) => `<li class="${i.level}">${esc(i.message)}</li>`).join("")}${issues.length > 30 ? `<li>…ほか ${issues.length - 30} 件</li>` : ""}</ul>` : "")
    );
  }
  function exportSVG() {
    const p = project(),
      d = derived();
    const groups = operationGeometry(p, d);
    const issues = [...d.issues, ...checkManufacturing(p, groups, d)];
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length) throw Error(`${errors.length} 件のエラーがあります: ${errors[0].message}`);
    return { svg: exportLeatherSVG(p, d, { kerf: leather().kerf }), summary: manufacturingSummary(applyKerf(groups, leather().kerf)), warnings: issues.length };
  }
  // ---- events
  function handleClick(e) {
    const t = e.target.closest("[data-leather-action],[data-leather-template],[data-leather-pitch]");
    if (!t) return false;
    if (t.dataset.leatherTemplate) {
      placeTemplate(t.dataset.leatherTemplate);
      return true;
    }
    if (t.dataset.leatherPitch) {
      const [partId, lineId, v] = t.dataset.leatherPitch.split("|");
      applyField(`stitch|${partId}|${lineId}|pitch`, Number(v), true);
      return true;
    }
    const a = t.dataset.leatherAction;
    if (a === "mirror") mirrorSelection();
    else if (a === "detach-mirror") mutate((l) => detachMirror(l, t.dataset.part), "ミラーのリンクを解除しました。以後は独立したパーツです。");
    else if (a.startsWith("history-")) historyAction(a, t.dataset.part, t.dataset.feature);
    else if (a === "recapture") recapturePlacement(t.dataset.part, t.dataset.entry);
    else if (a === "restore-holes") restoreAll(t.dataset.part, t.dataset.entry);
    else if (a === "boolean-union") applyBooleanLeather("union");
    else if (a === "boolean-difference") applyBooleanLeather("difference");
    else if (a === "convert") convertSelection(false);
    else if (a === "convert-stitch") convertSelection(true);
    else if (a === "add-full-stitch") addFullStitch();
    else if (a === "unmake-part") unmakePart(t.dataset.part);
    else if (a === "remove-entry") removeEntry(t.dataset.part, t.dataset.entry);
    else if (a === "remove-joint") removeJoint(t.dataset.joint);
    else if (a === "add-hardware-center") {
      lastPreset = $("#leather-hardware-preset")?.value ?? lastPreset;
      const part = partById(t.dataset.part);
      const item = project().items.find((i) => i.id === part?.itemId);
      if (!item) return true;
      const ring = worldContours(item).find(isClosed) ?? [];
      const c = ring.reduce((s, q) => ({ x: s.x + q.x / ring.length, y: s.y + q.y / ring.length }), { x: 0, y: 0 });
      const local = transform(c, item, true);
      mutate(() => part.hardware.push(makeHardware(uid(), { presetId: lastPreset, x: Number(local.x.toFixed(2)), y: Number(local.y.toFixed(2)) })), "金具を中央に配置しました。");
    } else if (a === "create-joint") {
      const aLine = $("#leather-joint-a")?.value,
        [bPart, bLine] = ($("#leather-joint-b")?.value ?? "|").split("|");
      createJoint(t.dataset.part, aLine, bPart, bLine, $("#leather-joint-reverse")?.checked);
    } else return false;
    return true;
  }
  function fieldValue(el) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number") {
      if (!Number.isFinite(el.valueAsNumber)) return null;
      return el.dataset.leatherField.endsWith("|maxDeviation") ? el.valueAsNumber / 100 : el.valueAsNumber;
    }
    return el.value;
  }
  // `input` events preview live (numbers, checkboxes), `change` commits.
  function handleInput(e) {
    const el = e.target.closest("[data-leather-field]");
    if (!el || el.type === "text" || el.tagName === "SELECT") return false;
    const v = fieldValue(el);
    if (v === null) return true;
    applyField(el.dataset.leatherField, v, false);
    return true;
  }
  function handleChange(e) {
    const el = e.target.closest("[data-leather-field]");
    if (!el) return false;
    const v = fieldValue(el);
    if (v === null) {
      ctx.notify("有効な数値を入力してください。");
      return true;
    }
    applyField(el.dataset.leatherField, v, true);
    return true;
  }
  function pointerDown(e, p, mmPerPx) {
    if (hardwarePointerDown(e, p)) return true;
    const tool = ctx.tool();
    if (!isLeatherTool(tool)) return false;
    if (tool === "hardware") {
      lastPreset = $("#leather-hardware-preset")?.value ?? lastPreset;
      addHardwareAt(p);
      return true;
    }
    if (tool === "hole-erase") {
      eraseDrag = { start: p, current: p, moved: false, mmPerPx, extend: Boolean(e.shiftKey || ctx.multiSelect?.()) };
      $("#canvas").setPointerCapture?.(e.pointerId);
      return true;
    }
    if (tool === "seam") {
      seamClick(p, mmPerPx);
      return true;
    }
    const edge = pickEdge(p, mmPerPx * 12);
    if (!edge) {
      ctx.notify("革パーツの辺の近くをクリックしてください。図形がまだ革パーツでなければ、先に「革パーツにする」を押します。");
      return true;
    }
    ctx.selectIds([edge.itemId]);
    addEdgeLine(edge, tool === "fold-edge" ? "fold" : "stitch");
    return true;
  }
  function pointerMove(p, mmPerPx) {
    if (hwDrag) return hardwarePointerMove(p, mmPerPx);
    const tool = ctx.tool();
    if (tool === "hole-erase" && eraseDrag) {
      eraseDrag.current = p;
      if (Math.hypot(p.x - eraseDrag.start.x, p.y - eraseDrag.start.y) > mmPerPx * 6) eraseDrag.moved = true;
      return true;
    }
    if (tool === "hole-erase") {
      const t = nearestHole(p, Math.max(mmPerPx * 14, 1.5));
      const changed = (t?.x !== holeHover?.x) || t?.y !== holeHover?.y;
      holeHover = t ? { x: t.x, y: t.y, kind: t.kind } : null;
      return changed;
    }
    if (holeHover) holeHover = null;
    if (!["stitch-edge", "fold-edge", "seam"].includes(tool)) {
      if (hover) {
        hover = null;
        return true;
      }
      return false;
    }
    const edge = pickEdge(p, mmPerPx * 12);
    const changed = (edge?.itemId !== hover?.itemId) || edge?.s !== hover?.s || edge?.i !== hover?.i;
    hover = edge;
    return changed;
  }
  function cancel() {
    hover = null;
    holeHover = null;
    continuing = null;
    seamFirst = null;
    eraseDrag = null;
    lastErased = null;
  }
  function onItemsRemoved(ids) {
    remapItems(leather(), { removed: ids });
  }
  // After a boolean the outline is a new fitted path whose node numbers
  // mean nothing to the old edge runs, so those become whole-outline lines.
  function onItemsReplaced(map, { newShape = false, oldItems = [], newItem = null } = {}) {
    const l = leather();
    // Keep hardware and projections where they are on the board even though
    // the new item's local frame differs (must happen before the re-point).
    if (newItem) for (const old of oldItems) if (partOf(old.id)) rebaseItemFrames(l, old, newItem, { transform, relativePlacement, composePlacement });
    remapItems(l, { replaced: map });
    if (newShape) {
      // Lines projected from a part whose outline just changed: recapture
      // their placement from where the pieces are now.
      for (const part of l.parts)
        if (Object.values(map).includes(part.itemId))
          for (const other of l.parts)
            for (const line of other.stitchLines)
              if (line.source.kind === "projected" && line.source.partId === part.id) {
                const bottom = project().items.find((i) => i.id === other.itemId);
                if (bottom) line.source.placement = relativePlacement(bottom, newItem);
              }
    }
    if (!newShape) return;
    let reset = 0;
    for (const part of l.parts)
      if (Object.values(map).includes(part.itemId))
        for (const line of [...part.stitchLines, ...part.foldLines])
          if (line.source.from !== null) {
            line.source = { subpath: 0, from: null, to: null };
            reset++;
          }
    if (reset) ctx.notify(`形状が変わったため、辺を指定していた ${reset} 本の線を全周に戻しました。必要なら「辺に縫い線」で引き直してください。`);
  }
  const applyBooleanLeather = (op) => ctx.applyBoolean?.(op);
  function modeText(tool) {
    return isLeatherTool(tool) ? `${LEATHER_TOOLS[tool].label} · 革パーツ` : null;
  }
  const hint = (tool) => LEATHER_TOOLS[tool]?.hint ?? null;
  function toolbarHTML() {
    return `<div class="tool-group leather-tools"><span class="tool-group-label">LEATHER</span><button id="leather-convert" class="tool" title="選択した閉じた図形を革パーツにして、外周に縫い穴を作る"><span class="tool-icon">✦</span>縫い穴を作る</button><button id="leather-mirror" class="tool" title="選択した革パーツの左右対称コピーを作る（縫い穴の傾きも反転、縫合で穴数を合わせる）"><span class="tool-icon">⇔</span>ミラー</button><button id="leather-union" class="tool" title="選択した 2 つ以上の図形を合体（結合）"><span class="tool-icon">∪</span>合体</button><button id="leather-difference" class="tool" title="最初に選択した図形から残りを抜く（切り抜き）"><span class="tool-icon">−</span>抜く</button>${Object.entries(LEATHER_TOOLS).map(([id, t]) => `<button data-tool="${id}" class="tool" title="${esc(t.hint)}"><span class="tool-icon">${t.icon}</span>${t.label}</button>`).join("")}</div>`;
  }
  // Context menu (right click / long press). Tools are entered through ctx.setTool.
  function menuEntries(items) {
    const one = items.length === 1 ? items[0] : null;
    const parts = items.map((i) => partOf(i.id)).filter(Boolean);
    const out = [];
    if (items.some((i) => canBePart(i) && !partOf(i.id))) out.push(["leather-convert-stitch", "✦ 縫い穴を作る（革パーツ化）", "", true], ["leather-convert", "◈ 革パーツにする", "", true]);
    if (parts.length) {
      out.push(["leather-add-full", "＋ 全周に縫い線", "", true]);
      out.push(["leather-tool-stitch-edge", "⋯ 辺に縫い線（辺をクリック）", "", true]);
      out.push(["leather-tool-fold-edge", "⌇ 辺に折り線", "", true]);
      out.push(["leather-tool-seam", "⟗ 縫い合わせ（辺を2つクリック）", "", true]);
      out.push(["leather-tool-hole-erase", "⊘ 穴を1つずつ消す／戻す", "", parts.some((p) => p.stitchLines.length)]);
      out.push(["leather-hardware-center", "◎ 金具を中央に配置", "", true]);
      out.push(["leather-tool-hardware", "◎ 金具をクリックで配置", "", true]);
      out.push("-");
      out.push(["leather-mirror", "⇔ ミラーコピー（左右対称の相手パーツ）", "", true]);
      if (parts.length === 2 && parts.every((p) => p.stitchLines.some((l) => l.source.kind !== "projected"))) out.push(["leather-join", "⟗ 2つの縫い線を縫合（穴数・位置を合わせる）", "", true]);
      if (one && partOf(one.id)) {
        const part = partOf(one.id);
        out.push(part.history ? ["leather-history-hole", "◷ 履歴に丸穴を追加", "", true] : ["leather-history-start", "◷ 操作履歴を開始", "", true]);
        if (part.mirrorOf) out.push(["leather-detach", "⇔ ミラーのリンクを解除", "", true]);
      }
      out.push(["leather-unmake", "革パーツを解除（図形は残す）", "", true]);
    }
    return out;
  }
  const menuActions = {
    "leather-convert-stitch": () => convertSelection(true),
    "leather-convert": () => convertSelection(false),
    "leather-add-full": addFullStitch,
    "leather-mirror": mirrorSelection,
    "leather-tool-stitch-edge": () => ctx.setTool?.("stitch-edge"),
    "leather-tool-fold-edge": () => ctx.setTool?.("fold-edge"),
    "leather-tool-seam": () => ctx.setTool?.("seam"),
    "leather-tool-hole-erase": () => ctx.setTool?.("hole-erase"),
    "leather-tool-hardware": () => ctx.setTool?.("hardware"),
    "leather-hardware-center": () => {
      for (const item of ctx.selectedItems()) {
        const part = partOf(item.id);
        if (!part) continue;
        const ring = worldContours(item).find(isClosed) ?? [];
        const c = ring.reduce((s, q) => ({ x: s.x + q.x / ring.length, y: s.y + q.y / ring.length }), { x: 0, y: 0 });
        const local = transform(c, item, true);
        mutate(() => part.hardware.push(makeHardware(uid(), { presetId: lastPreset, x: Number(local.x.toFixed(2)), y: Number(local.y.toFixed(2)) })), "金具を中央に配置しました。ドラッグで移動、右パネルで種類を変更できます。");
      }
    },
    "leather-join": () => {
      const parts = ctx.selectedItems().map((i) => partOf(i.id)).filter(Boolean);
      if (parts.length !== 2) return;
      const la = parts[0].stitchLines.filter((l) => l.source.kind !== "projected").at(-1), lb = parts[1].stitchLines.filter((l) => l.source.kind !== "projected").at(-1);
      createJoint(parts[0].id, la?.id, parts[1].id, lb?.id, false);
    },
    "leather-history-start": () => { const one = ctx.selectedItems()[0]; const part = one && partOf(one.id); if (part) historyAction("history-start", part.id); },
    "leather-history-hole": () => { const one = ctx.selectedItems()[0]; const part = one && partOf(one.id); if (part) historyAction("history-hole", part.id); },
    "leather-detach": () => { const one = ctx.selectedItems()[0]; const part = one && partOf(one.id); if (part) mutate((l) => detachMirror(l, part.id), "ミラーのリンクを解除しました。"); },
    "leather-unmake": () => {
      const one = ctx.selectedItems()[0];
      if (one && partOf(one.id)) unmakePart(partOf(one.id).id);
    },
  };
  const isPart = (itemId) => Boolean(partOf(itemId));
  const anyConvertible = () => ctx.selectedItems().some((i) => canBePart(i) && !partOf(i.id)) || ctx.selectedItems().some((i) => partOf(i.id));
  return {
    derived, panelHTML, overlay, previewHTML, checksHTML, exportSVG, handleClick, handleInput, handleChange, pointerDown, pointerMove, cancel,
    onItemsRemoved, onItemsReplaced, modeText, hint, toolbarHTML, menuEntries, menuActions, isLeatherTool, isPart, partColor, anyConvertible,
    convertSelection, placeTemplate, TEMPLATES, mirrorPartsFor, mirrorSelection, syncMirrors, hardwarePointerUp, pointerUp, dragging, recordCorner,
    anyPartSelected: () => ctx.selectedItems().some((i) => partOf(i.id)),
  };
}
