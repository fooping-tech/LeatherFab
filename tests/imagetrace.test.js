import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import { otsu, binarize, traceLoops, imageShapes, traceSize, isImageFile } from "../src/imagetrace.js";
import { makeShapingFont, layoutText } from "../src/typography.js";
import { pathContours, transformPath } from "../src/path.js";
import { bounds } from "../src/geometry.js";
import { signedArea, containsPoint } from "../src/polygon.js";
import { shapeItem } from "../src/svgimport.js";
import { stampGeometry } from "../src/stamp.js";

// RGBA image from a predicate (true = black) or a grey level function.
const image = (w, h, f, alpha = () => 255) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = f(x, y),
        g = typeof v === "number" ? v : v ? 0 : 255;
      data.set([g, g, g, alpha(x, y)], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
};
const area = (path) => pathContours(path).reduce((n, c) => n + signedArea(c), 0);
const ring = image(60, 60, (x, y) => x >= 10 && x < 50 && y >= 10 && y < 50 && !(x >= 20 && x < 40 && y >= 20 && y < 40));

test("automatic threshold splits dark from light", () => {
  assert.equal(otsu(new Uint8ClampedArray([0, 0, 255, 255])), 128);
  const t = otsu(new Uint8ClampedArray([40, 45, 50, 190, 200, 210]));
  assert.ok(t > 50 && t <= 190, `${t}`);
  assert.equal(binarize(ring).threshold, 128);
});

test("transparent pixels are background; invert makes light pixels the shape", () => {
  const img = image(4, 1, (x) => x < 2, (x) => (x === 0 ? 0 : 255));
  assert.deepEqual([...binarize(img, { threshold: 128 }).ink], [0, 1, 0, 0]);
  assert.deepEqual([...binarize(img, { threshold: 128, invert: true }).ink], [1, 0, 1, 1]);
});

test("pixel borders become exact loops: outer and hole turn opposite ways", () => {
  const loops = traceLoops(binarize(ring));
  assert.deepEqual(loops.map((l) => signedArea(l)).sort((a, b) => b - a), [1600, -400]);
  // Only the four corners (plus the repeated start) of each square.
  assert.deepEqual(loops.map((l) => l.length), [5, 5]);
  // Pixels touching only at a corner stay separate shapes.
  const diag = image(4, 4, (x, y) => (x === 1 && y === 1) || (x === 2 && y === 2));
  assert.equal(traceLoops(binarize(diag)).length, 2);
  // Ink on the image border is closed along the border.
  const full = image(3, 2, () => true);
  assert.deepEqual(traceLoops(binarize(full)).map(signedArea), [6]);
});

test("a square with a hole traces into one shape with sharp corners kept", () => {
  const { shapes, dropped } = imageShapes(ring);
  assert.equal(dropped, 0);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].path.length, 2);
  assert.deepEqual(shapes[0].path.map((s) => s.nodes.length), [4, 4]);
  assert.deepEqual(bounds(pathContours(shapes[0].path)), { x: 10, y: 10, w: 40, h: 40 });
  assert.ok(Math.abs(area(shapes[0].path) - 1200) < 1);
});

test("round shapes become smooth curves close to the original area", () => {
  const disc = image(120, 120, (x, y) => Math.hypot(x + 0.5 - 60, y + 0.5 - 60) < 40);
  const { shapes } = imageShapes(disc);
  assert.equal(shapes.length, 1);
  const nodes = shapes[0].path[0].nodes;
  assert.ok(nodes.length <= 12, `${nodes.length} nodes`);
  assert.ok(nodes.every((n) => n.in && n.out), "all nodes are curve nodes");
  const a = area(shapes[0].path);
  assert.ok(Math.abs(a - Math.PI * 1600) / (Math.PI * 1600) < 0.02, `${a}`);
});

