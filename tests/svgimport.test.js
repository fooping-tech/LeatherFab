import { test } from "node:test";
import assert from "node:assert/strict";
import {
  svgShapes,
  shapeItem,
  parseXML,
  parseTransform,
  applyMatrix,
  lengthMM,
} from "../src/svgimport.js";
import { pathContours, nodeKeys } from "../src/path.js";
import {
  bounds,
  shapeContours,
  exportSVG,
  cutGeometry,
  automaticBridges,
} from "../src/geometry.js";
import { ensureLayers } from "../src/layers.js";
import { validateProject } from "../src/project.js";
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const box = (shape) => bounds(pathContours(shape.path));
const read = (svg) => svgShapes(parseXML(svg));
test("lengths and transforms", () => {
  near(lengthMM("10mm"), 10);
  near(lengthMM("1in"), 25.4);
  near(lengthMM("96"), 25.4);
  near(lengthMM("72pt"), 25.4);
  near(lengthMM("2cm"), 20);
  assert.equal(lengthMM("50%"), null);
  const p = (t, x, y) => applyMatrix(parseTransform(t), { x, y });
  const a = p("translate(10 5) scale(2)", 1, 1);
  near(a.x, 12);
  near(a.y, 7);
  const r = p("rotate(90 10 10)", 20, 10);
  near(r.x, 10, 1e-9);
  near(r.y, 20, 1e-9);
  const m = p("matrix(1 0 0 1 3 4) skewX(45)", 0, 10);
  near(m.x, 13, 1e-9);
  near(m.y, 14, 1e-9);
  const both = p("translate(5,5)rotate(-90)", 10, 0);
  near(both.x, 5, 1e-9);
  near(both.y, -5, 1e-9);
});
test("viewBox and units map the document into millimetres", () => {
  // 200 user units across 100 mm: half a millimetre per unit.
  let [s] = read(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 200 100"><rect x="20" y="10" width="40" height="20"/></svg>',
  ).shapes;
  let b = box(s);
  near(b.x, 10);
  near(b.y, 5);
  near(b.w, 20);
  near(b.h, 10);
  // No viewBox: CSS pixels at 96 dpi.
  [s] = read(
    '<svg width="96" height="96"><rect width="96" height="48"/></svg>',
  ).shapes;
  near(box(s).w, 25.4);
  // viewBox offset and aspect-ratio centring (meet).
  [s] = read(
    '<svg width="100mm" height="100mm" viewBox="10 10 50 100"><rect x="10" y="10" width="50" height="100"/></svg>',
  ).shapes;
  b = box(s);
  near(b.x, 25);
  near(b.y, 0);
  near(b.w, 50);
  near(b.h, 100);
  [s] = read(
    '<svg width="100mm" height="100mm" viewBox="0 0 50 100" preserveAspectRatio="none"><rect width="50" height="100"/></svg>',
  ).shapes;
  near(box(s).w, 100);
});
test("every basic shape, nested groups and transforms become paths", () => {
  const { shapes, skipped, invalid } = read(`<?xml version="1.0"?>
<!DOCTYPE svg>
<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm" viewBox="0 0 200 200">
  <!-- comment -->
  <defs><rect id="hiddenDef" width="5" height="5"/></defs>
  <g transform="translate(10 10)">
    <rect id="card" x="0" y="0" width="40" height="20" rx="4"/>
    <g transform="scale(2)"><circle cx="30" cy="10" r="5"/></g>
    <ellipse cx="100" cy="10" rx="10" ry="5" style="fill:red"/>
    <line x1="0" y1="40" x2="30" y2="40"/>
    <polyline points="0,50 10,60 20,50"/>
    <polygon points="40 50, 50 60, 30 60"/>
    <path d="M100 50 a10 10 0 1 0 20 0 a10 10 0 1 0 -20 0z"/>
    <rect width="5" height="5" style="display:none"/>
    <rect width="5" height="5" visibility="hidden"/>
    <svg x="150" y="0" width="20" height="20" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>
    <text x="0" y="0">文字</text><image href="a.png"/><use href="#card"/>
    <path d="M0 0 L"/>
  </g>
</svg>`);
  assert.deepEqual(
    shapes.map((s) => s.name),
    ["card", "円", "楕円", "線", "折れ線", "多角形", "パス", "長方形"],
  );
  assert.deepEqual(skipped, { 文字: 1, 画像: 1, "参照(use)": 1 });
  assert.equal(invalid, 1);
  const [card, circle, ellipse, line, polyline, polygon, ring, nested] = shapes;
  const b = (s) => box(s);
  near(b(card).x, 10);
  near(b(card).w, 40);
  assert.equal(nodeKeys(card.path).length, 8);
  near(b(circle).x, 60, 1e-6);
  near(b(circle).w, 20, 1e-6);
  near(b(ellipse).w, 20, 1e-6);
  near(b(ellipse).h, 10, 1e-6);
  assert.equal(line.path[0].closed, false);
  assert.equal(polyline.path[0].closed, false);
  assert.equal(polygon.path[0].closed, true);
  near(b(ring).w, 20, 0.03);
  near(b(nested).x, 160);
  near(b(nested).w, 20);
});
test("Inkscape layers are reported and shapes become valid fixed-path items", () => {
  const { shapes } =
    read(`<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="100mm" height="100mm" viewBox="0 0 100 100">
    <g inkscape:groupmode="layer" inkscape:label="カット &amp; 彫刻"><rect x="5" y="5" width="10" height="10"/></g>
    <rect x="30" y="30" width="10" height="10"/>
  </svg>`);
  assert.deepEqual(
    shapes.map((s) => s.layer),
    ["カット & 彫刻", null],
  );
  const items = shapes.map((s, i) => shapeItem(s, `svg${i}`, "layer-default"));
  near(items[0].x, 5);
  near(items[0].y, 5);
  assert.deepEqual(items[0].contours, pathContours(items[0].path));
  near(bounds(items[0].path.flatMap((s) => s.nodes).map((n) => [n])).x, 0);
  const project = ensureLayers({ version: 2, width: 100, height: 100, items });
  assert.ok(validateProject(JSON.parse(JSON.stringify(project))));
  assert.equal(cutGeometry(items).closed, 2);
});
test("TypeFab's own SVG export re-imports at the same size and position", () => {
  const rect = {
      id: "r",
      type: "rect",
      name: "r",
      x: 20,
      y: 30,
      w: 40,
      h: 25,
      radius: 5,
      rotation: 15,
      layerId: "layer-default",
    },
    ring = {
      id: "o",
      type: "outline",
      name: "o",
      x: 120,
      y: 40,
      rotation: 0,
      layerId: "layer-default",
      contours: [
        ...shapeContours("circle", 40, 40),
        ...shapeContours("circle", 20, 20).map((c) =>
          c.map((p) => ({ x: p.x + 10, y: p.y + 10 })).reverse(),
        ),
      ],
    };
  rect.contours = shapeContours("rect", 40, 25, 5);
  const project = ensureLayers({
    width: 240,
    height: 160,
    items: [rect, ring],
  });
  project.layers[0].name = "レイヤー 1";
  const svg = exportSVG(project),
    { shapes } = read(svg);
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].layer, "レイヤー 1");
  const imported = pathContours(shapes[0].path),
    original = cutGeometry([rect, ring]).paths;
  assert.equal(imported.length, original.length);
  imported.forEach((c, i) =>
    c.forEach((p, j) => {
      near(p.x, original[i][j].x, 1e-3);
      near(p.y, original[i][j].y, 1e-3);
    }),
  );
  // Imported cut lines keep working with bridges.
  const item = shapeItem(shapes[0], "imp", "layer-default");
  assert.ok(automaticBridges([item]).length >= 1);
});
test("the XML reader handles entities, quotes and self-closing tags", () => {
  const root = parseXML(
    `<?xml version='1.0' encoding='UTF-8'?><svg width='10mm' height="10mm"><g id='a&amp;b'><path d='M0 0 L5 5'/></g><![CDATA[ <rect/> ]]></svg>`,
  );
  assert.equal(root.children[0].attrs.id, "a&b");
  assert.equal(root.children[0].children[0].name, "path");
  assert.throws(() => parseXML("<html></html>"), /SVG/);
  assert.throws(() => svgShapes({ name: "g", attrs: {}, children: [] }), /SVG/);
});
