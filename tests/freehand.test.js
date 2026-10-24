import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resample,
  findCorners,
  smoothRun,
  closure,
  freehandPath,
  freehandItem,
  strokeLength,
  strokeScale,
  FREEHAND_DEFAULTS,
  DEFAULT_UNIT,
} from "../src/freehand.js";
// Default scale: a desktop at fit zoom (0.25 mm per screen pixel).
const S = strokeScale({}),
  SPACING = S.spacing,
  WINDOW = S.window;
import { fitStroke, pathContours, nodeKeys, toPathData } from "../src/path.js";
import { bounds, cutGeometry, exportSVG } from "../src/geometry.js";
import { validateProject } from "../src/project.js";
import { ensureLayers } from "../src/layers.js";

// Deterministic jitter, like a hand on a touch screen.
const noise = (seed) => {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
};
const jitter = (points, amount, seed = 1) => {
  const r = noise(seed);
  return points.map((p) => ({ x: p.x + r() * amount, y: p.y + r() * amount }));
};
const circle = (cx, cy, r, n, from = 0, to = 2 * Math.PI) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
const line = (a, b, n) =>
  Array.from({ length: n + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / n,
    y: a.y + ((b.y - a.y) * i) / n,
  }));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// Largest distance from the samples to the fitted polyline.
const deviation = (samples, contour) =>
  Math.max(
    ...samples.map((p) =>
      Math.min(
        ...contour.slice(1).map((b, i) => {
          const a = contour[i],
            dx = b.x - a.x,
            dy = b.y - a.y,
            l = dx * dx + dy * dy,
            t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
          return dist(p, { x: a.x + dx * t, y: a.y + dy * t });
        }),
      ),
    ),
  );

test("resample spaces points evenly regardless of the input rate", () => {
  const sparse = resample(line({ x: 0, y: 0 }, { x: 10, y: 0 }, 2), SPACING),
    dense = resample(line({ x: 0, y: 0 }, { x: 10, y: 0 }, 400), SPACING);
  assert.equal(sparse.length, dense.length);
  for (let i = 1; i < sparse.length - 1; i++)
    assert.ok(Math.abs(dist(sparse[i - 1], sparse[i]) - SPACING) < 1e-9);
  assert.deepEqual(sparse.at(-1), { x: 10, y: 0 });
  assert.deepEqual(resample([{ x: 1, y: 1 }, { x: 1, y: 1 }], SPACING), [{ x: 1, y: 1 }]);
  assert.deepEqual(resample([{ x: NaN, y: 0 }], SPACING), []);
  assert.equal(S.unit, DEFAULT_UNIT);
  assert.equal(SPACING, 0.125);
});

test("smoothing removes jitter and keeps the ends", () => {
  const straight = line({ x: 0, y: 0 }, { x: 40, y: 0 }, 160),
    rough = jitter(straight, 0.4),
    smooth = smoothRun(rough, 1, { spacing: 0.25 });
  assert.deepEqual(smooth[0], rough[0]);
  assert.deepEqual(smooth.at(-1), rough.at(-1));
  const spread = (pts) => Math.max(...pts.slice(5, -5).map((p) => Math.abs(p.y)));
  assert.ok(spread(rough) > 0.12, `rough ${spread(rough)}`);
  assert.ok(spread(smooth) < spread(rough) / 2, `smooth ${spread(smooth)}`);
  assert.deepEqual(smoothRun(rough, 0, { spacing: 0.25 }), rough);
});

test("corners are found on an L, not on a circle, and once per corner", () => {
  const opts = { spacing: SPACING, window: WINDOW };
  const l = resample(
    [
      ...line({ x: 0, y: 0 }, { x: 20, y: 0 }, 40),
      ...line({ x: 20, y: 0 }, { x: 20, y: 15 }, 30).slice(1),
    ],
    SPACING,
  );
  const corners = findCorners(l, opts);
  assert.equal(corners.length, 1);
  assert.ok(dist(l[corners[0]], { x: 20, y: 0 }) < 0.3);
  assert.deepEqual(findCorners(resample(circle(0, 0, 10, 200), SPACING), { ...opts, closed: true }), []);
  // A tight loop of 1.5 mm radius is a curve, not a corner.
  assert.deepEqual(findCorners(resample(circle(0, 0, 1.5, 100), SPACING), { ...opts, closed: true }), []);
  // Noisy hand-drawn triangle: three corners, one per vertex.
  const tri = [
    ...line({ x: 0, y: 0 }, { x: 30, y: 0 }, 60),
    ...line({ x: 30, y: 0 }, { x: 15, y: 25 }, 60).slice(1),
    ...line({ x: 15, y: 25 }, { x: 0, y: 0 }, 60).slice(1),
  ];
  const pts = smoothRun(resample(jitter(tri, 0.15, 7), SPACING).slice(0, -1), S.probe, { closed: true, spacing: SPACING }),
    found = findCorners(pts, { ...opts, closed: true });
  assert.equal(found.length, 3, JSON.stringify(found));
});

