import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import {
  booleanContours,
  resizeFromHandle,
  followBridges,
} from "../src/operations.js";
import {
  shapeContours,
  automaticBridges,
  cutGeometry,
  transform,
  bounds,
  exportSVG,
} from "../src/geometry.js";
import { validateProject } from "../src/project.js";
import { ensureLayers, visibleItems, isEditable } from "../src/layers.js";
import {
  makeShapingFont,
  verticalGlyphs,
  layoutText,
} from "../src/typography.js";
const rectangle = (id, x = 0, y = 0, w = 10, h = 10) => ({
  id,
  type: "rect",
  name: id,
  x,
  y,
  w,
  h,
  rotation: 0,
  layerId: "layer-default",
  contours: shapeContours("rect", w, h),
});
const area = (contours) =>
  Math.abs(
    contours.reduce(
      (total, c) =>
        total +
        c.slice(1).reduce((n, p, i) => n + c[i].x * p.y - p.x * c[i].y, 0) / 2,
      0,
    ),
  );
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
for (const [operation, expected] of [
  ["union", 150],
  ["difference", 50],
  ["intersection", 50],
  ["xor", 100],
])
  test(`${operation} produces expected material area with no duplicate overlap`, () => {
    const result = booleanContours(
      [rectangle("a"), rectangle("b", 5)],
      operation,
    );
    near(area(result), expected);
    for (const c of result) assert.deepEqual(c[0], c.at(-1));
  });
test("difference preserves a nested hole, and union with an island preserves the hole topology", () => {
  const donut = booleanContours(
    [rectangle("a", 0, 0, 30, 30), rectangle("b", 5, 5, 20, 20)],
    "difference",
  );
  assert.equal(donut.length, 2);
  near(area(donut), 500);
  const result = booleanContours(
    [
      { ...rectangle("donut"), type: "outline", contours: donut },
      rectangle("island", 10, 10, 5, 5),
    ],
    "union",
  );
  assert.equal(result.length, 3);
  near(area(result), 525);
});
test("boolean order, rotations, disjoint and open-path behavior", () => {
  const a = rectangle("a", 0, 0, 30, 30),
    b = rectangle("b", 5, 5, 5, 5);
  assert.equal(booleanContours([b, a], "difference").length, 0);
  const turned = { ...rectangle("r", 40, 40), rotation: 45 };
  assert.ok(
    Math.abs(area(booleanContours([a, turned], "union")) - 1000) < 0.003,
  );
  assert.throws(() =>
    booleanContours(
      [a, { ...b, contours: shapeContours("line", 5, 0) }],
      "union",
    ),
  );
});
test("all four resize corners keep rotated opposite corner fixed", () => {
  for (const corner of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const a = { ...rectangle("a", 30, 40, 20, 10), rotation: 37 };
    const anchor = transform(
      { x: (1 - corner[0]) * 20, y: (1 - corner[1]) * 10 },
      a,
    );
    const pointer = transform(
      { x: corner[0] ? 30 : -10, y: corner[1] ? 20 : -10 },
      a,
    );
    const next = resizeFromHandle(a, corner, pointer, false);
    const fixed = transform(
      { x: (1 - corner[0]) * next.w, y: (1 - corner[1]) * next.h },
      next,
    );
    near(fixed.x, anchor.x);
    near(fixed.y, anchor.y);
    near(next.w, 30);
    near(next.h, 20);
  }
});
test("aspect-locked rectangle and ellipse scaling keep exact ratio", () => {
  for (const type of ["rect", "circle"]) {
    const a = {
      ...rectangle("a", 0, 0, 40, 20),
      type,
      contours: shapeContours(type, 40, 20),
    };
    const next = resizeFromHandle(a, [1, 1], { x: 80, y: 25 }, true);
    near(next.w / next.h, 2);
    near(next.w, 80);
    near(next.h, 40);
  }
});
test("fixed outlines resize preserving a hole and anchor", () => {
  const a = {
    ...rectangle("a", 10, 10),
    type: "outline",
    contours: booleanContours(
      [rectangle("a"), rectangle("b", 2, 2, 4, 4)],
      "difference",
    ),
  };
  const next = resizeFromHandle(a, [1, 1], { x: 30, y: 30 }, true);
  near(area(next.contours), 336);
  assert.equal(next.contours.length, 2);
});
test("scoped auto bridges only cut the requested overlapping owner", () => {
  const a = rectangle("a"),
    b = rectangle("b");
  const tabs = automaticBridges([a, b], 1.5, ["a"]);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].targetId, "a");
  assert.equal(cutGeometry([a, b, ...tabs]).untouched, 1);
  assert.equal(automaticBridges([a, b, ...tabs], 1.5, ["a"]).length, 0);
  assert.equal(automaticBridges([a, b, ...tabs], 1.5, ["b"]).length, 1);
});
test("owner translation rotation and resize carry tabs while preserving physical width", () => {
  const a = rectangle("a"),
    tab = { ...automaticBridges([a])[0], id: "tab" };
  const start = { ...tab };
  const next = { ...a, x: 40, y: 30, rotation: 90 };
  followBridges([tab], a, next);
  const expected = transform({ x: start.x, y: start.y }, next);
  near(tab.x, expected.x);
  near(tab.y, expected.y);
  near(tab.w, start.w);
  assert.equal(cutGeometry([next, tab]).untouched, 0);
  const bigger = resizeFromHandle(
    next,
    [1, 1],
    transform({ x: 20, y: 20 }, next),
    true,
  );
  followBridges([tab], next, bigger);
  near(tab.w, start.w);
  assert.equal(cutGeometry([bigger, tab]).untouched, 0);
});
test("v1 migration preserves contours; v2 layers and ownership round-trip", () => {
  const a = rectangle("a");
  delete a.layerId;
  const migrated = validateProject({
    version: 1,
    width: 100,
    height: 100,
    items: [a],
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.layers.length, 1);
  assert.deepEqual(migrated.items[0].contours, a.contours);
  migrated.items.push({ ...automaticBridges(migrated.items)[0], id: "tab" });
  assert.deepEqual(
    validateProject(JSON.parse(JSON.stringify(migrated))),
    migrated,
  );
  assert.throws(() => validateProject({ ...migrated, layers: [] }));
  assert.throws(() =>
    validateProject({ ...migrated, items: [{ ...a, layerId: "invalid" }] }),
  );
  assert.throws(() =>
    validateProject({
      ...migrated,
      items: [{ ...migrated.items[1], targetId: "missing" }],
    }),
  );
});
test("hidden layers are excluded from export; locked visible layers export but cannot edit", () => {
  const project = ensureLayers({
    width: 100,
    height: 100,
    items: [rectangle("a")],
  });
  project.layers.push({
    id: "second",
    name: "二",
    visible: false,
    locked: false,
  });
  project.items.push({ ...rectangle("b", 50), layerId: "second" });
  assert.equal(visibleItems(project).length, 1);
  assert.ok(!isEditable(project, project.items[1]));
  assert.doesNotMatch(exportSVG(project), /M50 /);
  project.layers[0].locked = true;
  assert.ok(!isEditable(project, project.items[0]));
  assert.equal(visibleItems(project).length, 1);
});
for (const file of [
  "ZenKakuGothicNew-Regular.ttf",
  "ShipporiMincho-Regular.ttf",
])
  test(`${file}: true vertical punctuation substitutions and right-to-left columns`, () => {
    const raw = fs.readFileSync(
      new URL(`../public/fonts/${file}`, import.meta.url),
    );
    const bytes = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    );
    const font = opentype.parse(bytes),
      shaping = makeShapingFont(bytes);
    const chars = "「ー、。」",
      glyphs = verticalGlyphs(shaping, chars);
    glyphs.forEach((g, i) => {
      assert.notEqual(g.id, font.charToGlyphIndex(chars[i]));
      assert.ok(g.yAdvance < 0);
      assert.equal(g.xAdvance, 0);
    });
    const line = layoutText(
      { text: "日", size: 20, spacing: 0, vertical: true },
      font,
      shaping,
    );
    const columns = layoutText(
      { text: "日\n日", size: 20, spacing: 0, vertical: true },
      font,
      shaping,
    );
    const first = bounds(line),
      both = bounds(columns);
    near(both.x, first.x - 26);
    near(both.w, first.w + 26);
    near(both.h, first.h);
    const longVowel = bounds(
      layoutText(
        { text: "ー", size: 20, spacing: 0, vertical: true },
        font,
        shaping,
      ),
    );
    assert.ok(longVowel.h > longVowel.w * 2);
  });
