// Hardware presets (Leather Domain Core). Sizes are typical values for the
// common Japanese sizes and are a starting point only: the real hole size
// depends on the maker and the leather, so every preset can be overridden
// and users can add their own (project.leather.hardwarePresets).
export const HARDWARE_TYPES = Object.freeze({
  "snap-spring": "バネホック",
  "snap-jumper": "ジャンパーホック",
  rivet: "カシメ",
  eyelet: "ハトメ",
  "snap-magnet": "マグネットホック",
  "d-ring": "Dカン（カシメ穴）",
  "belt-hole": "ベルト穴",
  custom: "カスタム穴",
});
// A preset punches one or more holes around its anchor: `holes` are circles
// {dx, dy, d} (mm), `slot` an optional {w, h} stadium at the anchor. `outer`
// is the visible cap diameter for display only.
export const HARDWARE_PRESETS = Object.freeze([
  { id: "snap-spring-s", type: "snap-spring", label: "バネホック 小（No.2, 頭 10 mm）", holes: [{ dx: 0, dy: 0, d: 2.5 }], outer: 10 },
  { id: "snap-spring-m", type: "snap-spring", label: "バネホック 中（No.5, 頭 12.5 mm）", holes: [{ dx: 0, dy: 0, d: 3.0 }], outer: 12.5 },
  { id: "snap-spring-l", type: "snap-spring", label: "バネホック 大（7050, 頭 15 mm）", holes: [{ dx: 0, dy: 0, d: 3.5 }], outer: 15 },
  { id: "snap-jumper-m", type: "snap-jumper", label: "ジャンパーホック 中（7060, 頭 13 mm）", holes: [{ dx: 0, dy: 0, d: 3.5 }], outer: 13 },
  { id: "snap-jumper-l", type: "snap-jumper", label: "ジャンパーホック 大（7201, 頭 15 mm）", holes: [{ dx: 0, dy: 0, d: 4.0 }], outer: 15 },
  { id: "rivet-s", type: "rivet", label: "カシメ 小（頭 6 mm）", holes: [{ dx: 0, dy: 0, d: 2.0 }], outer: 6 },
  { id: "rivet-m", type: "rivet", label: "カシメ 中（頭 8 mm）", holes: [{ dx: 0, dy: 0, d: 2.5 }], outer: 8 },
  { id: "rivet-l", type: "rivet", label: "カシメ 大（頭 9 mm）", holes: [{ dx: 0, dy: 0, d: 3.0 }], outer: 9 },
  { id: "eyelet-4", type: "eyelet", label: "ハトメ 内径 4 mm", holes: [{ dx: 0, dy: 0, d: 4.0 }], outer: 8 },
  { id: "eyelet-5", type: "eyelet", label: "ハトメ 内径 5 mm（#300）", holes: [{ dx: 0, dy: 0, d: 5.0 }], outer: 9.5 },
  { id: "eyelet-8", type: "eyelet", label: "ハトメ 内径 8 mm（#25）", holes: [{ dx: 0, dy: 0, d: 8.0 }], outer: 13 },
  { id: "magnet-14", type: "snap-magnet", label: "マグネットホック 14 mm（足穴 2本）", holes: [], slot: { w: 2.0, h: 5.0, pitch: 11 }, outer: 14 },
  { id: "magnet-18", type: "snap-magnet", label: "マグネットホック 18 mm（足穴 2本）", holes: [], slot: { w: 2.0, h: 6.0, pitch: 14 }, outer: 18 },
  { id: "d-ring-15", type: "d-ring", label: "Dカン 15 mm 用カシメ穴（2つ）", holes: [{ dx: -4, dy: 0, d: 2.5 }, { dx: 4, dy: 0, d: 2.5 }], outer: 15 },
  { id: "belt-hole-4", type: "belt-hole", label: "ベルト穴 丸 4 mm", holes: [{ dx: 0, dy: 0, d: 4.0 }], outer: 4 },
  { id: "belt-hole-oval", type: "belt-hole", label: "ベルト穴 小判 4 × 7 mm", holes: [], slot: { w: 4, h: 7, pitch: 0 }, outer: 7 },
  { id: "key-ring-5", type: "eyelet", label: "キーリング用穴 5 mm", holes: [{ dx: 0, dy: 0, d: 5.0 }], outer: 5 },
]);
export const presetById = (id, custom = []) => [...custom, ...HARDWARE_PRESETS].find((p) => p.id === id) ?? null;
const STEP = 0.005;
function circle(cx, cy, d) {
  const r = d / 2,
    n = Math.max(24, 4 * Math.ceil(Math.PI / Math.acos(Math.max(0.01, 1 - STEP / r)) / 4));
  const pts = Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));
  return [...pts, { ...pts[0] }];
}
function stadium(cx, cy, w, h) {
  // Long axis along y (a slot across the strap direction); w ≤ h.
  const r = Math.min(w, h) / 2,
    half = Math.max(0, h / 2 - r),
    n = 12,
    pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (Math.PI * i) / n;
    pts.push({ x: cx + r * Math.cos(t), y: cy + half + r * Math.sin(t) });
  }
  for (let i = 0; i <= n; i++) {
    const t = Math.PI + (Math.PI * i) / n;
    pts.push({ x: cx + r * Math.cos(t), y: cy - half + r * Math.sin(t) });
  }
  pts.push({ ...pts[0] });
  return pts;
}
// Local (unrotated, around the origin) punch contours of a preset.
export function hardwareContours(preset) {
  const out = (preset.holes ?? []).map((h) => circle(h.dx, h.dy, h.d));
  if (preset.slot) {
    const { w, h, pitch = 0 } = preset.slot;
    if (pitch > 0) out.push(stadium(-pitch / 2, 0, w, h), stadium(pitch / 2, 0, w, h));
    else out.push(stadium(0, 0, w, h));
  }
  return out;
}
export function validateHardwarePreset(p) {
  const ok = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;
  if (!p || typeof p.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || typeof p.label !== "string" || p.label.length > 100) return null;
  const holes = Array.isArray(p.holes) ? p.holes.filter((h) => h && ok(h.dx, -100, 100) && ok(h.dy, -100, 100) && ok(h.d, 0.2, 60)) : [];
  const slot = p.slot && ok(p.slot.w, 0.2, 60) && ok(p.slot.h, 0.2, 60) ? { w: p.slot.w, h: p.slot.h, pitch: ok(p.slot.pitch, 0, 100) ? p.slot.pitch : 0 } : undefined;
  if (!holes.length && !slot) return null;
  return { id: p.id, type: p.type in HARDWARE_TYPES ? p.type : "custom", label: p.label, holes, ...(slot ? { slot } : {}), outer: ok(p.outer, 0, 100) ? p.outer : Math.max(...holes.map((h) => h.d), slot?.h ?? 0) };
}
