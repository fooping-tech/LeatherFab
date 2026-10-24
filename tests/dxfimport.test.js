import { test } from "node:test";
import assert from "node:assert/strict";
import { dxfShapes, joinOpenPaths } from "../src/dxfimport.js";
import { pathContours, transformPath } from "../src/path.js";
import { bounds } from "../src/geometry.js";
import { signedArea } from "../src/polygon.js";
import { shapeItem } from "../src/svgimport.js";
import { validateProject } from "../src/project.js";
import { stampGeometry } from "../src/stamp.js";

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const lines = (...a) => a.flat().join("\n");
const dxf = ({ units, tables = [], blocks = [], entities = [] } = {}) =>
  lines(
    units === undefined ? [] : ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", String(units), "0", "ENDSEC"],
    tables.length ? ["0", "SECTION", "2", "TABLES", ...tables, "0", "ENDSEC"] : [],
    blocks.length ? ["0", "SECTION", "2", "BLOCKS", ...blocks, "0", "ENDSEC"] : [],
    ["0", "SECTION", "2", "ENTITIES", ...entities, "0", "ENDSEC", "0", "EOF", ""],
  );
const line = (x1, y1, x2, y2, layer = "CUT") =>
  ["0", "LINE", "8", layer, "10", x1, "20", y1, "11", x2, "21", y2].map(String);
const circle = (x, y, r, layer = "CUT", extra = []) =>
  ["0", "CIRCLE", "8", layer, ...extra, "10", x, "20", y, "40", r].map(String);
const box = (s) => bounds(pathContours(s.path));
const square = (x, y, w, h, layer) => [
  line(x, y, x + w, y, layer),
  line(x + w, y + h, x + w, y, layer), // reversed on purpose
  line(x + w, y + h, x, y + h, layer),
  line(x, y, x, y + h, layer),
];

test("lines meeting end to end become one closed outline; Y is flipped to point down", () => {
  const { shapes, units } = dxfShapes(dxf({ units: 4, entities: square(0, 0, 40, 20, "CUT").flat() }));
  assert.equal(units.label, "mm");
  assert.equal(shapes.length, 1);
  assert.equal(shapes[0].layer, "CUT");
  assert.equal(shapes[0].path.length, 1);
  assert.equal(shapes[0].path[0].closed, true);
  assert.equal(shapes[0].path[0].nodes.length, 4);
  assert.deepEqual(box(shapes[0]), { x: 0, y: -20, w: 40, h: 20 });
});

test("units: inches are scaled to mm, unitless drawings are taken as mm", () => {
  const inch = dxfShapes(dxf({ units: 1, entities: line(0, 0, 1, 0) }));
  near(box(inch.shapes[0]).w, 25.4);
  assert.equal(inch.units.assumed, false);
  const none = dxfShapes(dxf({ entities: line(0, 0, 10, 0) }));
  near(box(none.shapes[0]).w, 10);
  assert.equal(none.units.assumed, true);
});

test("a closed outline inside another on the same layer is its hole; an island inside the hole is separate", () => {
  const { shapes } = dxfShapes(
    dxf({ entities: [...square(0, 0, 40, 40, "A").flat(), ...circle(20, 20, 10, "A"), ...circle(20, 20, 3, "A"), ...circle(20, 20, 15, "B")] }),
  );
  const a = shapes.filter((s) => s.layer === "A").sort((p, q) => box(q).w - box(p).w);
  assert.equal(a.length, 2);
  assert.equal(a[0].path.length, 2); // square + hole
  assert.equal(a[1].path.length, 1); // island
  const [outer, hole] = pathContours(a[0].path);
  assert.ok(Math.sign(signedArea(outer)) !== Math.sign(signedArea(hole)));
  // Another layer does not cut holes.
  assert.equal(shapes.find((s) => s.layer === "B").path.length, 1);
  // As stamp ink the hole is engraved, the island raised.
  const item = (s, n) => shapeItem(s, `i${n}`, "l");
  const shifted = a.map((s) => ({ ...s, path: transformPath(s.path, (q) => ({ x: q.x, y: q.y + 40 })) }));
  const g = stampGeometry(shifted.map(item), { width: 40, height: 40, boldOffset: 0 });
  near(g.inkArea, 1600 - Math.PI * 100 + Math.PI * 9, 2);
});

