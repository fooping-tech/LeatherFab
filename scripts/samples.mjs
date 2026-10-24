#!/usr/bin/env node
// Writes the sample patterns (project JSON + laser SVG) into samples/.
//   node scripts/samples.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATES } from "../src/leather/templates.js";
import { deriveProject } from "../src/leather/derive.js";
import { exportLeatherSVG, operationGeometry, manufacturingSummary } from "../src/leather/manufacturing.js";
import { validateProject } from "../src/project.js";
import { emptyLeather } from "../src/leather/model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "samples");
fs.mkdirSync(out, { recursive: true });
let n = 0;
const makeId = () => `sample-${++n}`;
for (const t of TEMPLATES) {
  n = 0;
  const layer = { id: "layer-default", name: "レイヤー 1", visible: true, locked: false };
  const built = t.build(makeId, layer.id, { x: 20, y: 20 });
  const project = validateProject({
    version: 2,
    name: t.label,
    width: 200,
    height: 120,
    layers: [layer],
    items: built.items,
    leather: { ...emptyLeather(), parts: built.parts, joints: built.joints },
  });
  const derived = deriveProject(project);
  const errors = derived.issues.filter((i) => i.level === "error");
  if (errors.length) throw new Error(`${t.id}: ${errors.map((e) => e.message).join("; ")}`);
  const svg = exportLeatherSVG(project, derived);
  const summary = manufacturingSummary(operationGeometry(project, derived));
  fs.writeFileSync(path.join(out, `${t.id}-case.json`), JSON.stringify(project, null, 2));
  fs.writeFileSync(path.join(out, `${t.id}-case.svg`), svg);
  console.log(`${t.id}: CUT ${summary.cut}, PUNCH ${summary.punch}, cut length ${summary.cutLength.toFixed(1)} mm`);
  for (const d of derived.parts)
    for (const s of d.stitch) console.log(`  ${d.part.name} / ${s.line.name}: ${s.holes.length} holes, pitch ${s.result.pitch.mean.toFixed(3)} mm (${s.result.pitch.min.toFixed(3)}–${s.result.pitch.max.toFixed(3)}), length ${s.result.length.toFixed(2)} mm`);
  for (const j of derived.joints) console.log(`  joint ${j.joint.name}: ${j.count} pairs, length diff ${j.lengthDiff.toFixed(3)} mm, max deviation ${j.maxDeviation.toFixed(4)} mm`);
}
