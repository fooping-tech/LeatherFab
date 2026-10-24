import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import {
  FONT_CATALOG,
  FONT_CATEGORIES,
  DEFAULT_FONT,
  bundledFont,
  createFontLoader,
  fontPolicyAccepted,
  FONT_POLICY_VERSION,
  FONT_POLICY_TEXT,
} from "../src/fonts.js";
import { FONT_PREVIEWS } from "../src/font-previews.js";
import { makeShapingFont, verticalGlyphs, layoutText, layoutGlyphs } from "../src/typography.js";
import { exportSVG, automaticBridges, cutGeometry, bounds } from "../src/geometry.js";
import { validateProject } from "../src/project.js";
import { ensureLayers } from "../src/layers.js";

const read = (file) => {
  const b = fs.readFileSync(`public/fonts/${file}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const loaded = new Map();
const fontOf = (f) => {
  if (!loaded.has(f.id)) {
    const bytes = read(f.file);
    loaded.set(f.id, { font: opentype.parse(bytes), shaping: makeShapingFont(bytes) });
  }
  return loaded.get(f.id);
};

test("catalogue: 8 bundled OFL fonts with files, licence texts, categories and stable ids", () => {
  assert.ok(FONT_CATALOG.length >= 8);
  assert.equal(DEFAULT_FONT, "zen");
  assert.ok(bundledFont("shippori"), "legacy id shippori kept");
  assert.equal(new Set(FONT_CATALOG.map((f) => f.id)).size, FONT_CATALOG.length);
  const third = fs.readFileSync("THIRD_PARTY_FONTS.md", "utf8");
  for (const f of FONT_CATALOG) {
    assert.ok(fs.existsSync(`public/fonts/${f.file}`), f.file);
    const licence = fs.readFileSync(`public/fonts/${f.licenseFile}`, "utf8");
    assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/, f.licenseFile);
    assert.ok(licence.startsWith(f.copyright), `${f.id} copyright matches the OFL header`);
    assert.ok(FONT_CATEGORIES[f.category], f.category);
    assert.equal(f.licenseId, "OFL-1.1");
    assert.match(f.source, /^https:\/\/github\.com\/google\/fonts\/tree\/main\/ofl\//);
    assert.ok(third.includes(f.file) && third.includes(f.licenseFile), `${f.id} listed in THIRD_PARTY_FONTS.md`);
    assert.ok(FONT_PREVIEWS[f.id]?.d.startsWith("M"), `${f.id} has a name preview`);
  }
  assert.ok(FONT_CATALOG.some((f) => f.category === "rounded"));
  assert.ok(FONT_CATALOG.some((f) => f.category === "pixel"));
  assert.ok(FONT_CATALOG.some((f) => f.category === "handwriting"));
});

test("every bundled font outlines Japanese and alphanumerics, keeps placement across fonts, and shapes vertical text with vert glyphs", () => {
  const item = { text: "日本語 Abc 123", font: "x", size: 20, spacing: 0.5, vertical: false };
  const sizes = [];
  for (const f of FONT_CATALOG) {
    const { font, shaping } = fontOf(f);
    const contours = layoutText(item, font, shaping);
    assert.ok(contours.length >= 10, `${f.id} outlines`);
    const box = bounds(contours);
    assert.ok(box.x >= -2 && box.y >= -2 && box.y + box.h <= 20 * 1.35, `${f.id} placement within the em box: ${JSON.stringify(box)}`);
    sizes.push(box.h);
    // one-character items reproduce the glyph at the same origin
    const glyphs = layoutGlyphs(item, font, shaping);
    assert.equal(glyphs[0].origin.x, 0);
    // vertical: 「」ー、。 use vertical alternates and advance downwards
    const chars = "「ー、。」";
    const v = verticalGlyphs(shaping, chars);
    assert.equal(v.length, 5, f.id);
    assert.ok(v.every((g) => g.yAdvance < 0 && g.xAdvance === 0), `${f.id} vertical advances`);
    assert.ok(v.filter((g, i) => g.id !== font.charToGlyphIndex(chars[i])).length >= 4, `${f.id} vert/vrt2 substitutions`);
    const column = layoutText({ ...item, text: "日本\n語", vertical: true }, font, shaping);
    assert.ok(column.length >= 6, `${f.id} vertical outlines`);
    const vb = bounds(column);
    assert.ok(vb.h > 30 && vb.w > 20, `${f.id} two columns downward`);
  }
  // switching fonts keeps the 20 mm size within a sensible band
  assert.ok(Math.max(...sizes) / Math.min(...sizes) < 1.6, `heights ${sizes.map((n) => n.toFixed(1))}`);
});

test("every bundled font: automatic bridges close the islands and the SVG export is path-only", () => {
  for (const f of FONT_CATALOG) {
    const { font, shaping } = fontOf(f);
    const text = { id: "t", type: "text", name: "t", text: "日AB8", font: f.id, size: 20, spacing: 0, vertical: false, x: 20, y: 20, rotation: 0 };
    text.contours = layoutText(text, font, shaping);
    const bridges = automaticBridges([text]);
    assert.ok(bridges.length >= 4, `${f.id} bridges for 日 A B 8 (${bridges.length})`);
    const cut = cutGeometry([text, ...bridges]);
    assert.equal(cut.untouched, 0, `${f.id} untouched contours`);
    const svg = exportSVG(ensureLayers({ version: 1, name: "x", width: 200, height: 100, items: [text, ...bridges] }));
    assert.ok(!/<text|<font|font-family|@font-face/.test(svg), `${f.id} export has no text/font`);
    assert.match(svg, /<path d="M/);
  }
});

test("lazy loader: fetches once per font, shares in-flight loads, reports errors and allows retry", async () => {
  const calls = [];
  const bytes = read("ZenKakuGothicNew-Regular.ttf");
  let fail = false;
  const loader = createFontLoader({
    fetch: async (url) => {
      calls.push(url);
      if (fail) return { ok: false, status: 503 };
      return { ok: true, arrayBuffer: async () => bytes };
    },
    baseUrl: "/TypeFab/",
    parse: (b) => opentype.parse(b),
    makeShaping: (b) => makeShapingFont(b),
  });
  assert.equal(loader.state("zen"), "idle");
  assert.equal(loader.state("custom-1"), "missing");
  const [a, b] = await Promise.all([loader.load("zen"), loader.load("zen")]);
  assert.equal(a.font, b.font);
  assert.equal(calls.length, 1, "concurrent loads share one fetch");
  assert.deepEqual(calls, ["/TypeFab/fonts/ZenKakuGothicNew-Regular.ttf"]);
  await loader.load("zen");
  assert.equal(calls.length, 1, "no refetch of a loaded font");
  assert.equal(loader.state("zen"), "loaded");
  assert.ok(loader.fonts.get("zen") && loader.shaping.get("zen"));
  fail = true;
  await assert.rejects(loader.load("shippori"), /しっぽり明朝.*503/);
  assert.equal(loader.state("shippori"), "error");
  assert.ok(!loader.fonts.has("shippori"), "no fallback font registered on failure");
  fail = false;
  await loader.load("shippori");
  assert.equal(loader.state("shippori"), "loaded", "retry after an error works");
  assert.equal(loader.fetchCount, 3);
  await assert.rejects(loader.load("nope"), /同梱されていません/);
  loader.add("custom-1", loader.fonts.get("zen"), loader.shaping.get("zen"), "My Font");
  assert.equal(loader.state("custom-1"), "loaded");
  assert.equal(loader.labels.get("custom-1"), "My Font");
});

test("user-font policy: consent is versioned", () => {
  assert.equal(FONT_POLICY_VERSION, 1);
  assert.equal(fontPolicyAccepted(null), false);
  assert.equal(fontPolicyAccepted("0"), false);
  assert.equal(fontPolicyAccepted(String(FONT_POLICY_VERSION)), true);
  assert.equal(fontPolicyAccepted(String(FONT_POLICY_VERSION + 1)), false, "a newer stored version does not count");
  assert.match(FONT_POLICY_TEXT, /必要な権利または許諾を有していること/);
  assert.match(FONT_POLICY_TEXT, /ユーザー追加フォントはブラウザ内で処理され/);
});

test("saved projects with font ids zen / shippori stay valid", () => {
  const p = validateProject({ version: 1, name: "old", width: 100, height: 100, items: [{ id: "a", type: "text", name: "a", text: "あ", font: "shippori", size: 10, spacing: 0, vertical: false, x: 0, y: 0, rotation: 0, contours: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }]] }] });
  assert.equal(p.items[0].font, "shippori");
  assert.ok(bundledFont(p.items[0].font));
});
