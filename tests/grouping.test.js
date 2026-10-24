import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import {
  makeShapingFont,
  layoutText,
  layoutGlyphs,
} from "../src/typography.js";
import {
  splitCharacters,
  splitParts,
  reassignBridges,
} from "../src/grouping.js";
import {
  worldContours,
  automaticBridges,
  cutGeometry,
} from "../src/geometry.js";
import { validateProject } from "../src/project.js";
const area = (contours) =>
  Math.abs(
    contours.reduce(
      (total, c) =>
        total +
        c.slice(1).reduce((n, p, i) => n + c[i].x * p.y - p.x * c[i].y, 0) / 2,
      0,
    ),
  );
const length = (paths) =>
  paths.reduce(
    (n, ps) =>
      n +
      ps
        .slice(1)
        .reduce((m, p, i) => m + Math.hypot(p.x - ps[i].x, p.y - ps[i].y), 0),
    0,
  );
function sameContours(actual, expected, tolerance = 1e-9) {
  assert.equal(actual.length, expected.length);
  actual.forEach((c, i) => {
    assert.equal(c.length, expected[i].length);
    c.forEach((p, j) => {
      assert.ok(
        Math.abs(p.x - expected[i][j].x) < tolerance &&
          Math.abs(p.y - expected[i][j].y) < tolerance,
        `contour ${i} point ${j}: ${p.x},${p.y} != ${expected[i][j].x},${expected[i][j].y}`,
      );
    });
  });
}
let n = 0;
const ids = (items) => items.map((i) => ({ ...i, id: `piece-${n++}` }));
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
  const text = (settings) => {
    const item = {
      id: "text",
      type: "text",
      name: settings.text,
      x: 40,
      y: 30,
      rotation: 0,
      font: "zen",
      size: 18,
      spacing: 1.5,
      vertical: false,
      layerId: "layer-default",
      ...settings,
    };
    item.contours = layoutText(item, font, shaping);
    return item;
  };
  test(`${file}: character split keeps every glyph in place, horizontally and vertically`, () => {
    for (const item of [
      text({ text: "文字を、\nかたち AB", rotation: 27 }),
      text({ text: "「日本ー。」\n縦書き", vertical: true, rotation: -12 }),
    ]) {
      const glyphs = layoutGlyphs(item, font, shaping);
      sameContours(
        glyphs.flatMap((g) => g.contours),
        item.contours,
      );
      const pieces = splitCharacters(item, glyphs);
      assert.equal(
        pieces.length,
        [...item.text].filter((c) => /\S/u.test(c)).length,
      );
      sameContours(pieces.flatMap(worldContours), worldContours(item), 1e-7);
      for (const piece of pieces) {
        assert.equal(piece.type, "text");
        assert.equal([...piece.text].length, 1);
        assert.equal(piece.rotation, item.rotation);
        assert.equal(piece.vertical, item.vertical);
        // Re-editing a single character lays it out at the same spot.
        sameContours(layoutText(piece, font, shaping), piece.contours, 1e-7);
      }
    }
  });
  test(`${file}: part split separates strokes, keeps holes and islands, and preserves area`, () => {
    // Contours per part, where the part shape does not depend on the typeface.
    const cases = { い: [1, 1], 日: [3], 回: [2, 2], よ: [2], は: null };
    for (const [char, expected] of Object.entries(cases)) {
      const item = text({ text: char, rotation: 33 }),
        parts = splitParts(item);
      if (expected)
        assert.deepEqual(
          parts.map((p) => p.contours.length).sort(),
          [...expected].sort(),
          char,
        );
      // は: the vertical stroke is separate from the looped right-hand part.
      else assert.equal(parts.length, 2);
      for (const part of parts) {
        assert.equal(part.type, "outline");
        assert.equal(part.rotation, 33);
        assert.equal(part.text, undefined);
        for (const c of part.contours) assert.deepEqual(c[0], c.at(-1));
      }
      assert.ok(
        Math.abs(
          area(parts.flatMap(worldContours)) - area(worldContours(item)),
        ) < 0.001,
        char,
      );
    }
  });
  test(`${file}: stencil bridges follow the split pieces and still close every counter`, () => {
    const item = text({ text: "よ日回", rotation: 15 }),
      bridges = automaticBridges([item], 1.5).map((b, i) => ({
        ...b,
        id: `bridge-${i}`,
      }));
    const before = cutGeometry([item, ...bridges]);
    assert.equal(before.unbridgedIslands, 0);
    const characters = ids(
      splitCharacters(item, layoutGlyphs(item, font, shaping)),
    );
    const makeId = () => `copy-${n++}`;
    const afterChars = bridges.map((b) => ({ ...b }));
    afterChars.push(...reassignBridges(afterChars, "text", characters, makeId));
    assert.ok(afterChars.every((b) => b.targetId !== "text"));
    const chars = cutGeometry([...characters, ...afterChars]);
    assert.equal(chars.unbridgedIslands, 0);
    assert.ok(Math.abs(length(chars.paths) - length(before.paths)) < 1e-6);
    // 回 splits into its frame and the centre island. A band through both
    // thin strokes is copied so it still cuts each of them.
    const kai = characters.find((c) => c.text === "回"),
      parts = ids(splitParts(kai));
    const afterParts = afterChars.map((b) => ({ ...b }));
    afterParts.push(...reassignBridges(afterParts, kai.id, parts, makeId));
    assert.ok(afterParts.every((b) => b.targetId !== kai.id));
    for (const part of parts)
      assert.ok(afterParts.some((b) => b.targetId === part.id));
    const split = cutGeometry([
      ...characters.filter((c) => c !== kai),
      ...parts,
      ...afterParts,
    ]);
    assert.equal(split.unbridgedIslands, 0);
    assert.ok(Math.abs(length(split.paths) - length(before.paths)) < 0.01);
  });
  test(`${file}: characters the font cannot draw are reported, not dropped`, () => {
    for (const vertical of [false, true])
      assert.throws(
        () => text({ text: "日😀本", vertical }),
        /このフォントにない文字: 😀/,
      );
    assert.doesNotThrow(() => text({ text: "日本 語\nAa1、。" }));
  });
  test(`${file}: empty or whitespace-only text has nothing to split`, () => {
    for (const value of ["", " \n "]) {
      const item = text({ text: value });
      assert.deepEqual(splitParts(item), []);
      assert.deepEqual(
        splitCharacters(item, layoutGlyphs(item, font, shaping)),
        [],
      );
    }
  });
  test(`${file}: a bridge crossing no piece goes to the nearest one`, () => {
    const item = text({ text: "いい" }),
      pieces = ids(splitCharacters(item, layoutGlyphs(item, font, shaping))),
      far = pieces.at(-1).x + 40,
      bridge = {
        id: "lonely",
        type: "bridge",
        targetId: "text",
        x: far,
        y: 30,
        w: 1,
        h: 1,
        rotation: 0,
      };
    assert.deepEqual(
      reassignBridges([bridge], "text", pieces, () => "x"),
      [],
    );
    assert.equal(bridge.targetId, pieces.at(-1).id);
  });
  test(`${file}: split pieces save and reopen as a valid project`, () => {
    const item = text({ text: "いろは" }),
      characters = ids(
        splitCharacters(item, layoutGlyphs(item, font, shaping)),
      ),
      parts = ids(splitParts(characters[0]));
    const project = {
      version: 2,
      name: "split",
      width: 240,
      height: 160,
      layers: [
        { id: "layer-default", name: "1", visible: true, locked: false },
      ],
      items: [...characters.slice(1), ...parts],
    };
    assert.deepEqual(
      validateProject(JSON.parse(JSON.stringify(project))),
      project,
    );
  });
}
