import ClipperLib from "clipper-lib";
import { visibleItems } from "./layers.js";
// All geometry uses millimetres. Curves are adaptively flattened to 0.02 mm.
export const TOLERANCE = 0.02;
const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-7;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function distance(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    l = dx * dx + dy * dy;
  const t = l
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l))
    : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
function cubic(a, b, c, d, out, depth = 0) {
  if (
    depth >= 18 ||
    Math.max(distance(b, a, d), distance(c, a, d)) <= TOLERANCE
  ) {
    out.push(d);
    return;
  }
  const ab = mid(a, b),
    bc = mid(b, c),
    cd = mid(c, d),
    abc = mid(ab, bc),
    bcd = mid(bc, cd),
    m = mid(abc, bcd);
  cubic(a, ab, abc, m, out, depth + 1);
  cubic(m, bcd, cd, d, out, depth + 1);
}
export function flatten(commands) {
  const contours = [];
  let pts = [],
    p = { x: 0, y: 0 };
  const finish = () => {
    if (pts.length > 1) contours.push(pts);
    pts = [];
  };
  for (const cmd of commands) {
    const q = { x: cmd.x, y: cmd.y };
    if (cmd.type === "M") {
      finish();
      pts = [q];
      p = q;
    } else if (cmd.type === "L") {
      pts.push(q);
      p = q;
    } else if (cmd.type === "C") {
      cubic(p, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x2, y: cmd.y2 }, q, pts);
      p = q;
    } else if (cmd.type === "Q") {
      cubic(
        p,
        {
          x: p.x + (2 / 3) * (cmd.x1 - p.x),
          y: p.y + (2 / 3) * (cmd.y1 - p.y),
        },
        {
          x: q.x + (2 / 3) * (cmd.x1 - q.x),
          y: q.y + (2 / 3) * (cmd.y1 - q.y),
        },
        q,
        pts,
      );
      p = q;
    } else if (cmd.type === "Z") {
      if (pts.length && !same(pts[0], p)) pts.push({ ...pts[0] });
      finish();
    }
  }
  finish();
  return contours;
}
export function transform(p, item, inverse = false) {
  const r = (((item.rotation || 0) * Math.PI) / 180) * (inverse ? -1 : 1),
    c = Math.cos(r),
    s = Math.sin(r);
  const x = inverse ? p.x - item.x : p.x,
    y = inverse ? p.y - item.y : p.y;
  return {
    x: x * c - y * s + (inverse ? 0 : item.x),
    y: x * s + y * c + (inverse ? 0 : item.y),
  };
}
export function worldContours(item) {
  return item.contours.map((ps) => ps.map((p) => transform(p, item)));
}
// Liang–Barsky clipping against each bridge. Keep only the outside intervals.
export function clipSegment(a, b, bridge) {
  const p = transform(a, bridge, true),
    q = transform(b, bridge, true),
    dx = q.x - p.x,
    dy = q.y - p.y;
  let lo = 0,
    hi = 1;
  for (const [v, w] of [
    [-dx, p.x + bridge.w / 2],
    [dx, bridge.w / 2 - p.x],
    [-dy, p.y + bridge.h / 2],
    [dy, bridge.h / 2 - p.y],
  ]) {
    if (Math.abs(v) < 1e-12) {
      if (w < 0) return [[a, b]];
      continue;
    }
    const t = w / v;
    if (v < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return [[a, b]];
  }
  const at = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const parts = [];
  if (lo > 1e-9) parts.push([a, at(lo)]);
  if (hi < 1 - 1e-9) parts.push([at(hi), b]);
  return parts;
}
export function cutContour(points, bridges) {
  const runs = [];
  let run = [];
  for (let i = 1; i < points.length; i++) {
    let segments = [[points[i - 1], points[i]]];
    for (const b of bridges)
      segments = segments.flatMap(([a, c]) => clipSegment(a, c, b));
    for (const [a, b] of segments) {
      if (same(a, b)) continue;
      if (run.length && same(run.at(-1), a)) run.push(b);
      else {
        if (run.length) runs.push(run);
        run = [a, b];
      }
    }
  }
  if (run.length) runs.push(run);
  if (runs.length > 1 && same(runs.at(-1).at(-1), runs[0][0])) {
    runs[0] = [...runs.pop(), ...runs[0].slice(1)];
  }
  return runs;
}
// Subtract bridge rectangles as areas, retaining their sidewalls in the cut path.
export function stencilContours(item, bridges) {
  const source = worldContours(item);
  const bands = bridges.filter(
    (b) =>
      b.bridgeMode === "stencil" && (!b.targetId || b.targetId === item.id),
  );
  if (!bands.length) return source;
  const scale = 10000;
  const encode = (c) =>
    c.map((p) => ({ X: Math.round(p.x * scale), Y: Math.round(p.y * scale) }));
  const closed = source.filter((c) => c.length > 3 && same(c[0], c.at(-1)));
  const open = source.filter((c) => c.length < 4 || !same(c[0], c.at(-1)));
  if (!closed.length) return source;
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(
    closed.map((c) => encode(c.slice(0, -1))),
    ClipperLib.PolyType.ptSubject,
    true,
  );
  clipper.AddPaths(
    bands.map((b) =>
      encode(
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([x, y]) => transform({ x: (x * b.w) / 2, y: (y * b.h) / 2 }, b)),
      ),
    ),
    ClipperLib.PolyType.ptClip,
    true,
  );
  const result = [];
  if (
    !clipper.Execute(
      ClipperLib.ClipType.ctDifference,
      result,
      ClipperLib.PolyFillType.pftNonZero,
      ClipperLib.PolyFillType.pftNonZero,
    )
  )
    throw Error("ブリッジの切り抜きに失敗しました。");
  return [
    ...open,
    ...result
      .filter((c) => c.length >= 3)
      .map((c) => {
        const ps = c.map((p) => ({ x: p.X / scale, y: p.Y / scale }));
        return [...ps, { ...ps[0] }];
      }),
  ];
}
export function cutGeometry(items) {
  const bridges = items.filter((i) => i.type === "bridge");
  let closed = 0,
    untouched = 0,
    removed = 0,
    vanished = 0;
  const paths = [];
  for (const item of items.filter((i) => i.type !== "bridge")) {
    const stencil = bridges.filter(
      (b) =>
        b.bridgeMode === "stencil" && (!b.targetId || b.targetId === item.id),
    );
    const processed = stencilContours(item, stencil);
    if (!processed.length && worldContours(item).length) vanished++;
    for (const contour of processed) {
      const runs = cutContour(
        contour,
        bridges.filter(
          (b) =>
            b.bridgeMode !== "stencil" &&
            (!b.targetId || b.targetId === item.id),
        ),
      );
      if (!runs.length) vanished++;
      const length = (ps) =>
        ps
          .slice(1)
          .reduce((n, p, i) => n + Math.hypot(p.x - ps[i].x, p.y - ps[i].y), 0);
      const delta = length(contour) - runs.reduce((n, r) => n + length(r), 0);
      removed += delta;
      if (same(contour[0], contour.at(-1))) {
        closed++;
        if (delta < 1e-6 && !stencil.length) untouched++;
      }
      paths.push(...runs);
    }
  }
  return {
    paths,
    closed,
    untouched,
    removed,
    vanished,
    ...islandBridgeStatus(items),
  };
}
const num = (n) => Number(n.toFixed(4));
export function pathData(paths) {
  return paths
    .map(
      (ps) =>
        ps.map((p, i) => `${i ? "L" : "M"}${num(p.x)} ${num(p.y)}`).join(" ") +
        (same(ps[0], ps.at(-1)) ? " Z" : ""),
    )
    .join(" ");
}
// The cut SVG of the visible items. With `ids`, only those items (and the
// bridges that apply to them: their own and unscoped ones) are exported, and
// with `crop` the document is the size of the cut lines, moved to the origin.
export function exportSVG(project, { ids = null, crop = false } = {}) {
  let visible = visibleItems(project);
  if (ids) {
    const set = new Set(ids);
    visible = visible.filter(
      (i) =>
        set.has(i.id) ||
        (i.type === "bridge" && (!i.targetId || set.has(i.targetId))),
    );
  }
  const result = cutGeometry(visible);
  if (!result.paths.length) throw new Error("出力できるカット線がありません。");
  let ox = 0,
    oy = 0,
    width = project.width,
    height = project.height;
  if (crop) {
    const b = bounds(result.paths);
    ox = b.x;
    oy = b.y;
    width = Math.max(b.w, 0.1);
    height = Math.max(b.h, 0.1);
  }
  const shift = (paths) =>
    crop ? paths.map((ps) => ps.map((p) => ({ x: p.x - ox, y: p.y - oy }))) : paths;
  const xml = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c],
    );
  const path = (paths) =>
    `<path d="${pathData(shift(paths))}" fill="none" stroke="#ff0000" stroke-width="0.1" stroke-linecap="butt"/>`;
  const bridges = visible.filter((i) => i.type === "bridge");
  const body = project.layers
    ? project.layers
        .filter((l) => l.visible)
        .map((layer) => {
          const cut = cutGeometry([
            ...visible.filter(
              (i) => i.type !== "bridge" && i.layerId === layer.id,
            ),
            ...bridges,
          ]);
          return cut.paths.length
            ? `<g id="layer-${xml(layer.id)}" inkscape:groupmode="layer" inkscape:label="${xml(layer.name)}">${path(cut.paths)}</g>`
            : "";
        })
        .join("\n")
    : path(result.paths);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${num(width)}mm" height="${num(height)}mm" viewBox="0 0 ${num(width)} ${num(height)}">\n<title>TypeFab laser cut paths</title>\n<desc>Units: mm. Flattening tolerance: 0.02 mm. Bridges are gaps in cut paths.</desc>\n${body}\n</svg>\n`;
}
export function shapeContours(type, w, h, radius = 0) {
  if (type === "rect" && radius > 0) return [roundedRect(w, h, radius)];
  if (type === "line")
    return [
      [
        { x: 0, y: 0 },
        { x: w, y: h },
      ],
    ];
  if (type === "circle") {
    const n =
      4 *
      Math.ceil(
        Math.max(
          32,
          Math.ceil(
            Math.PI /
              Math.acos(Math.max(-1, 1 - TOLERANCE / (Math.max(w, h) / 2))),
          ),
        ) / 4,
      );
    const pts = Array.from({ length: n }, (_, i) => ({
      x: w / 2 + (w / 2) * Math.cos((i * 2 * Math.PI) / n),
      y: h / 2 + (h / 2) * Math.sin((i * 2 * Math.PI) / n),
    }));
    return [[...pts, { ...pts[0] }]];
  }
  return [
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
      { x: 0, y: 0 },
    ],
  ];
}
// Filleted rectangle, clockwise like the square one. Each corner arc keeps its
// chord error within TOLERANCE; the radius is clamped to half the shorter side.
function roundedRect(w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2),
    steps = Math.max(
      2,
      Math.ceil(Math.PI / 2 / (2 * Math.acos(Math.max(-1, 1 - TOLERANCE / r)))),
    );
  const pts = [];
  for (const [cx, cy, start] of [
    [w - r, r, -Math.PI / 2],
    [w - r, h - r, 0],
    [r, h - r, Math.PI / 2],
    [r, r, Math.PI],
  ])
    for (let i = 0; i <= steps; i++) {
      const a = start + (i * Math.PI) / 2 / steps,
        p = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
      // At the full radius, neighbouring arcs meet without a straight edge.
      if (!pts.length || !same(pts.at(-1), p)) pts.push(p);
    }
  if (same(pts[0], pts.at(-1))) pts.pop();
  return [...pts, { ...pts[0] }];
}
export function bounds(contours) {
  const ps = contours.flat();
  if (!ps.length) return { x: 0, y: 0, w: 1, h: 1 };
  let x = Infinity,
    y = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const p of ps) {
    x = Math.min(x, p.x);
    y = Math.min(y, p.y);
    x2 = Math.max(x2, p.x);
    y2 = Math.max(y2, p.y);
  }
  return { x, y, w: x2 - x, h: y2 - y };
}
function polygonArea(c) {
  return Math.abs(
    c.slice(1).reduce((sum, p, i) => sum + c[i].x * p.y - p.x * c[i].y, 0) / 2,
  );
}
function containsPoint(p, c) {
  let inside = false;
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1],
      b = c[i];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
