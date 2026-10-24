import {
  parsePathData,
  shapePath,
  transformPath,
  pathContours,
} from "./path.js";
import { bounds } from "./geometry.js";
// Imports the drawable shapes of an SVG document as editable paths in
// millimetres. The document is read into plain nodes { name, attrs, children }
// (DOMParser in the browser, the small parser below elsewhere), then walked
// with the composed transform of viewBox, nested <svg> and transform lists.
const PX = 25.4 / 96; // mm per CSS pixel (SVG user unit without viewBox)
const UNITS = {
  mm: 1,
  cm: 10,
  q: 0.25,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  px: PX,
};
const NAMES = {
  path: "パス",
  rect: "長方形",
  circle: "円",
  ellipse: "楕円",
  line: "線",
  polyline: "折れ線",
  polygon: "多角形",
};
const CONTAINERS = new Set(["svg", "g", "a", "switch"]);
// Content that is never drawn directly, and content that cannot be cut.
const IGNORED = new Set([
  "defs",
  "symbol",
  "clippath",
  "mask",
  "marker",
  "pattern",
  "lineargradient",
  "radialgradient",
  "filter",
  "metadata",
  "title",
  "desc",
  "style",
  "script",
  "namedview",
  "sodipodi:namedview",
]);
const UNSUPPORTED = {
  text: "文字",
  image: "画像",
  use: "参照(use)",
  foreignobject: "HTML",
};
// Length in mm, or null. Unitless values are CSS pixels.
export function lengthMM(value) {
  const m = /^\s*([-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(
    value ?? "",
  );
  if (!m) return null;
  const unit = UNITS[(m[2] || "px").toLowerCase()];
  return unit ? Number(m[1]) * unit : null;
}
// Coordinate attribute in user units (units convert at 96 dpi).
function coord(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const mm = lengthMM(value);
  return mm === null ? fallback : mm / PX;
}
const numbers = (s) =>
  (String(s ?? "").match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? []).map(
    Number,
  );
// Affine matrices [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
const IDENTITY = [1, 0, 0, 1, 0, 0];
export function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export const applyMatrix = (m, p) => ({
  x: m[0] * p.x + m[2] * p.y + m[4],
  y: m[1] * p.x + m[3] * p.y + m[5],
});
export function parseTransform(text) {
  let m = IDENTITY;
  for (const [, name, args] of String(text ?? "").matchAll(
    /(\w+)\s*\(([^)]*)\)/g,
  )) {
    const v = numbers(args),
      rad = ((v[0] ?? 0) * Math.PI) / 180;
    let t;
    if (name === "matrix" && v.length === 6) t = v;
    else if (name === "translate") t = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
    else if (name === "scale") t = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    else if (name === "rotate") {
      const [cx = 0, cy = 0] = v.slice(1),
        c = Math.cos(rad),
        s = Math.sin(rad);
      t = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
    } else if (name === "skewX") t = [1, 0, Math.tan(rad), 1, 0, 0];
    else if (name === "skewY") t = [1, Math.tan(rad), 0, 1, 0, 0];
    else continue;
    m = multiply(m, t);
  }
  return m;
}
const style = (node) =>
  Object.fromEntries(
    String(node.attrs.style ?? "")
      .split(";")
      .map((d) => d.split(":").map((s) => s.trim().toLowerCase()))
      .filter(([k, v]) => k && v),
  );
const hidden = (node) => {
  const css = style(node);
  return (
    (node.attrs.display ?? css.display) === "none" ||
    ["hidden", "collapse"].includes(node.attrs.visibility ?? css.visibility)
  );
};
// viewBox and width/height of an <svg> element as a matrix into its parent's
// units; the outermost one maps into millimetres.
function viewport(node, outer) {
  const vb = numbers(node.attrs.viewBox),
    toUnits = (v) => (outer ? lengthMM(v) : coord(v, null)),
    w = toUnits(node.attrs.width),
    h = toUnits(node.attrs.height),
    unit = outer ? PX : 1;
  if (vb.length !== 4 || !(vb[2] > 0 && vb[3] > 0))
    return [
      unit,
      0,
      0,
      unit,
      outer ? 0 : coord(node.attrs.x),
      outer ? 0 : coord(node.attrs.y),
    ];
  const width = w ?? (h ? (h * vb[2]) / vb[3] : vb[2] * unit),
    height = h ?? (w ? (w * vb[3]) / vb[2] : vb[3] * unit),
    sx = width / vb[2],
    sy = height / vb[3],
    ratio = String(node.attrs.preserveAspectRatio ?? "xMidYMid meet").trim();
  let ax = sx,
    ay = sy,
    tx = 0,
    ty = 0;
  if (!ratio.startsWith("none")) {
    const s = ratio.includes("slice") ? Math.max(sx, sy) : Math.min(sx, sy),
      align = ratio.split(/\s+/)[0],
      fx = align.includes("xMid") ? 0.5 : align.includes("xMax") ? 1 : 0,
      fy = align.includes("YMid") ? 0.5 : align.includes("YMax") ? 1 : 0;
    ax = ay = s;
    tx = (width - vb[2] * s) * fx;
    ty = (height - vb[3] * s) * fy;
  }
  const x = outer ? 0 : coord(node.attrs.x),
    y = outer ? 0 : coord(node.attrs.y);
  return [ax, 0, 0, ay, x + tx - vb[0] * ax, y + ty - vb[1] * ay];
}
const P = (x, y) => ({ x, y });
// Outline of one shape element in its own user units, or null if empty.
function elementPath(node) {
  const a = node.attrs,
    at = (path, dx, dy) =>
      transformPath(path, (p) => ({ x: p.x + dx, y: p.y + dy }));
  switch (node.name) {
    case "path":
      return a.d ? parsePathData(a.d) : null;
    case "rect": {
      const w = coord(a.width),
        h = coord(a.height);
      if (!(w > 0 && h > 0)) return null;
      let rx = a.rx === undefined ? undefined : coord(a.rx),
        ry = a.ry === undefined ? undefined : coord(a.ry);
      rx ??= ry ?? 0;
      ry ??= rx;
      return at(shapePath("rect", w, h, rx, ry), coord(a.x), coord(a.y));
    }
    case "circle":
    case "ellipse": {
      const rx = coord(node.name === "circle" ? a.r : a.rx),
        ry = coord(node.name === "circle" ? a.r : a.ry);
      if (!(rx > 0 && ry > 0)) return null;
      return at(
        shapePath("circle", 2 * rx, 2 * ry),
        coord(a.cx) - rx,
        coord(a.cy) - ry,
      );
    }
    case "line":
      return [
        {
          closed: false,
          nodes: [P(coord(a.x1), coord(a.y1)), P(coord(a.x2), coord(a.y2))],
        },
      ];
    case "polyline":
    case "polygon": {
      const v = numbers(a.points),
        nodes = [];
      for (let i = 0; i + 1 < v.length; i += 2) nodes.push(P(v[i], v[i + 1]));
      return nodes.length > 1
        ? [{ closed: node.name === "polygon" && nodes.length > 2, nodes }]
        : null;
    }
  }
  return null;
}
// Walks the document. Returns shapes { name, path (mm), layer } plus counts
// of skipped content and unreadable elements.
export function svgShapes(root) {
  if (root?.name !== "svg") throw Error("SVGファイルではありません。");
  const shapes = [],
    skipped = {};
  let invalid = 0;
  const walk = (node, matrix, layer) => {
    for (const child of node.children) {
      const name = child.name;
      if (IGNORED.has(name) || hidden(child)) continue;
      if (UNSUPPORTED[name]) {
        skipped[UNSUPPORTED[name]] = (skipped[UNSUPPORTED[name]] ?? 0) + 1;
        continue;
      }
      let m = multiply(matrix, parseTransform(child.attrs.transform));
      if (CONTAINERS.has(name)) {
        if (name === "svg") m = multiply(m, viewport(child, false));
        const isLayer = child.attrs["inkscape:groupmode"] === "layer";
        walk(
          child,
          m,
          isLayer
            ? child.attrs["inkscape:label"] || child.attrs.id || "レイヤー"
            : layer,
        );
        continue;
      }
      if (!NAMES[name]) continue;
      try {
        const path = elementPath(child);
        if (!path?.length) continue;
        shapes.push({
          name: child.attrs["inkscape:label"] || child.attrs.id || NAMES[name],
          path: transformPath(path, (p) => applyMatrix(m, p)),
          layer,
        });
      } catch {
        invalid++;
      }
    }
  };
  walk(root, viewport(root, true), null);
  return { shapes, skipped, invalid };
}
// Shape to a fixed-path item placed at its top-left corner.
export function shapeItem(shape, id, layerId) {
  const box = bounds(pathContours(shape.path)),
    path = transformPath(shape.path, (p) => ({
      x: p.x - box.x,
      y: p.y - box.y,
    }));
  return {
    id,
    type: "outline",
    name: String(shape.name).slice(0, 100),
    x: box.x,
    y: box.y,
    rotation: 0,
    layerId,
    ratioLocked: false,
    path,
    contours: pathContours(path),
  };
}
// Minimal XML reader for SVG (elements, attributes, comments, CDATA,
// declarations and the predefined/numeric entities). Browsers use DOMParser.
export function parseXML(text) {
  const decode = (s) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
      e[0] === "#"
        ? String.fromCodePoint(
            e[1].toLowerCase() === "x"
              ? parseInt(e.slice(2), 16)
              : Number(e.slice(1)),
          )
        : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()],
    );
  const root = { name: "#document", attrs: {}, children: [] },
    stack = [root],
    tag =
      /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  for (const m of text.matchAll(tag)) {
    if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else if (m[2]) {
      const attrs = {};
      for (const [, k, , v1, v2] of m[3].matchAll(
        /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g,
      ))
        attrs[k] = decode(v1 ?? v2);
      const node = { name: m[2].toLowerCase(), attrs, children: [] };
      stack.at(-1).children.push(node);
      if (!m[4]) stack.push(node);
    }
  }
  const svg = root.children.find((n) => n.name === "svg");
  if (!svg) throw Error("SVGファイルではありません。");
  return svg;
}
// DOM element to the same plain node form (browser path).
export function fromDOM(el) {
  return {
    name:
      el.localName === "namedview" ? "namedview" : el.localName.toLowerCase(),
    attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
    children: [...el.children].map(fromDOM),
  };
}
