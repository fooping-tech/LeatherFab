// Alignment snapping ("smart guides"): while an object is placed, moved or
// resized, its left / centre / right (and top / middle / bottom) lines pull
// to the same lines of the other objects and of the board when they are
// within a few screen pixels. Boxes are axis-aligned world-space bounds
// { x, y, w, h } in mm; the threshold is in mm (screen pixels ÷ scale).
export const ALIGN_THRESHOLD_PX = 6;
const EPS = 1e-6;
// The three alignment lines of a box on one axis.
export function lines(box, axis) {
  const start = axis === "x" ? box.x : box.y,
    size = axis === "x" ? box.w : box.h;
  return [
    ["start", start],
    ["center", start + size / 2],
    ["end", start + size],
  ];
}
// World-space bounds of several boxes together.
export function unionBox(boxes) {
  if (!boxes.length) return null;
  const x1 = Math.min(...boxes.map((b) => b.x)),
    y1 = Math.min(...boxes.map((b) => b.y)),
    x2 = Math.max(...boxes.map((b) => b.x + b.w)),
    y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
// The smallest shift on one axis that makes a line of `moving` coincide with
// a line of a target, within the threshold; null when there is none.
function axisShift(moving, targets, axis, threshold) {
  let best = null;
  for (const [, m] of lines(moving, axis))
    for (const t of targets)
      for (const [, v] of lines(t, axis)) {
        const d = v - m;
        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best) - EPS))
          best = d;
      }
  return best;
}
// Guides for the lines of `box` that coincide with target lines: one per
// distinct value, spanning both boxes on the other axis.
function guidesFor(box, targets, axis) {
  const guides = [],
    lo = axis === "x" ? "y" : "x",
    size = axis === "x" ? "h" : "w";
  for (const [kind, m] of lines(box, axis)) {
    let from = box[lo],
      to = box[lo] + box[size],
      hit = false,
      board = false;
    for (const t of targets)
      for (const [, v] of lines(t, axis))
        if (Math.abs(v - m) <= EPS) {
          hit = true;
          if (t.board) board = true;
          else {
            from = Math.min(from, t[lo]);
            to = Math.max(to, t[lo] + t[size]);
          }
        }
    if (hit && !guides.some((g) => Math.abs(g.value - m) <= EPS))
      guides.push({ axis, kind, value: m, from, to, board });
  }
  return guides;
}
// Shift for a box being moved so that it aligns with the targets: dx / dy
// are null on an axis without a snap. `guides` describe the aligned lines
// after the shift (for drawing).
export function alignmentSnap(moving, targets, threshold) {
  const dx = axisShift(moving, targets, "x", threshold),
    dy = axisShift(moving, targets, "y", threshold),
    snapped = { ...moving, x: moving.x + (dx ?? 0), y: moving.y + (dy ?? 0) };
  return {
    dx,
    dy,
    guides: [
      ...(dx === null ? [] : guidesFor(snapped, targets, "x")),
      ...(dy === null ? [] : guidesFor(snapped, targets, "y")),
    ],
  };
}
// A single point (a resize corner) pulled to the targets' lines.
export function pointSnap(point, targets, threshold) {
  const dot = { x: point.x, y: point.y, w: 0, h: 0 },
    r = alignmentSnap(dot, targets, threshold);
  return {
    x: point.x + (r.dx ?? 0),
    y: point.y + (r.dy ?? 0),
    snappedX: r.dx !== null,
    snappedY: r.dy !== null,
    guides: r.guides,
  };
}
// The board is a target too: its edges and centre lines.
export const boardBox = (project) => ({
  x: 0,
  y: 0,
  w: project.width,
  h: project.height,
  board: true,
});
