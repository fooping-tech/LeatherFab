import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import { shapeContours, bounds } from "../src/geometry.js";
import { makeShapingFont, layoutText } from "../src/typography.js";
import { validateProject } from "../src/project.js";
import { signedArea } from "../src/polygon.js";
import {
  stampGeometry,
  stampSVG,
  stampPreviewSVG,
  stampOptions,
  normalizeStamp,
  mirrorContours,
  fitTransform,
  fabricationMode,
  STAMP_DEFAULTS,
  PASS_COLORS,
  passShades,
  crc32,
  withPhysicalSize,
} from "../src/stamp.js";
import { containsPoint } from "../src/polygon.js";

const near = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const rect = (id, x, y, w, h, extra = {}) => ({
  id,
  type: "rect",
  x,
  y,
  w,
  h,
  rotation: 0,
  contours: shapeContours("rect", w, h),
  ...extra,
});
const face = { width: 60, height: 20 };
const area = (contours) => contours.reduce((n, c) => n + signedArea(c), 0);
const xs = (contours) => contours.flat().map((p) => p.x);

test("negative stamp: the face minus the ink is engraved, the ink is raised", () => {
  const g = stampGeometry([rect("a", 20, 5, 20, 10)], { ...face, boldOffset: 0 });
  near(g.faceArea, 1200);
  near(g.inkArea, 200);
  near(Math.abs(area(g.engrave)), 1000);
  near(Math.abs(area(g.raised)), 200);
  assert.equal(g.empty, false);
  assert.equal(g.outsideFace, false);
  assert.equal(g.outsideMargin, false);
});

test("positive stamp engraves the characters themselves", () => {
  const g = stampGeometry([rect("a", 20, 5, 20, 10)], {
    ...face,
    boldOffset: 0,
    engravingMode: "positive",
  });
  near(Math.abs(area(g.engrave)), 200);
  near(Math.abs(area(g.raised)), 1000);
});

test("bold offset grows the ink outline (round joins) and a negative one thins it", () => {
  const grown = stampGeometry([rect("a", 20, 5, 20, 10)], { ...face, boldOffset: 0.2 });
  near(grown.inkArea, 200 + 0.2 * 60 + Math.PI * 0.04, 0.05);
  const thin = stampGeometry([rect("a", 20, 5, 20, 10)], { ...face, boldOffset: -0.3 });
  near(thin.inkArea, 19.4 * 9.4, 0.05);
  const gone = stampGeometry([rect("a", 20, 5, 0.6, 10)], { ...face, boldOffset: -0.5 });
  assert.equal(gone.vanished, true);
  assert.throws(() => stampSVG([rect("a", 20, 5, 0.6, 10)], { ...face, boldOffset: -0.5 }), /太さ補正で文字が消えました/);
});

test("the export is mirrored left to right by default, and not when switched off", () => {
  const ink = [rect("a", 5, 5, 10, 10)];
  const g = stampGeometry(ink, { ...face, boldOffset: 0 });
  const mirrored = mirrorContours(g.engrave, 60);
  // The hole left by the ink moves from x 5–15 to x 45–55.
  const hole = (contours) =>
    contours.filter((c) => Math.abs(signedArea(c)) < 1000).flatMap((c) => c.map((p) => p.x));
  near(Math.min(...hole(g.engrave)), 5);
  near(Math.max(...hole(g.engrave)), 15);
  near(Math.min(...hole(mirrored)), 45);
  near(Math.max(...hole(mirrored)), 55);
  // Orientation is kept, so outer contours and holes keep their signs.
  assert.deepEqual(
    mirrored.map((c) => Math.sign(signedArea(c))),
    g.engrave.map((c) => Math.sign(signedArea(c))),
  );
  const on = stampSVG(ink, { ...face, boldOffset: 0 }),
    off = stampSVG(ink, { ...face, boldOffset: 0, mirror: false });
  assert.match(on, /M45 5|L45 5|M55 5|L55 5/);
  assert.doesNotMatch(on, /[ML]5 5 /);
  assert.match(off, /[ML]5 5 /);
  assert.match(on, /Mirrored left to right/);
  assert.match(off, /Not mirrored/);
});

