import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeContours, exportSVG, cutGeometry } from "../src/geometry.js";
import { ensureLayers, isVisible, isEditable, visibleItems } from "../src/layers.js";
import { validateProject } from "../src/project.js";
import { reorderItems } from "../src/edit.js";

const rect = (id, x = 0, y = 0, w = 10, h = 10, extra = {}) => ({
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
  ...extra,
});
const bridge = (id, x, y, extra = {}) => ({
  id,
  type: "bridge",
  name: id,
  x,
  y,
  w: 4,
  h: 1.5,
  rotation: 0,
  layerId: "layer-default",
  ...extra,
});
const project = () =>
  ensureLayers({
    version: 2,
    name: "t",
    width: 100,
    height: 80,
    items: [rect("a"), rect("b", 30, 20), rect("c", 60, 40)],
  });

test("hidden items are not visible, editable, cut or exported, and their bridges follow", () => {
  const p = project();
  p.items.push(bridge("tab", 5, 0, { targetId: "a" }));
  assert.ok(isVisible(p, p.items[0]));
  p.items[0].hidden = true;
  assert.equal(isVisible(p, p.items[0]), false);
  assert.equal(isEditable(p, p.items[0]), false);
  assert.equal(isVisible(p, p.items.find((i) => i.id === "tab")), false);
  assert.deepEqual(visibleItems(p).map((i) => i.id), ["b", "c"]);
  assert.equal(cutGeometry(visibleItems(p)).closed, 2);
  assert.doesNotMatch(exportSVG(p), /M0 0 /);
  delete p.items[0].hidden;
  assert.deepEqual(visibleItems(p).map((i) => i.id), ["a", "b", "c", "tab"]);
});

test("the hidden flag round-trips through validation; other values are rejected", () => {
  const p = project();
  p.items[1].hidden = true;
  const back = validateProject(JSON.parse(JSON.stringify(p)));
  assert.equal(back.items[1].hidden, true);
  assert.equal(back.items[0].hidden, undefined);
  p.items[2].hidden = "yes";
  assert.throws(() => validateProject(JSON.parse(JSON.stringify(p))), /表示設定/);
});

test("reorderItems drops items before or after a row, keeping their order and layer", () => {
  const p = project();
  p.layers.push({ id: "top", name: "上", visible: true, locked: false });
  p.items.push(rect("d", 0, 0, 5, 5, { layerId: "top" }));
  // a and b go in front of c (after it in stacking order), keeping a before b.
  assert.deepEqual(reorderItems(p.items, ["a", "b"], "c", "after").map((i) => i.id), ["c", "a", "b", "d"]);
  assert.deepEqual(reorderItems(p.items, ["c"], "a", "before").map((i) => i.id), ["c", "a", "b", "d"]);
  // Dropping onto another layer's row moves the item to that layer.
  const moved = reorderItems(p.items, ["b"], "d", "before");
  assert.deepEqual(moved.map((i) => i.id), ["a", "c", "b", "d"]);
  assert.equal(moved[2].layerId, "top");
  assert.equal(p.items[1].layerId, "layer-default", "input is untouched");
  assert.throws(() => reorderItems(p.items, ["a"], "zzz"), /見つかりません/);
  assert.throws(() => reorderItems(p.items, ["a"], "a"), /見つかりません/);
});

test("exporting a selection keeps only those items and their bridges, cropped to the cut lines", () => {
  const p = project();
  p.items.push(bridge("own", 35, 20, { targetId: "b" }), bridge("other", 5, 0, { targetId: "a" }), bridge("global", 30, 25));
  const svg = exportSVG(p, { ids: ["b"], crop: true });
  assert.match(svg, /width="10mm" height="10mm" viewBox="0 0 10 10"/);
  // b (30,20)-(40,30) is moved to the origin; a and c are absent.
  assert.match(svg, /M0 /);
  assert.doesNotMatch(svg, /M60 |M30 20/);
  // Its own bridge and the unscoped bridge each cut a gap: two runs instead
  // of one closed loop; a's bridge is not applied.
  assert.equal((svg.match(/M/g) || []).length, 2);
  assert.doesNotMatch(svg, / Z/);
  const own = exportSVG({ ...p, items: p.items.filter((i) => i.id !== "global") }, { ids: ["b"], crop: true });
  assert.equal((own.match(/M/g) || []).length, 1);
  // Without crop the document keeps the board size and positions.
  const full = exportSVG(p, { ids: ["c"] });
  assert.match(full, /width="100mm" height="80mm"/);
  assert.match(full, /M60 40/);
  assert.doesNotMatch(full, /M30 20/);
  // A hidden selected item exports nothing.
  p.items[2].hidden = true;
  assert.throws(() => exportSVG(p, { ids: ["c"] }), /出力できるカット線/);
  // A single horizontal line still gets a non-zero height.
  const line = ensureLayers({ version: 2, name: "l", width: 100, height: 80, items: [{ id: "l", type: "line", name: "l", x: 10, y: 10, w: 30, h: 0, rotation: 0, layerId: "layer-default", contours: shapeContours("line", 30, 0) }] });
  assert.match(exportSVG(line, { ids: ["l"], crop: true }), /width="30mm" height="0.1mm"/);
});
