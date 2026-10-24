import * as hb from "harfbuzzjs";
import { flatten } from "./geometry.js";
import { applyWarp } from "./warp.js";
export function makeShapingFont(bytes) {
  const blob = new hb.Blob(bytes),
    face = new hb.Face(blob),
    font = new hb.Font(face);
  return { blob, face, font };
}
export function verticalGlyphs(shaping, text) {
  const buffer = new hb.Buffer();
  buffer.addText(text);
  buffer.setDirection(hb.Direction.TTB);
  buffer.setScript("Hani");
  buffer.setLanguage("ja");
  hb.shape(shaping.font, buffer, [
    new hb.Feature("vert", 1),
    new hb.Feature("vrt2", 1),
  ]);
  const info = buffer.getGlyphInfos(),
    positions = buffer.getGlyphPositions();
  return info.map((i, n) => ({
    id: i.codepoint,
    cluster: i.cluster,
    ...positions[n],
  }));
}
// Final text outline: laid-out glyphs, then the warp envelope if there is one.
export function layoutText(item, font, shaping) {
  return applyWarp(
    item,
    layoutGlyphs(item, font, shaping).flatMap((g) => g.contours),
  );
}
// Horizontal scale (長体・平体) is applied to the glyph curves before flattening,
// so the 0.02 mm tolerance holds at any scale.
function stretched(commands, k) {
  if (k === 1) return commands;
  return commands.map((c) => ({
    ...c,
    x: c.x * k,
    ...(c.x1 !== undefined && { x1: c.x1 * k }),
    ...(c.x2 !== undefined && { x2: c.x2 * k }),
  }));
}
// Per glyph cluster: its source text, contours, glyph commands (for editable
// Bézier outlines), and the pen offset at which a
// one-character text item with the same settings reproduces the glyph exactly.
export function layoutGlyphs(item, font, shaping) {
  if (!font) throw Error("この文字のフォントを追加し、選び直してください。");
  // opentype.js hasChar() is true for every character (it maps unknown ones to
  // .notdef), so check for a real glyph index instead.
  const missing = [
    ...new Set(
      [...item.text].filter(
        (c) => !/[\s]/u.test(c) && !(font.charToGlyphIndex(c) > 0),
      ),
    ),
  ];
  if (missing.length)
    throw Error(`このフォントにない文字: ${missing.join(" ")}`);
  const all = [];
  const size = item.size,
    k = item.stretch ?? 1;
  if (item.vertical) {
    if (!shaping) throw Error("縦書きエンジンの読み込みが完了していません。");
    const scale = size / font.unitsPerEm;
    item.text.split("\n").forEach((line, column) => {
      let x = size / 2 - column * size * 1.3,
        y = 0;
      const shaped = verticalGlyphs(shaping, line),
        clusters = [...new Set(shaped.map((g) => g.cluster))].sort(
          (a, b) => a - b,
        );
      let previous = null;
      for (const g of shaped) {
        const glyph = font.glyphs.get(g.id),
          commands = stretched(
            glyph.getPath(x + g.xOffset * scale, y - g.yOffset * scale, size)
              .commands,
            k,
          ),
          contours = flatten(commands);
        // Glyphs shaped from the same characters stay together as one character.
        if (previous?.cluster === g.cluster) {
          previous.contours.push(...contours);
          previous.commands.push(...commands);
        } else {
          const end = clusters[clusters.indexOf(g.cluster) + 1] ?? line.length;
          previous = {
            cluster: g.cluster,
            text: line.slice(g.cluster, end),
            contours,
            commands,
            origin: { x: (x - size / 2) * k, y },
          };
          all.push(previous);
        }
        x += g.xAdvance * scale;
        y -= g.yAdvance * scale;
        y += item.spacing;
      }
    });
  } else {
    let x = 0,
      y = size;
    for (const char of item.text) {
      if (char === "\n") {
        x = 0;
        y += size * 1.4;
        continue;
      }
      const glyph = font.charToGlyph(char),
        commands = stretched(glyph.getPath(x, y, size).commands, k);
      all.push({
        text: char,
        contours: flatten(commands),
        commands,
        origin: { x: x * k, y: y - size },
      });
      x +=
        ((glyph.advanceWidth || font.unitsPerEm) / font.unitsPerEm) * size +
        item.spacing;
    }
  }
  return all;
}
// Preserve every original OpenType table when unpacking WOFF, including vert/vrt2 and vmtx.
export async function fontSFNT(bytes) {
  const input = new DataView(bytes);
  if (input.getUint32(0) !== 0x774f4646) return bytes;
  const count = input.getUint16(12),
    size = input.getUint32(16);
  if (count < 1 || count > 4096 || size > 64 * 1024 * 1024)
    throw Error("WOFFフォントのサイズが不正です。");
  const out = new ArrayBuffer(size),
    view = new DataView(out),
    dest = new Uint8Array(out);
  view.setUint32(0, input.getUint32(4));
  view.setUint16(4, count);
  const power = Math.floor(Math.log2(count));
  view.setUint16(6, 16 * 2 ** power);
  view.setUint16(8, power);
  view.setUint16(10, count * 16 - 16 * 2 ** power);
  let offset = 12 + 16 * count;
  for (let i = 0; i < count; i++) {
    const from = 44 + i * 20,
      to = 12 + i * 16,
      src = input.getUint32(from + 4),
      compressed = input.getUint32(from + 8),
      length = input.getUint32(from + 12);
    if (
      src + compressed > bytes.byteLength ||
      offset + length > size ||
      compressed > length
    )
      throw Error("WOFFテーブルが不正です。");
    const part = bytes.slice(src, src + compressed);
    const data =
      compressed === length
        ? part
        : await new Response(
            new Blob([part])
              .stream()
              .pipeThrough(new DecompressionStream("deflate")),
          ).arrayBuffer();
    if (data.byteLength !== length) throw Error("WOFF展開に失敗しました。");
    view.setUint32(to, input.getUint32(from));
    view.setUint32(to + 4, input.getUint32(from + 16));
    view.setUint32(to + 8, offset);
    view.setUint32(to + 12, length);
    dest.set(new Uint8Array(data), offset);
    offset += Math.ceil(length / 4) * 4;
  }
  return out;
}
