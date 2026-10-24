import ClipperLib from "clipper-lib";
import { bounds, worldContours, transform, shapeContours } from "./geometry.js";
import { shapeSource, applyWarp } from "./warp.js";
import { transformPath, pathContours } from "./path.js";
const SCALE = 10000;
const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-7;
export function booleanContours(items, operation) {
  if (items.length < 2)
    throw Error("Shiftを押して2つ以上の閉じた図形を選択してください。");
  const types = {
    union: ClipperLib.ClipType.ctUnion,
    difference: ClipperLib.ClipType.ctDifference,
    intersection: ClipperLib.ClipType.ctIntersection,
    xor: ClipperLib.ClipType.ctXor,
  };
  if (!(operation in types)) throw Error("不明な図形演算です。");
  const polygons = items.map((item) => {
    if (
      item.type === "bridge" ||
      !item.contours.length ||
      item.contours.some((c) => c.length < 4 || !close(c[0], c.at(-1)))
    )
      throw Error("線分・ブリッジ・開いた輪郭はブーリアン演算できません。");
    const paths = worldContours(item).map((c) =>
      c.slice(0, -1).map((p) => ({
        X: Math.round(p.x * SCALE),
        Y: Math.round(p.y * SCALE),
      })),
    );
    // Normalize each object's nonzero fill first; preserve holes and remove self intersections.
    return ClipperLib.Clipper.SimplifyPolygons(
      paths,
      ClipperLib.PolyFillType.pftNonZero,
    );
  });
  let result = polygons[0];
  for (const operand of polygons.slice(1)) {
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(result, ClipperLib.PolyType.ptSubject, true);
    clipper.AddPaths(operand, ClipperLib.PolyType.ptClip, true);
    const next = [];
    if (
      !clipper.Execute(
        types[operation],
        next,
        ClipperLib.PolyFillType.pftNonZero,
        ClipperLib.PolyFillType.pftNonZero,
      )
    )
      throw Error("図形演算に失敗しました。");
    result = next;
  }
  return result
    .filter((c) => c.length >= 3)
    .map((c) => {
      const pts = c.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));
      return [...pts, { ...pts[0] }];
    });
}
// Warped shapes are framed by their actual outline, not their dimensions.
export function itemBounds(item) {
  return item.warp
    ? bounds(item.contours)
    : item.type === "bridge"
      ? { x: -item.w / 2, y: -item.h / 2, w: item.w, h: item.h }
      : ["rect", "circle"].includes(item.type)
        ? { x: 0, y: 0, w: item.w, h: item.h }
        : bounds(item.contours);
}
export function canResize(item) {
  return (
    item &&
    ["rect", "circle", "outline", "bridge", "text"].includes(item.type) &&
    itemBounds(item).w > 0.001 &&
    itemBounds(item).h > 0.001
  );
}
// layout(item) rebuilds a text item's outline; only text resizing needs it.
export function resizeFromHandle(
  item,
  corner,
  worldPoint,
  locked = item.ratioLocked,
  layout = null,
) {
  const b = itemBounds(item),
    [hx, hy] = corner,
    ax = b.x + (1 - hx) * b.w,
    ay = b.y + (1 - hy) * b.h;
  const p = transform(worldPoint, item, true);
  let w = Math.max(0.1, Math.min(2000, (p.x - ax) * (hx ? 1 : -1))),
    h = Math.max(0.1, Math.min(2000, (p.y - ay) * (hy ? 1 : -1)));
  if (locked) {
    const scale = Math.min(
      2000 / Math.max(b.w, b.h),
      Math.max(w / b.w, h / b.h),
    );
    w = b.w * scale;
    h = b.h * scale;
  }
  if (item.type === "text" || item.warp)
    return resizeLinear(item, b, hx, hy, ax, ay, w, h, locked, layout);
  const x = hx ? ax : ax - w,
    y = hy ? ay : ay - h;
  const next = structuredClone(item);
  if (item.type === "bridge") {
    Object.assign(next, transform({ x: x + w / 2, y: y + h / 2 }, item), {
      w,
      h,
    });
  } else {
    Object.assign(next, transform({ x, y }, item));
    if (["rect", "circle"].includes(item.type)) {
      next.w = w;
      next.h = h;
      if (item.radius) next.radius = Math.min(item.radius, w / 2, h / 2);
      next.contours = shapeContours(item.type, w, h, next.radius);
    } else if (item.path) {
      // An editable path scales its nodes and handles, then is flattened anew.
      next.path = transformPath(item.path, (p) => ({
        x: ((p.x - b.x) * w) / b.w,
        y: ((p.y - b.y) * h) / b.h,
      }));
      next.contours = pathContours(next.path);
    } else
      next.contours = item.contours.map((c) =>
        c.map((p) => ({
          x: ((p.x - b.x) * w) / b.w,
          y: ((p.y - b.y) * h) / b.h,
        })),
      );
  }
  return next;
}
// Text and warped shapes keep their settings and are rebuilt: a text's
// vertical factor scales font size and spacing and the rest of the horizontal
// factor becomes its stored horizontal scale; a warped rectangle or ellipse
// scales its dimensions; a warped path scales its unwarped source. The
// envelope is relative to the unwarped box, so the final outline scales by
// the same factors about the local origin and the opposite corner stays put.
function resizeLinear(item, b, hx, hy, ax, ay, w, h, locked, layout) {
  const next = structuredClone(item),
    clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let kx = w / b.w,
    ky = h / b.h;
  if (item.type === "text") {
    if (!layout) throw Error("文字の拡縮にはフォントが必要です。");
    const stretch = item.stretch ?? 1;
    ky = clamp(item.size * ky, 1, 300) / item.size;
    kx = locked ? ky : (clamp(stretch * (kx / ky), 0.05, 20) / stretch) * ky;
    next.size = item.size * ky;
    next.spacing = clamp(item.spacing * ky, -100, 100);
    next.stretch = stretch * (kx / ky);
  } else if (["rect", "circle"].includes(item.type)) {
    kx = clamp(item.w * kx, 0.1, 2000) / item.w;
    ky = clamp(item.h * ky, 0.1, 2000) / item.h;
    next.w = item.w * kx;
    next.h = item.h * ky;
    if (item.radius)
      next.radius = Math.min(item.radius, next.w / 2, next.h / 2);
  } else {
    next.warp.source = item.warp.source.map((c) =>
      c.map((p) => ({ x: p.x * kx, y: p.y * ky })),
    );
    // The unwarped editable path scales with its source.
    if (item.path)
      next.path = transformPath(item.path, (p) => ({
        x: p.x * kx,
        y: p.y * ky,
      }));
  }
  const x = hx ? ax : ax - b.w * kx,
    y = hy ? ay : ay - b.h * ky;
  Object.assign(next, transform({ x: x - b.x * kx, y: y - b.y * ky }, item));
  next.contours =
    item.type === "text" ? layout(next) : applyWarp(next, shapeSource(next));
  return next;
}
// Scoped tabs follow their owner. Their physical width stays fixed when the owner is resized.
export function followBridges(items, before, after) {
  const old = itemBounds(before),
    next = itemBounds(after);
  for (const bridge of items.filter((i) => i.targetId === before.id)) {
    const p = transform(bridge, before, true);
    const q = {
      x: next.x + (p.x - old.x) * (old.w ? next.w / old.w : 1),
      y: next.y + (p.y - old.y) * (old.h ? next.h / old.h : 1),
    };
    if (["island", "stencil"].includes(bridge.bridgeMode)) {
      const endpoints = [-1, 1].map((sign) => {
        const angle = (bridge.rotation * Math.PI) / 180;
        const local = transform(
          {
            x: bridge.x + (sign * Math.cos(angle) * bridge.w) / 2,
            y: bridge.y + (sign * Math.sin(angle) * bridge.w) / 2,
          },
          before,
          true,
        );
        return transform(
          {
            x: next.x + (local.x - old.x) * (old.w ? next.w / old.w : 1),
            y: next.y + (local.y - old.y) * (old.h ? next.h / old.h : 1),
          },
          after,
        );
      });
      bridge.w = Math.hypot(
        endpoints[1].x - endpoints[0].x,
        endpoints[1].y - endpoints[0].y,
      );
      bridge.rotation =
        (Math.atan2(
          endpoints[1].y - endpoints[0].y,
          endpoints[1].x - endpoints[0].x,
        ) *
          180) /
        Math.PI;
    } else bridge.rotation += after.rotation - before.rotation;
    Object.assign(bridge, transform(q, after));
    bridge.layerId = after.layerId;
  }
}
