// Raster images (PNG, JPEG, GIF) → outlines. The image is reduced to black
// and white (dark pixels are the shape), the borders between black and white
// pixels are followed into closed loops, and each loop is smoothed and fitted
// with Bézier curves by the same pipeline as freehand strokes (freehand.js),
// with one image pixel as the unit. Loops nest into outer shapes with holes
// (dxfimport.js). Everything runs in the browser; nothing is uploaded.
import { freehandPath } from "./freehand.js";
import { pathFromContours } from "./path.js";
import { nestShapes } from "./dxfimport.js";
import { signedArea } from "./polygon.js";

export const IMAGE_DEFAULTS = Object.freeze({
  threshold: null, // null: automatic (Otsu)
  invert: false,
  smoothing: 1.5, // Gaussian sigma along the outline, in image pixels
  minArea: 6, // loops smaller than this (pixels²) are dropped as specks
});
export const IMAGE_LIMITS = Object.freeze({
  threshold: [1, 254],
  smoothing: [0, 6],
  minArea: [0, 2000],
  maxSide: 1200, // longer images are scaled down before tracing
  minSide: 400, // smaller ones are scaled up (at most 8×)
  maxShapes: 1500,
});
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"];
export const isImageFile = (file) =>
  IMAGE_TYPES.includes(file.type) || /\.(png|jpe?g|gif)$/i.test(file.name);

// Luminance over white: transparent pixels count as background.
function luminance(image) {
  const { width, height, data } = image,
    out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < out.length; i++) {
    const r = data[4 * i],
      g = data[4 * i + 1],
      b = data[4 * i + 2],
      a = data[4 * i + 3] / 255;
    out[i] = (0.299 * r + 0.587 * g + 0.114 * b) * a + 255 * (1 - a);
  }
  return out;
}
// Otsu's threshold: the level that best separates dark from light.
export function otsu(levels) {
  const hist = new Array(256).fill(0);
  for (const v of levels) hist[v]++;
  const total = levels.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  // Several levels can split equally well (an image of pure black and
  // white); the middle of that range is taken.
  let first = 127,
    last = 127,
    bestVar = -1,
    weightB = 0,
    sumB = 0;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += t * hist[t];
    const mB = sumB / weightB,
      mF = (sum - sumB) / weightF,
      between = weightB * weightF * (mB - mF) ** 2;
    if (between > bestVar * (1 + 1e-9)) {
      bestVar = between;
      first = last = t;
    } else if (between >= bestVar * (1 - 1e-9)) last = t;
  }
  const best = Math.floor((first + last) / 2) + 1;
  return Math.min(IMAGE_LIMITS.threshold[1], Math.max(IMAGE_LIMITS.threshold[0], best));
}
// Black-and-white bitmap: ink[i] = 1 for pixels darker than the threshold
// (lighter ones with `invert`).
export function binarize(image, { threshold = null, invert = false } = {}) {
  const lum = luminance(image),
    t = threshold ?? otsu(lum),
    ink = new Uint8Array(lum.length);
  for (let i = 0; i < lum.length; i++) ink[i] = (lum[i] < t) !== invert ? 1 : 0;
  return { width: image.width, height: image.height, ink, threshold: t };
}

// Borders of the ink as closed loops of pixel-corner points. Each border edge
// runs clockwise around ink (on screen, Y down), so outer borders and the
// borders of holes turn opposite ways. Where two ink pixels touch only at a
// corner the walk turns right, keeping them separate. Only the corners of
// the staircase are kept; the first point is repeated at the end.
const DX = [1, 0, -1, 0],
  DY = [0, 1, 0, -1]; // right, down, left, up
export function traceLoops({ width: w, height: h, ink }) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && ink[y * w + x] === 1,
    W = w + 1,
    // Up to two outgoing edges per corner point (a saddle has two).
    out = new Int8Array(W * (h + 1) * 2).fill(-1),
    used = new Uint8Array(W * (h + 1) * 4);
  const addEdge = (x, y, d) => {
    const v = (y * W + x) * 2;
    out[out[v] < 0 ? v : v + 1] = d;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) addEdge(x, y, 0);
      if (!at(x + 1, y)) addEdge(x + 1, y, 1);
      if (!at(x, y + 1)) addEdge(x + 1, y + 1, 2);
      if (!at(x - 1, y)) addEdge(x, y + 1, 3);
    }
  const loops = [];
  for (let v0 = 0; v0 < W * (h + 1); v0++)
    for (const slot of [0, 1]) {
      const d0 = out[v0 * 2 + slot];
      if (d0 < 0 || used[v0 * 4 + d0]) continue;
      const points = [];
      let x = v0 % W,
        y = Math.floor(v0 / W),
        d = d0,
        prev = -1;
      for (;;) {
        const v = y * W + x;
        if (used[v * 4 + d]) break;
        used[v * 4 + d] = 1;
        if (d !== prev) points.push({ x, y });
        prev = d;
        x += DX[d];
        y += DY[d];
        const n = (y * W + x) * 2,
          a = out[n],
          b = out[n + 1];
        if (a < 0) break;
        if (b < 0) d = a;
        else {
          const right = (prev + 1) % 4;
          d = a === right || b === right ? right : a === prev || b === prev ? prev : a;
        }
      }
      // The start point is a corner unless the walk ends going the same way.
      if (points.length > 2 && d === prev && points.length > 1) points.shift();
      if (points.length >= 3) loops.push([...points, { ...points[0] }]);
    }
  return loops;
}

// Image → { shapes, threshold, loops, dropped } with shapes in image pixels
// ({ name, path, layer: null } as the SVG import returns them).
export function imageShapes(image, options = {}) {
  const o = { ...IMAGE_DEFAULTS, ...options },
    bitmap = binarize(image, o),
    loops = traceLoops(bitmap),
    pieces = [];
  let dropped = 0;
  for (const loop of loops) {
    if (Math.abs(signedArea(loop)) < o.minArea) {
      dropped++;
      continue;
    }
    // The fitter smooths in "screen pixels" × unit; here the unit is one
    // image pixel. Loops too short for it (small dots) keep their exact
    // pixel outline.
    const fit = freehandPath(loop, { smoothing: o.smoothing, unit: 1, autoClose: true }),
      sub = fit?.closed ? fit.path[0] : pathFromContours([loop], 0.01)[0];
    if (!sub) {
      dropped++;
      continue;
    }
    pieces.push({ sub, layer: null, name: "画像の輪郭" });
  }
  const shapes = nestShapes(pieces);
  if (shapes.length > IMAGE_LIMITS.maxShapes)
    throw Error(
      `図形が多すぎます（${shapes.length} 個）。しきい値やノイズ除去を調整してください。`,
    );
  return {
    shapes,
    threshold: bitmap.threshold,
    loops: loops.length,
    dropped,
    ink: bitmap.ink.reduce((n, v) => n + v, 0),
  };
}
// Size the image is traced at: large images are scaled down so tracing stays
// fast, small ones (icons) up to `minSide` so their anti-aliased edges give
// smooth outlines instead of a few big pixel steps.
export function traceSize(width, height, { maxSide = IMAGE_LIMITS.maxSide, minSide = IMAGE_LIMITS.minSide } = {}) {
  const side = Math.max(width, height),
    k = side < minSide ? Math.min(8, minSide / side) : Math.min(1, maxSide / side);
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), k };
}