test("specks below the minimum area are dropped and counted; an empty image has no shapes", () => {
  const specks = image(50, 50, (x, y) => (x >= 5 && x < 25 && y >= 5 && y < 25) || (x === 40 && y === 40) || (x === 44 && y === 10));
  const r = imageShapes(specks, { minArea: 6 });
  assert.equal(r.shapes.length, 1);
  assert.equal(r.dropped, 2);
  assert.equal(imageShapes(image(10, 10, () => false)).shapes.length, 0);
  // Inverted, the white surroundings become a frame with a hole.
  const inv = imageShapes(image(30, 30, (x, y) => x >= 10 && x < 20 && y >= 10 && y < 20), { invert: true });
  assert.equal(inv.shapes.length, 1);
  assert.equal(inv.shapes[0].path.length, 2);
});

test("small dots keep their exact pixel outline", () => {
  const dot = imageShapes(image(20, 20, (x, y) => x >= 8 && x < 11 && y >= 8 && y < 11), { minArea: 0 });
  assert.equal(dot.shapes.length, 1);
  assert.ok(Math.abs(area(dot.shapes[0].path) - 9) < 1e-6);
});

test("too many shapes are refused with a hint", () => {
  const dots = image(400, 400, (x, y) => x % 8 < 5 && y % 8 < 5);
  assert.throws(() => imageShapes(dots, { minArea: 0 }), /図形が多すぎます/);
});

test("trace size: large images scale down, small ones up (at most 8×)", () => {
  assert.deepEqual(traceSize(2400, 1200), { width: 1200, height: 600, k: 0.5 });
  assert.deepEqual(traceSize(100, 50), { width: 400, height: 200, k: 4 });
  assert.deepEqual(traceSize(20, 10), { width: 160, height: 80, k: 8 });
  assert.equal(traceSize(800, 600).k, 1);
});

test("file types: PNG, JPEG and GIF by type or extension", () => {
  for (const f of [
    { name: "a.png", type: "image/png" },
    { name: "a.JPG", type: "" },
    { name: "a.jpeg", type: "" },
    { name: "x", type: "image/gif" },
  ])
    assert.ok(isImageFile(f), f.name);
  assert.ok(!isImageFile({ name: "a.svg", type: "image/svg+xml" }));
  assert.ok(!isImageFile({ name: "a.webp", type: "image/webp" }));
});

for (const file of ["ZenKakuGothicNew-Regular.ttf", "ShipporiMincho-Regular.ttf"])
  test(`${file}: a rasterised character traces back to its outline`, () => {
    const raw = fs.readFileSync(new URL(`../public/fonts/${file}`, import.meta.url)),
      bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
      contours = layoutText({ text: "永", size: 180, spacing: 0, vertical: false }, opentype.parse(bytes), makeShapingFont(bytes)),
      b = bounds(contours),
      w = Math.ceil(b.w) + 20,
      h = Math.ceil(b.h) + 20;
    // Even–odd scan of the outline at pixel centres.
    const img = image(w, h, (x, y) => {
      const p = { x: x + 0.5 + b.x - 10, y: y + 0.5 + b.y - 10 };
      return contours.filter((c) => containsPoint(p, c)).length % 2 === 1;
    });
    const { shapes } = imageShapes(img),
      glyphArea = Math.abs(contours.reduce((n, c) => n + signedArea(c), 0)),
      traced = shapes.reduce((n, s) => n + Math.abs(area(s.path)), 0);
    assert.ok(shapes.length >= 1);
    assert.ok(Math.abs(traced - glyphArea) / glyphArea < 0.03, `${traced} vs ${glyphArea}`);
    const tb = bounds(shapes.flatMap((s) => pathContours(s.path)));
    assert.ok(Math.abs(tb.w - b.w) < 1.5 && Math.abs(tb.h - b.h) < 1.5);
    // The traced shapes work as stamp ink.
    const items = shapes.map((s, n) => shapeItem({ ...s, path: transformPath(s.path, (p) => ({ x: p.x / 10, y: p.y / 10 })) }, `t${n}`, "l"));
    const g = stampGeometry(items, { width: w / 10, height: h / 10, boldOffset: 0 });
    assert.ok(Math.abs(g.inkArea - glyphArea / 100) / (glyphArea / 100) < 0.04);
  });