test("a stroke ending near its start closes; overshoot is trimmed", () => {
  const opts = { spacing: SPACING };
  const open = resample(circle(0, 0, 10, 100, 0, Math.PI), SPACING);
  assert.equal(closure(open, opts), null);
  const almost = resample(circle(0, 0, 10, 100, 0, 2 * Math.PI - 0.2), SPACING);
  const loop = closure(almost, opts);
  assert.ok(loop && loop[0] === 0 && loop[1] === almost.length - 1);
  // Drawn past the start by a quarter turn: the loop starts where the tail meets the head.
  const over = resample(circle(0, 0, 10, 130, 0, 2 * Math.PI + Math.PI / 2), SPACING);
  const cut = closure(over, opts);
  assert.ok(cut);
  assert.ok(dist(over[cut[0]], over[cut[1]]) < 0.3);
  assert.ok(cut[0] > 0 || cut[1] < over.length - 1);
  // Short scribbles never close on themselves.
  assert.equal(closure(resample(line({ x: 0, y: 0 }, { x: 3, y: 0 }, 10), SPACING), opts), null);
  // The closing gap scales with the screen: at 1 mm per pixel a 6 mm gap closes.
  const wide = resample(circle(0, 0, 40, 100, 0, 2 * Math.PI - 0.15), 0.5);
  assert.equal(closure(wide, { spacing: 0.5, unit: 0.05 }), null);
  assert.ok(closure(wide, { spacing: 0.5, unit: 1 }));
});

test("a jittery circle becomes a closed path of few smooth nodes within tolerance", () => {
  const drawn = jitter(circle(50, 40, 20, 240, 0, 2 * Math.PI - 0.05), 0.25, 3),
    fit = freehandPath(drawn);
  assert.ok(fit && fit.closed);
  assert.equal(fit.corners, 0);
  const [sub] = fit.path;
  assert.ok(sub.closed);
  assert.ok(sub.nodes.length <= 12, `nodes ${sub.nodes.length}`);
  assert.ok(sub.nodes.every((n) => n.smooth));
  const contour = pathContours(fit.path)[0];
  const rr = contour.map((p) => dist(p, { x: 50, y: 40 }));
  assert.ok(Math.max(...rr) < 20.5 && Math.min(...rr) > 19.5, `radius ${Math.min(...rr)}–${Math.max(...rr)}`);
});

test("a hand-drawn rectangle keeps four corner nodes and straight sides", () => {
  const rect = [
    ...line({ x: 0, y: 0 }, { x: 40, y: 0 }, 80),
    ...line({ x: 40, y: 0 }, { x: 40, y: 25 }, 50).slice(1),
    ...line({ x: 40, y: 25 }, { x: 0, y: 25 }, 80).slice(1),
    ...line({ x: 0, y: 25 }, { x: 0, y: 1.2 }, 48).slice(1),
  ];
  const fit = freehandPath(jitter(rect, 0.2, 11));
  assert.ok(fit?.closed);
  assert.equal(fit.corners, 4);
  const nodes = fit.path[0].nodes,
    cornerNodes = nodes.filter((n) => !n.smooth);
  assert.ok(cornerNodes.length >= 4, `corners ${cornerNodes.length}`);
  for (const c of [[0, 0], [40, 0], [40, 25], [0, 25]])
    assert.ok(nodes.some((n) => dist(n, { x: c[0], y: c[1] }) < 0.5), `corner ${c}`);
  const box = bounds(pathContours(fit.path));
  assert.ok(Math.abs(box.w - 40) < 0.6 && Math.abs(box.h - 25) < 0.6);
});