test("SVG: mm units, viewBox, ENGRAVE and CUT layers, paths only, GUIDE only on request", () => {
  const svg = stampSVG([rect("a", 20, 5, 20, 10)], face);
  assert.match(svg, /width="60mm" height="20mm" viewBox="0 0 60 20"/);
  assert.match(svg, /<g id="ENGRAVE" inkscape:groupmode="layer" inkscape:label="ENGRAVE"><path d="[^"]+" fill="#000000" fill-rule="evenodd" stroke="none"\/><\/g>/);
  assert.match(svg, /<g id="CUT" inkscape:groupmode="layer" inkscape:label="CUT"><path d="[^"]+" fill="none" stroke="#ff0000" stroke-width="0.1"\/><\/g>/);
  assert.doesNotMatch(svg, /GUIDE"/);
  assert.doesNotMatch(svg, /<(text|mask|clipPath|image|use)\b/);
  assert.doesNotMatch(svg, /\b(mask|clip-path|transform)=/);
  const guided = stampSVG([rect("a", 20, 5, 20, 10)], { ...face, guide: true });
  assert.match(guided, /<g id="GUIDE"[^>]*><path d="[^"]+" fill="none" stroke="#0000ff"/);
  // ENGRAVE comes before CUT so the engraving runs before the piece is freed.
  assert.ok(guided.indexOf('id="ENGRAVE"') < guided.indexOf('id="CUT"'));
  assert.ok(guided.indexOf('id="CUT"') < guided.indexOf('id="GUIDE"'));
});

test("face shapes: rectangle, rounded rectangle and circle", () => {
  const ink = [rect("a", 20, 15, 10, 10)];
  const square = { width: 50, height: 50, boldOffset: 0 };
  const r = stampGeometry(ink, { ...square, shape: "rectangle" }),
    rounded = stampGeometry(ink, { ...square, shape: "rounded-rectangle", cornerRadius: 5 }),
    circle = stampGeometry(ink, { ...square, shape: "circle" });
  near(r.faceArea, 2500);
  // Chords of the flattened arcs (0.02 mm tolerance) cut a little area off.
  near(rounded.faceArea, 2500 - (4 - Math.PI) * 25, 0.6);
  near(circle.faceArea, Math.PI * 625, 3);
  // The cut outline of a circle stays within the face.
  const b = bounds(circle.base);
  near(b.w, 50, 0.01);
  near(b.h, 50, 0.01);
});

test("ink outside the margin or the face is reported; outside the face is not engraved", () => {
  const margin = stampGeometry([rect("a", 1, 5, 10, 10)], { ...face, boldOffset: 0 });
  assert.equal(margin.outsideMargin, true);
  assert.equal(margin.outsideFace, false);
  const out = stampGeometry([rect("a", -5, 5, 10, 10)], { ...face, boldOffset: 0 });
  assert.equal(out.outsideFace, true);
  near(out.inkArea, 50);
  assert.ok(Math.min(...xs(out.engrave)) >= -1e-6);
});

test("open lines and bridges are skipped and counted; an empty face cannot be exported", () => {
  const line = { id: "l", type: "line", x: 5, y: 5, w: 30, h: 0, rotation: 0, contours: shapeContours("line", 30, 0) },
    bridge = { id: "b", type: "bridge", x: 10, y: 10, w: 4, h: 1.5, rotation: 0 };
  const g = stampGeometry([line, bridge], face);
  assert.equal(g.empty, true);
  assert.equal(g.open, 1);
  assert.equal(g.bridges, 1);
  assert.throws(() => stampSVG([line, bridge], face), /印面に文字や図形がありません/);
});

test("each item keeps its own counters: overlapping items union without cancelling holes", () => {
  // A frame (outer 40×16 with a 36×12 hole, opposite windings) and a bar
  // inside the hole: the bar is ink, the rest of the hole is engraved.
  const outer = [
      { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 16 }, { x: 0, y: 16 }, { x: 0, y: 0 },
    ],
    hole = [
      { x: 2, y: 2 }, { x: 2, y: 14 }, { x: 38, y: 14 }, { x: 38, y: 2 }, { x: 2, y: 2 },
    ];
  const frame = { id: "f", type: "outline", x: 10, y: 2, rotation: 0, contours: [outer, hole] },
    bar = rect("b", 20, 8, 20, 4);
  const g = stampGeometry([frame, bar], { ...face, boldOffset: 0 });
  near(g.inkArea, 40 * 16 - 36 * 12 + 80);
  near(Math.abs(area(g.engrave)), 1200 - (40 * 16 - 36 * 12 + 80));
});

for (const file of ["ZenKakuGothicNew-Regular.ttf", "ShipporiMincho-Regular.ttf"])
  test(`${file}: text becomes raised ink with its counters engraved`, () => {
    const raw = fs.readFileSync(new URL(`../public/fonts/${file}`, import.meta.url)),
      bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
      font = opentype.parse(bytes),
      shaping = makeShapingFont(bytes);
    const text = { id: "t", type: "text", text: "口", size: 14, spacing: 0, vertical: false, rotation: 0 };
    text.contours = layoutText(text, font, shaping);
    const b = bounds(text.contours);
    text.x = 4 - b.x;
    text.y = 3 - b.y;
    const plain = stampGeometry([text], { width: 20, height: 20, boldOffset: 0 }),
      bold = stampGeometry([text], { width: 20, height: 20, boldOffset: 0.2 });
    // Face, the outside of 口 (a hole in the engraving) and its counter.
    assert.ok(plain.engrave.length >= 3, `${plain.engrave.length} contours`);
    assert.ok(plain.raised.length >= 2);
    assert.ok(plain.inkArea > 10 && plain.inkArea < b.w * b.h);
    assert.ok(bold.inkArea > plain.inkArea + 0.2);
    const svg = stampSVG([text], { width: 20, height: 20 });
    assert.doesNotMatch(svg, /<text\b/);
    // The mirrored 口 sits at x 16 − width … 16 instead of 4 … 4 + width.
    const mirrored = stampGeometry([text], { width: 20, height: 20, boldOffset: 0 });
    const holeXs = mirrorContours(mirrored.engrave, 20)
      .filter((c) => Math.abs(signedArea(c)) < 300)
      .flatMap((c) => c.map((p) => p.x));
    near(Math.max(...holeXs), 16, 0.05);
    near(Math.min(...holeXs), 16 - b.w, 0.05);
  });

test("previews: laser data mirrored, the impression the right way round", () => {
  const g = stampGeometry([rect("a", 5, 5, 10, 10)], { ...face, boldOffset: 0 });
  const laser = stampPreviewSVG(g, "laser"),
    print = stampPreviewSVG(g, "print");
  assert.match(laser, /[ML]45 5/);
  assert.match(print, /[ML]5 5/);
  assert.doesNotMatch(print, /[ML]45 5/);
  assert.match(print, /#c8332b/);
});

test("fit: content scales into the margin box, or inside the inner ellipse for a circle", () => {
  const box = { x: 0, y: 0, w: 100, h: 10 };
  const r = fitTransform(box, { width: 60, height: 20, margin: 2, boldOffset: 0 });
  near(r.k, 0.56, 1e-9);
  assert.deepEqual(r.to, { x: 30, y: 10 });
  assert.deepEqual(r.from, { x: 50, y: 5 });
  // A positive bold offset is kept inside the margin as well.
  near(fitTransform(box, { width: 60, height: 20, margin: 2, boldOffset: 0.5 }).k, 0.55, 1e-9);
  const c = fitTransform({ x: 0, y: 0, w: 10, h: 10 }, { width: 30, height: 30, margin: 1, shape: "circle", boldOffset: 0 });
  // The scaled box's corner lies on the inner ellipse (radius 14).
  near(Math.hypot(5 * c.k, 5 * c.k), 14, 1e-9);
});

test("settings: defaults, validation and project files", () => {
  assert.deepEqual(normalizeStamp({}), { ...STAMP_DEFAULTS });
  assert.equal(STAMP_DEFAULTS.mirror, true);
  assert.equal(STAMP_DEFAULTS.engravingMode, "negative");
  assert.deepEqual(normalizeStamp({ shape: "circle", boldOffset: 0.3, extra: 1 }), {
    ...STAMP_DEFAULTS,
    shape: "circle",
    boldOffset: 0.3,
  });
  for (const bad of [
    { shape: "star" },
    { mirror: "yes" },
    { engravingMode: "both" },
    { margin: -1 },
    { boldOffset: 5 },
    { cornerRadius: Number.NaN },
    [],
    null,
  ])
    assert.throws(() => normalizeStamp(bad), /ハンコ設定が不正です/);
  const base = { version: 2, name: "印", width: 60, height: 20, items: [], layers: [{ id: "l", name: "L", visible: true, locked: false }] };
  // Older projects are cut projects and stay without stamp fields.
  const old = validateProject(structuredClone(base));
  assert.equal(fabricationMode(old), "cut");
  assert.ok(!("fabrication" in old) && !("stamp" in old));
  const saved = validateProject({ ...structuredClone(base), fabrication: "stamp", stamp: { shape: "rounded-rectangle", boldOffset: 0.2 } });
  assert.equal(fabricationMode(saved), "stamp");
  assert.equal(saved.stamp.shape, "rounded-rectangle");
  assert.equal(saved.stamp.mirror, true);
  assert.deepEqual(stampOptions(saved), { ...saved.stamp, width: 60, height: 20 });
  // Stamp settings survive switching back to cutting.
  const cut = validateProject({ ...structuredClone(base), fabrication: "cut", stamp: { margin: 3 } });
  assert.equal(fabricationMode(cut), "cut");
  assert.equal(cut.stamp.margin, 3);
  assert.throws(() => validateProject({ ...structuredClone(base), fabrication: "engrave" }), /加工の種類が不正です/);
  assert.throws(() => validateProject({ ...structuredClone(base), stamp: { shape: "star" } }), /ハンコ設定が不正です/);
});

// Even–odd containment in a set of contours.
const inside = (p, contours) => contours.filter((c) => containsPoint(p, c)).length % 2 === 1;

test("shoulder: engraving passes step down away from the ink", () => {
  const ink = [rect("a", 20, 5, 20, 10)],
    g = stampGeometry(ink, { ...face, boldOffset: 0, shoulderWidth: 1, shoulderLevels: 4 });
  assert.equal(g.shoulder, true);
  assert.equal(g.passes.length, 4);
  // Pass k engraves the face minus the ink grown by k × 0.25 mm.
  g.passes.forEach((pass, k) => {
    const d = 0.25 * k;
    near(Math.abs(area(pass)), 1200 - (200 + 60 * d + Math.PI * d * d), 0.2);
  });
  near(Math.abs(area(g.passes[0])), Math.abs(area(g.engrave)));
  // Number of passes (depth in steps) at increasing distance from the ink.
  const depth = (x) => g.passes.filter((p) => inside({ x, y: 10 }, p)).length;
  assert.deepEqual([40.1, 40.3, 40.6, 40.9, 41.5, 50].map(depth), [1, 2, 3, 4, 4, 4]);
  assert.equal(depth(30), 0); // the ink itself
  // The top of the characters (what prints) does not change.
  near(g.inkArea, 200);
});

test("shoulder SVG: one coloured ENGRAVE-k layer per pass; off or positive keeps one ENGRAVE", () => {
  const ink = [rect("a", 20, 5, 20, 10)];
  const svg = stampSVG(ink, { ...face, shoulderWidth: 0.5, shoulderLevels: 3 });
  for (const k of [1, 2, 3])
    assert.match(svg, new RegExp(`<g id="ENGRAVE-${k}" inkscape:groupmode="layer" inkscape:label="ENGRAVE-${k}"><path d="[^"]+" fill="${PASS_COLORS[k - 1]}" fill-rule="evenodd" stroke="none"/></g>`));
  assert.doesNotMatch(svg, /id="ENGRAVE"/);
  assert.match(svg, /Shoulder: 0.5 mm in 3 steps/);
  assert.ok(svg.indexOf('id="ENGRAVE-3"') < svg.indexOf('id="CUT"'));
  assert.equal(new Set(PASS_COLORS).size, PASS_COLORS.length);
  assert.ok(!PASS_COLORS.includes("#ff0000") && !PASS_COLORS.includes("#0000ff"));
  assert.match(stampSVG(ink, face), /id="ENGRAVE"/);
  const positive = stampGeometry(ink, { ...face, engravingMode: "positive", shoulderWidth: 1 });
  assert.equal(positive.shoulder, false);
  assert.equal(positive.passes.length, 1);
  assert.match(stampSVG(ink, { ...face, engravingMode: "positive", shoulderWidth: 1 }), /id="ENGRAVE"/);
});

test("shoulder settings are validated; older projects have none", () => {
  assert.equal(normalizeStamp({}).shoulderWidth, 0);
  assert.equal(normalizeStamp({}).shoulderLevels, 4);
  for (const bad of [{ shoulderWidth: -0.1 }, { shoulderWidth: 4 }, { shoulderLevels: 1 }, { shoulderLevels: 17 }, { shoulderLevels: 2.5 }])
    assert.throws(() => normalizeStamp(bad), /ハンコ設定が不正です/);
  assert.deepEqual(passShades(4), [191, 128, 64, 0]);
});

test("depth map PNG gets its physical size (pHYs) after IHDR", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const ihdr = new Uint8Array(25);
  ihdr.set([0, 0, 0, 13, 73, 72, 68, 82]);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...ihdr, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  const out = withPhysicalSize(png, 20),
    view = new DataView(out.buffer);
  assert.equal(out.length, png.length + 21);
  assert.equal(view.getUint32(33), 9);
  assert.equal(new TextDecoder().decode(out.subarray(37, 41)), "pHYs");
  assert.equal(view.getUint32(41), 20000);
  assert.equal(view.getUint32(45), 20000);
  assert.equal(out[49], 1);
  assert.equal(view.getUint32(50), crc32(out.subarray(37, 50)));
  assert.deepEqual([...out.subarray(54)], [...png.subarray(33)]);
  assert.throws(() => withPhysicalSize(new Uint8Array(40), 20), /PNGではありません/);
});