export function contourTree(item) {
  const contours = worldContours(item).filter(
    (c) => c.length > 3 && same(c[0], c.at(-1)),
  );
  const areas = contours.map(polygonArea);
  return contours.map((points, index) => {
    let parent = -1;
    for (let j = 0; j < contours.length; j++)
      if (
        areas[j] > areas[index] + 1e-8 &&
        containsPoint(points[0], contours[j]) &&
        (parent < 0 || areas[j] < areas[parent])
      )
        parent = j;
    return { points, parent };
  });
}
export function crossesContour(points, bridge) {
  const runs = cutContour(points, [bridge]);
  return runs.length !== 1 || !same(runs[0][0], runs[0].at(-1));
}
function linked(child, parent, bridges) {
  return bridges.some(
    (b) => crossesContour(child, b) && crossesContour(parent, b),
  );
}
export function islandBridgeStatus(items) {
  let islands = 0,
    unbridgedIslands = 0;
  for (const item of items.filter((i) => i.type !== "bridge")) {
    const processed = stencilContours(
      item,
      items.filter((b) => b.type === "bridge"),
    );
    const tree = contourTree({
        ...item,
        x: 0,
        y: 0,
        rotation: 0,
        contours: processed,
      }),
      bridges = items.filter(
        (b) => b.type === "bridge" && (!b.targetId || b.targetId === item.id),
      );
    for (const node of tree)
      if (node.parent >= 0) {
        islands++;
        if (!linked(node.points, tree[node.parent].points, bridges))
          unbridgedIslands++;
      }
  }
  return { islands, unbridgedIslands };
}
function nearestConnection(a, b) {
  let best = { distance: Infinity };
  const project = (p, u, v) => {
    const dx = v.x - u.x,
      dy = v.y - u.y,
      length = dx * dx + dy * dy,
      t = length
        ? Math.max(
            0,
            Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / length),
          )
        : 0;
    return { x: u.x + t * dx, y: u.y + t * dy };
  };
  const consider = (p, q) => {
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.distance) best = { a: p, b: q, distance: d };
  };
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++) {
      consider(a[i - 1], project(a[i - 1], b[j - 1], b[j]));
      consider(project(b[j - 1], a[i - 1], a[i]), b[j - 1]);
    }
  return best;
}
// Size of the automatic bridges: `width` is the length of the gap left in
// the cut line (the thickness of the material strip), `height` how far the
// band extends across the cut line (overlap beyond the contours for stencil
// bridges, depth of the tab for holding bridges).
export const AUTO_BRIDGE_DEFAULTS = Object.freeze({ width: 1.5, height: 1.5 });
export const AUTO_BRIDGE_LIMITS = Object.freeze({ min: 0.2, max: 50 });
export function bridgeSize(size) {
  const clampMm = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(AUTO_BRIDGE_LIMITS.max, Math.max(AUTO_BRIDGE_LIMITS.min, n)) : fallback;
  };
  if (typeof size === "number") {
    const width = clampMm(size, AUTO_BRIDGE_DEFAULTS.width);
    return { width, height: width };
  }
  return {
    width: clampMm(size?.width, AUTO_BRIDGE_DEFAULTS.width),
    height: clampMm(size?.height, AUTO_BRIDGE_DEFAULTS.height),
  };
}
export function automaticBridges(items, size = AUTO_BRIDGE_DEFAULTS, targetIds = null) {
  const { width, height } = bridgeSize(size);
  const existing = items.filter((i) => i.type === "bridge"),
    added = [];
  for (const item of items.filter(
    (i) => i.type !== "bridge" && (!targetIds || targetIds.includes(i.id)),
  )) {
    const tree = contourTree(item),
      base = { targetId: item.id, layerId: item.layerId, type: "bridge" };
    const applicable = () =>
      [...existing, ...added].filter(
        (b) => !b.targetId || b.targetId === item.id,
      );
    // Use the glyph-local vertical direction so both bridges rotate with the letter.
    for (const node of tree) {
      if (node.parent < 0) continue;
      const parent = tree[node.parent].points;
      if (
        linked(
          node.points,
          parent,
          applicable().filter((b) => b.bridgeMode === "stencil"),
        )
      )
        continue;
      const local = node.points.map((p) => transform(p, item, true));
      const outer = parent.map((p) => transform(p, item, true));
      const box = bounds([local]);
      const x = box.x + box.w / 2;
      const crossings = (ps) =>
        ps
          .slice(1)
          .flatMap((b, i) => {
            const a = ps[i];
            return (a.x <= x && b.x > x) || (b.x <= x && a.x > x)
              ? [a.y + ((x - a.x) * (b.y - a.y)) / (b.x - a.x)]
              : [];
          })
          .sort((a, b) => a - b);
      const innerYs = crossings(local),
        outerYs = crossings(outer);
      const connections = [];
      if (innerYs.length >= 2) {
        const top = innerYs[0],
          bottom = innerYs.at(-1);
        const up = outerYs.filter((y) => y < top - 1e-7).at(-1),
          down = outerYs.find((y) => y > bottom + 1e-7);
        for (const pair of [
          [top, up],
          [bottom, down],
        ])
          if (Number.isFinite(pair[1])) {
            const a = transform({ x, y: pair[0] }, item),
              b = transform({ x, y: pair[1] }, item);
            connections.push({
              a,
              b,
              distance: Math.hypot(a.x - b.x, a.y - b.y),
            });
          }
      }
      if (!connections.length)
        connections.push(nearestConnection(node.points, parent));
      for (const connection of connections) {
        if (!Number.isFinite(connection.distance)) continue;
        const p = mid(connection.a, connection.b);
        added.push({
          ...base,
          x: p.x,
          y: p.y,
          // Along the connection: span both contours plus the overlap; across
          // it: the width of the strip that stays uncut.
          w: connection.distance + height,
          h: width,
          rotation:
            (Math.atan2(
              connection.b.y - connection.a.y,
              connection.b.x - connection.a.x,
            ) *
              180) /
            Math.PI,
          name: "切り抜きブリッジ",
          bridgeMode: "stencil",
        });
      }
    }
    // Simple closed shapes without an inner loop still get a holding tab.
    for (const node of tree) {
      if (
        item.type === "text" ||
        item.type === "outline" ||
        node.parent >= 0 ||
        applicable().some((b) => crossesContour(node.points, b))
      )
        continue;
      const ps = node.points;
      let longest = -1,
        index = 1;
      for (let i = 1; i < ps.length; i++) {
        const d = Math.hypot(ps[i].x - ps[i - 1].x, ps[i].y - ps[i - 1].y);
        if (d > longest) {
          longest = d;
          index = i;
        }
      }
      const p = mid(ps[index - 1], ps[index]),
        a = ps[index - 1],
        b = ps[index];
      // Tab aligned with the segment: `width` along the cut line, `height`
      // across it (centred on the line, so height/2 on each side).
      added.push({
        ...base,
        x: p.x,
        y: p.y,
        w: width,
        h: height,
        rotation: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
        name: "自動ブリッジ",
        bridgeMode: "holding",
      });
    }
  }
  return added;
}