test("an open stroke stays an open line and follows the drawing", () => {
  const s = Array.from({ length: 201 }, (_, i) => ({ x: i / 4, y: 10 * Math.sin(i / 20) })),
    fit = freehandPath(jitter(s, 0.1, 5));
  assert.ok(fit && !fit.closed);
  assert.ok(!fit.path[0].closed);
  const contour = pathContours(fit.path)[0];
  assert.ok(deviation(resample(s, SPACING), contour) < 0.35);
  assert.ok(dist(contour[0], s[0]) < 0.3 && dist(contour.at(-1), s.at(-1)) < 0.3);
  assert.ok(fit.path[0].nodes.length < 25, `nodes ${fit.path[0].nodes.length}`);
});

test("more smoothing means fewer nodes; taps and dots are ignored", () => {
  const s = jitter(
    Array.from({ length: 161 }, (_, i) => ({ x: i / 4, y: 6 * Math.sin(i / 12) })),
    0.3,
    9,
  );
  const rough = freehandPath(s, { smoothing: 0 }),
    smooth = freehandPath(s, { smoothing: 8 });
  assert.ok(nodeKeys(smooth.path).length < nodeKeys(rough.path).length);
  assert.equal(freehandPath([{ x: 1, y: 1 }]), null);
  assert.equal(freehandPath([{ x: 1, y: 1 }, { x: 1.4, y: 1.2 }]), null);
  assert.equal(freehandPath([]), null);
  assert.equal(freehandPath(circle(0, 0, 10, 50), { autoClose: false }).closed, false);
  assert.equal(FREEHAND_DEFAULTS.smoothing, 3);
  // The same stroke drawn zoomed out (more mm per pixel) is smoothed more.
  const zoomedOut = freehandPath(s, { unit: 1 });
  assert.ok(nodeKeys(zoomedOut.path).length < nodeKeys(freehandPath(s, { unit: 0.1 }).path).length);
});

test("fitStroke honours forced corners and closure", () => {
  const pts = resample(
    [
      ...line({ x: 0, y: 0 }, { x: 10, y: 0 }, 20),
      ...line({ x: 10, y: 0 }, { x: 10, y: 10 }, 20).slice(1),
      ...line({ x: 10, y: 10 }, { x: 0, y: 10 }, 20).slice(1),
      ...line({ x: 0, y: 10 }, { x: 0, y: 0.5 }, 19).slice(1),
    ],
    SPACING,
  );
  const corners = findCorners(pts, { closed: true, spacing: SPACING, window: WINDOW });
  const path = fitStroke(pts, { closed: true, corners, error: 0.1 });
  assert.equal(path.length, 1);
  assert.ok(path[0].closed);
  assert.equal(path[0].nodes.length, 4);
  assert.match(toPathData(path), /^M[^C]*Z$/); // straight sides, no curves
  assert.deepEqual(fitStroke([{ x: 0, y: 0 }], { closed: false }), []);
});

test("freehand items are valid fixed paths that cut and export", () => {
  const drawn = jitter(circle(30, 30, 12, 200, 0, 2 * Math.PI - 0.1), 0.2, 4),
    made = freehandItem(drawn, {}, { id: "f1", layerId: "layer-default" });
  assert.ok(made.closed);
  const { item } = made;
  assert.equal(item.type, "outline");
  assert.equal(item.name, "フリーハンド");
  assert.ok(Math.abs(item.x - 18) < 0.5 && Math.abs(item.y - 18) < 0.5);
  const box = bounds(item.contours);
  assert.ok(Math.abs(box.x) < 1e-9 && Math.abs(box.y) < 1e-9);
  const project = ensureLayers({ version: 2, name: "t", width: 100, height: 100, items: [item] });
  validateProject(JSON.parse(JSON.stringify(project)));
  const cut = cutGeometry(project.items);
  assert.equal(cut.closed, 1);
  assert.match(exportSVG(project), /<path/);
  const openItem = freehandItem(line({ x: 5, y: 5 }, { x: 25, y: 9 }, 30), {}, { id: "f2", layerId: "layer-default" });
  assert.equal(openItem.closed, false);
  assert.equal(openItem.item.name, "フリーハンド（線）");
  assert.equal(freehandItem([{ x: 0, y: 0 }], {}, { id: "f3", layerId: "layer-default" }), null);
  assert.ok(strokeLength(line({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)) - 5 < 1e-9);
});