test("arcs are counter-clockwise from the start angle; bulges make arcs in polylines", () => {
  const arc = dxfShapes(dxf({ entities: ["0", "ARC", "8", "0", "10", "0", "20", "0", "40", "10", "50", "0", "51", "90"] }));
  assert.equal(arc.shapes[0].layer, null); // layer 0 → active layer
  const c = pathContours(arc.shapes[0].path)[0];
  near(c[0].x, 10);
  near(c[0].y, 0);
  near(c.at(-1).x, 0);
  near(c.at(-1).y, -10);
  const mid = c[Math.floor(c.length / 2)];
  near(Math.hypot(mid.x, mid.y), 10, 0.03);
  assert.ok(mid.x > 0 && mid.y < 0);
  // A closed polyline of two half circles (bulge 1) is a circle of radius 5.
  const poly = dxfShapes(
    dxf({ entities: ["0", "LWPOLYLINE", "8", "P", "90", "2", "70", "1", "10", "0", "20", "0", "42", "1", "10", "10", "20", "0", "42", "1"] }),
  );
  assert.equal(poly.shapes[0].path[0].closed, true);
  const b = box(poly.shapes[0]);
  near(b.w, 10);
  near(b.h, 10);
  near(b.y, -5);
});

test("old-style POLYLINE with VERTEX records, ELLIPSE and SPLINE", () => {
  const { shapes } = dxfShapes(
    dxf({
      entities: [
        ...["0", "POLYLINE", "8", "P", "66", "1", "70", "1"],
        ...["0", "VERTEX", "8", "P", "10", "0", "20", "0"],
        ...["0", "VERTEX", "8", "P", "10", "10", "20", "0"],
        ...["0", "VERTEX", "8", "P", "10", "10", "20", "5"],
        ...["0", "SEQEND", "8", "P"],
        ...["0", "ELLIPSE", "8", "E", "10", "50", "20", "0", "11", "20", "21", "0", "40", "0.5", "41", "0", "42", "6.283185307179586"],
        // Degree 1 clamped spline: a polyline through its control points.
        ...["0", "SPLINE", "8", "S", "70", "0", "71", "1", "72", "4", "73", "2", "40", "0", "40", "0", "40", "1", "40", "1", "10", "100", "20", "0", "10", "110", "20", "10"],
      ],
    }),
  );
  const poly = shapes.find((s) => s.layer === "P");
  assert.equal(poly.path[0].closed, true);
  assert.deepEqual(box(poly), { x: 0, y: -5, w: 10, h: 5 });
  const e = box(shapes.find((s) => s.layer === "E"));
  near(e.w, 40, 0.01);
  near(e.h, 20, 0.01);
  const sp = pathContours(shapes.find((s) => s.layer === "S").path)[0];
  near(sp[0].x, 100);
  near(sp.at(-1).x, 110);
  near(sp.at(-1).y, -10);
});