test("WOFF decompression preserves GSUB vertical substitutions and glyph metrics", async () => {
  const { deflateSync } = await import("node:zlib");
  const { fontSFNT } = await import("../src/typography.js");
  const raw = fs.readFileSync(
    new URL("../public/fonts/ZenKakuGothicNew-Regular.ttf", import.meta.url),
  );
  const original = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    ),
    source = new DataView(original),
    count = source.getUint16(4);
  let offset = 44 + count * 20;
  const records = [];
  for (let n = 0; n < count; n++) {
    const table = 12 + n * 16,
      start = source.getUint32(table + 8),
      length = source.getUint32(table + 12),
      data = Buffer.from(original.slice(start, start + length)),
      compressed = deflateSync(data);
    const stored = compressed.length < data.length ? compressed : data;
    records.push({
      tag: source.getUint32(table),
      checksum: source.getUint32(table + 4),
      length,
      stored,
      offset,
    });
    offset += Math.ceil(stored.length / 4) * 4;
  }
  const woff = new ArrayBuffer(offset),
    header = new DataView(woff);
  header.setUint32(0, 0x774f4646);
  header.setUint32(4, source.getUint32(0));
  header.setUint32(8, offset);
  header.setUint16(12, count);
  header.setUint32(16, original.byteLength);
  records.forEach((r, n) => {
    const o = 44 + n * 20;
    header.setUint32(o, r.tag);
    header.setUint32(o + 4, r.offset);
    header.setUint32(o + 8, r.stored.length);
    header.setUint32(o + 12, r.length);
    header.setUint32(o + 16, r.checksum);
    new Uint8Array(woff).set(r.stored, r.offset);
  });
  const normalized = await fontSFNT(woff);
  assert.deepEqual(
    verticalGlyphs(makeShapingFont(normalized), "「日本語ー、。」"),
    verticalGlyphs(makeShapingFont(original), "「日本語ー、。」"),
  );
});
test("SVG keeps named visible layer groups and applies cross-layer manual bridges", () => {
  const project = ensureLayers({
    width: 100,
    height: 100,
    items: [rectangle("a")],
  });
  project.layers[0].name = '日本語 & "加工"';
  project.layers.push({
    id: "tabs",
    name: "ブリッジ",
    visible: true,
    locked: false,
  });
  project.items.push({
    id: "manual",
    type: "bridge",
    x: 5,
    y: 0,
    w: 2,
    h: 2,
    rotation: 0,
    layerId: "tabs",
  });
  const svg = exportSVG(project);
  assert.match(svg, /inkscape:groupmode="layer"/);
  assert.match(svg, /日本語 &amp; &quot;加工&quot;/);
  assert.doesNotMatch(svg, / Z/);
});
