import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import {
  flatEnvelope,
  presetEnvelope,
  coons,
  warpContours,
  isFlat,
  WARP_PRESETS,
} from "../src/warp.js";
import {
  bounds,
  shapeContours,
  TOLERANCE,
  transform,
  automaticBridges,
  cutGeometry,
  exportSVG,
  worldContours,
} from "../src/geometry.js";
import {
  makeShapingFont,
  layoutText,
  layoutGlyphs,
} from "../src/typography.js";
import { resizeFromHandle, booleanContours } from "../src/operations.js";
import {
  splitCharacters,
  splitParts,
  splitWarpedCharacters,
} from "../src/grouping.js";
import { validateProject } from "../src/project.js";
import { ensureLayers } from "../src/layers.js";
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const box = { x: 10, y: 5, w: 80, h: 20 };
const frame = shapeContours("rect", box.w, box.h).map((c) =>
  c.map((p) => ({ x: p.x + box.x, y: p.y + box.y })),
);
function distanceToPolyline(p, ps) {
  let best = Infinity;
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1],
      b = ps[i],
      dx = b.x - a.x,
      dy = b.y - a.y,
      l = dx * dx + dy * dy,
      t = l
        ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l))
        : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}
test("a flat envelope is the identity and adds no points", () => {
  const e = flatEnvelope();
  assert.ok(isFlat(e));
  for (const [u, v] of [
    [0, 0],
    [0.3, 0.7],
    [1, 1],
    [0.5, 0.1],
  ]) {
    const p = coons(e, u, v);
    near(p.x, u);
    near(p.y, v);
  }
  const out = warpContours(frame, box, e);
  assert.equal(out[0].length, frame[0].length);
  out[0].forEach((p, i) => {
    near(p.x, frame[0][i].x);
    near(p.y, frame[0][i].y);
  });
});
test("each side of the box follows its own Bézier edge, within the tolerance", () => {
  const e = presetEnvelope("wave", 0.8);
  e[0] = { x: -0.1, y: -0.2 };
  e[11] = { x: 0.2, y: 0.2 };
  const [out] = warpContours(frame, box, e);
  assert.deepEqual(out[0], out.at(-1));
  const map = (u, v) => {
    const s = coons(e, u, v);
    return { x: box.x + s.x * box.w, y: box.y + s.y * box.h };
  };
  // Corners land on envelope corners.
  for (const [i, u, v] of [
    [0, 0, 0],
    [3, 1, 0],
    [6, 1, 1],
    [9, 0, 1],
  ]) {
    const p = map(u, v);
    near(p.x, box.x + e[i].x * box.w);
    near(p.y, box.y + e[i].y * box.h);
    assert.ok(distanceToPolyline(p, out) < 1e-9);
  }
  // Every point of every warped side is within tolerance of the output.
  for (let n = 0; n <= 400; n++) {
    const t = n / 400;
    for (const [u, v] of [
      [t, 0],
      [1, t],
      [t, 1],
      [0, t],
    ])
      assert.ok(
        distanceToPolyline(map(u, v), out) <= TOLERANCE + 1e-6,
        `side point ${u},${v}`,
      );
  }
});
test("presets bend the expected sides and flip with negative bend", () => {
  const top = (e) => coons(e, 0.5, 0).y,
    bottom = (e) => coons(e, 0.5, 1).y;
  near(top(presetEnvelope("arcUp", 0.5)), -0.5);
  near(bottom(presetEnvelope("arcUp", 0.5)), 1);
  near(top(presetEnvelope("arcUp", -0.5)), 0.5);
  near(bottom(presetEnvelope("arcDown", 0.5)), 1.5);
  near(top(presetEnvelope("arcDown", 0.5)), 0);
  near(top(presetEnvelope("bulge", 0.5)), -0.5);
  near(bottom(presetEnvelope("bulge", 0.5)), 1.5);
  const arch = presetEnvelope("arch", 0.5, 4);
  near(top(arch), -0.5);
  near(bottom(arch), 0.5);
  const flag = presetEnvelope("flag", 0.5),
    wave = presetEnvelope("wave", 0.5);
  // Flag: both sides rise together on the left; wave: they move apart.
  assert.ok(coons(flag, 0.2, 0).y < 0 && coons(flag, 0.2, 1).y < 1);
  assert.ok(coons(wave, 0.2, 0).y < 0 && coons(wave, 0.2, 1).y > 1);
  const perspective = presetEnvelope("perspective", 0.5);
  near(perspective[6].y - perspective[3].y, 1.5);
  near(perspective[9].y - perspective[0].y, 1);
  const fish = presetEnvelope("fish", 0.5);
  assert.ok(fish[6].y - fish[3].y < 1 && top(fish) < 0 && bottom(fish) > 1);
  for (const [name] of WARP_PRESETS) {
    const e = presetEnvelope(name, 0.5, 3);
    assert.equal(e.length, 12);
    assert.ok(!isFlat(e), name);
    assert.ok(isFlat(presetEnvelope(name, 0, 3)), `${name} at 0 %`);
    const [out] = warpContours(frame, box, e);
    assert.deepEqual(out[0], out.at(-1));
    assert.ok(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  }
  assert.throws(() => presetEnvelope("twirl", 0.5));
});
for (const file of [
  "ZenKakuGothicNew-Regular.ttf",
  "ShipporiMincho-Regular.ttf",
]) {
  const raw = fs.readFileSync(
    new URL(`../public/fonts/${file}`, import.meta.url),
  );
  const bytes = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    ),
    font = opentype.parse(bytes),
    shaping = makeShapingFont(bytes);
  const layout = (item) => layoutText(item, font, shaping);
  const text = (settings) => {
    const item = {
      id: "t",
      type: "text",
      name: "t",
      x: 30,
      y: 40,
      rotation: 20,
      font: "zen",
      size: 16,
      spacing: 1,
      vertical: false,
      layerId: "layer-default",
      ...settings,
    };
    item.contours = layout(item);
    return item;
  };
  test(`${file}: horizontal scale widens glyphs and keeps split characters in place`, () => {
    const plain = bounds(text({ text: "文字AB" }).contours),
      wide = text({ text: "文字AB", stretch: 1.5 });
    const b = bounds(wide.contours);
    near(b.w, plain.w * 1.5, 0.05);
    near(b.h, plain.h, 0.05);
    const pieces = splitCharacters(wide, layoutGlyphs(wide, font, shaping));
    const joined = pieces.flatMap(worldContours),
      original = worldContours(wide);
    assert.equal(joined.length, original.length);
    joined.forEach((c, i) =>
      c.forEach((p, j) => {
        near(p.x, original[i][j].x, 1e-7);
        near(p.y, original[i][j].y, 1e-7);
      }),
    );
    for (const piece of pieces) {
      assert.equal(piece.stretch, 1.5);
      const again = layout(piece);
      again.forEach((c, i) =>
        c.forEach((p, j) => near(p.x, piece.contours[i][j].x, 1e-7)),
      );
    }
  });
  test(`${file}: corner handles rescale text through size and horizontal scale`, () => {
    for (const warp of [
      undefined,
      { preset: "arcUp", bend: 0.5, envelope: presetEnvelope("arcUp", 0.5) },
    ]) {
      const item = text({ text: "つくる\n自由", warp }),
        b = bounds(item.contours);
      const anchor = transform({ x: b.x, y: b.y }, item),
        target = transform({ x: b.x + b.w * 2, y: b.y + b.h * 1.5 }, item);
      const next = resizeFromHandle(item, [1, 1], target, false, layout);
      near(next.size, 24);
      near(next.spacing, 1.5);
      near(next.stretch, 2 / 1.5);
      assert.equal(next.text, item.text);
      assert.deepEqual(next.warp, item.warp);
      const nb = bounds(next.contours),
        fixed = transform({ x: nb.x, y: nb.y }, next);
      near(fixed.x, anchor.x, 0.05);
      near(fixed.y, anchor.y, 0.05);
      near(nb.w, b.w * 2, 0.1);
      near(nb.h, b.h * 1.5, 0.1);
      const locked = resizeFromHandle(item, [1, 1], target, true, layout);
      near(locked.stretch, 1);
      near(locked.size, 32);
    }
    assert.throws(() =>
      resizeFromHandle(text({ text: "字" }), [1, 1], { x: 90, y: 90 }, false),
    );
  });
  test(`${file}: warped text is plain outline geometry for export, booleans and bridges`, () => {
    const warp = {
        preset: "bulge",
        bend: 0.5,
        envelope: presetEnvelope("bulge", 0.5),
      },
      item = text({ text: "日回", warp }),
      flat = layout({ ...item, warp: undefined });
    assert.deepEqual(
      item.contours,
      warpContours(flat, bounds(flat), warp.envelope),
    );
    assert.ok(bounds(item.contours).h > bounds(flat).h * 1.4);
    const project = ensureLayers({
      version: 2,
      width: 240,
      height: 160,
      items: [item],
    });
    const svg = exportSVG(project);
    assert.match(svg, /<path d="M/);
    assert.doesNotMatch(svg, /<text|font-family|transform|style=/);
    const tabs = automaticBridges([item], 1.5).map((t, i) => ({
      ...t,
      id: `b${i}`,
    }));
    assert.ok(tabs.length >= 3);
    assert.equal(cutGeometry([item, ...tabs]).unbridgedIslands, 0);
    const union = booleanContours(
      [
        item,
        {
          ...item,
          id: "r",
          type: "rect",
          contours: shapeContours("rect", 5, 5),
        },
      ],
      "union",
    );
    assert.ok(union.length > 0);
    // Parts of warped text are plain outlines without text or warp fields.
    for (const part of splitParts(item)) {
      assert.equal(part.type, "outline");
      assert.equal(part.warp, undefined);
      assert.equal(part.stretch, undefined);
    }
    // Saved projects keep the source text and warp for re-editing.
    const saved = validateProject(JSON.parse(JSON.stringify(project)));
    assert.deepEqual(saved.items[0].warp, warp);
    assert.equal(saved.items[0].text, "日回");
  });
}
test("saved warp and horizontal scale are validated", () => {
  const item = {
    id: "t",
    type: "text",
    name: "t",
    x: 0,
    y: 0,
    rotation: 0,
    text: "a",
    font: "zen",
    size: 10,
    spacing: 0,
    layerId: "layer-default",
    contours: shapeContours("rect", 1, 1),
  };
  const project = ensureLayers({ width: 100, height: 100, items: [item] });
  const ok = { preset: "custom", bend: 0.5, envelope: flatEnvelope() };
  assert.ok(
    validateProject({ ...project, items: [{ ...item, warp: ok, stretch: 2 }] }),
  );
  for (const bad of [
    { ...ok, preset: "twirl" },
    { ...ok, bend: 2 },
    { ...ok, envelope: flatEnvelope().slice(1) },
    { ...ok, envelope: [...flatEnvelope().slice(1), { x: NaN, y: 0 }] },
  ])
    assert.throws(() =>
      validateProject({ ...project, items: [{ ...item, warp: bad }] }),
    );
  assert.throws(() =>
    validateProject({
      ...project,
      items: [{ ...item, type: "outline", warp: ok }],
    }),
  );
  for (const stretch of [0, 21, NaN])
    assert.throws(() =>
      validateProject({ ...project, items: [{ ...item, stretch }] }),
    );
});
test("characters of warped text keep their warped outline as fixed paths", () => {
  const raw = fs.readFileSync(
    new URL("../public/fonts/ZenKakuGothicNew-Regular.ttf", import.meta.url),
  );
  const bytes = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    ),
    font = opentype.parse(bytes),
    shaping = makeShapingFont(bytes);
  const item = {
    id: "t",
    type: "text",
    name: "t",
    x: 5,
    y: 5,
    rotation: 10,
    text: "アーチ",
    font: "zen",
    size: 12,
    spacing: 0,
    stretch: 1.2,
    warp: {
      preset: "arch",
      bend: 0.6,
      envelope: presetEnvelope("arch", 0.6, 4),
    },
    layerId: "layer-default",
  };
  item.contours = layoutText(item, font, shaping);
  const pieces = splitWarpedCharacters(item, layoutGlyphs(item, font, shaping));
  assert.equal(pieces.length, 3);
  assert.deepEqual(
    pieces.flatMap((p) => p.contours),
    item.contours,
  );
  for (const piece of pieces) {
    assert.equal(piece.type, "outline");
    assert.equal(piece.x, item.x);
    assert.equal(piece.rotation, item.rotation);
    for (const key of ["warp", "text", "font", "stretch"])
      assert.equal(piece[key], undefined);
  }
});