test("blocks: INSERT applies position, scale and rotation; nested blocks; layer 0 inherits", () => {
  const blocks = [
    ...["0", "BLOCK", "8", "0", "2", "BAR", "10", "0", "20", "0"],
    ...line(0, 0, 10, 0, "0"),
    ...["0", "ENDBLK"],
    ...["0", "BLOCK", "8", "0", "2", "TWO", "10", "0", "20", "0"],
    ...["0", "INSERT", "8", "0", "2", "BAR", "10", "0", "20", "0"],
    ...["0", "INSERT", "8", "0", "2", "BAR", "10", "0", "20", "5"],
    ...["0", "ENDBLK"],
  ];
  const { shapes } = dxfShapes(
    dxf({
      blocks,
      entities: [
        ...["0", "INSERT", "8", "MARK", "2", "BAR", "10", "100", "20", "0", "41", "2", "42", "2", "50", "90"],
        ...["0", "INSERT", "8", "PAIR", "2", "TWO", "10", "0", "20", "0"],
      ],
    }),
  );
  const mark = pathContours(shapes.find((s) => s.layer === "MARK").path)[0];
  near(mark[0].x, 100);
  near(mark[0].y, 0);
  near(mark.at(-1).x, 100);
  near(mark.at(-1).y, -20);
  assert.equal(shapes.filter((s) => s.layer === "PAIR").length, 2);
});

test("a downward extrusion mirrors 2D entities in X", () => {
  const { shapes } = dxfShapes(dxf({ entities: circle(10, 0, 2, "M", ["210", "0", "220", "0", "230", "-1"]) }));
  near(box(shapes[0]).x + box(shapes[0]).w / 2, -10);
});

test("hidden layers, paper space and unsupported entities are skipped and reported", () => {
  const tables = [
    ...["0", "TABLE", "2", "LAYER"],
    ...["0", "LAYER", "2", "OFF", "70", "0", "62", "-7"],
    ...["0", "LAYER", "2", "FROZEN", "70", "1", "62", "7"],
    ...["0", "ENDTAB"],
  ];
  const r = dxfShapes(
    dxf({
      tables,
      entities: [
        ...line(0, 0, 1, 0, "OFF"),
        ...line(0, 0, 1, 0, "FROZEN"),
        ...["0", "LINE", "8", "X", "67", "1", "10", "0", "20", "0", "11", "1", "21", "0"],
        ...["0", "TEXT", "8", "X", "10", "0", "20", "0", "1", "hello"],
        ...["0", "HATCH", "8", "X"],
        ...line(0, 0, 5, 0, "KEEP"),
      ],
    }),
  );
  assert.deepEqual(r.shapes.map((s) => s.layer), ["KEEP"]);
  assert.deepEqual(r.skipped, { "文字（TEXT）": 1, ハッチング: 1 });
});

test("binary or malformed files are rejected with a message", () => {
  assert.throws(() => dxfShapes("AutoCAD Binary DXF\r\n\x1a\x00"), /バイナリ形式/);
  assert.throws(() => dxfShapes("hello\nworld\n"), /DXFとして読み込めません/);
  assert.throws(() => dxfShapes("<svg/>"), /DXFとして読み込めません/);
});

test("joining keeps Bézier handles at the shared anchor and closes loops", () => {
  const sub = (nodes) => ({ sub: { closed: false, nodes }, layer: "L", name: "円弧" });
  const joined = joinOpenPaths([
    sub([{ x: 0, y: 0, out: { x: 0, y: 5 } }, { x: 10, y: 0, in: { x: 10, y: 5 } }]),
    sub([{ x: 0, y: 0 }, { x: 10, y: 0.0005 }]),
  ]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].sub.closed, true);
  assert.equal(joined[0].sub.nodes.length, 2);
  assert.equal(joined[0].name, "輪郭");
  assert.ok(joined[0].sub.nodes.some((n) => n.out) && joined[0].sub.nodes.some((n) => n.in));
});

test("imported DXF shapes become valid fixed-path items", () => {
  const { shapes } = dxfShapes(dxf({ entities: [...square(0, 0, 40, 20, "CUT").flat(), ...circle(10, 10, 3, "CUT")] }));
  const items = shapes.map((s, n) => shapeItem(s, `d${n}`, "l"));
  const project = validateProject({
    version: 2,
    name: "dxf",
    width: 100,
    height: 100,
    layers: [{ id: "l", name: "L", visible: true, locked: false }],
    items,
  });
  assert.equal(project.items.length, 1);
  assert.equal(project.items[0].type, "outline");
  assert.equal(project.items[0].contours.length, 2);
});
