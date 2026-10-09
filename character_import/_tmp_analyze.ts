import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { rigFromMmdParser } from "../shared/character/rig";
import { mapHumanoid, HUMANOID_SLOTS } from "../shared/character/humanoid";
import { analyzeSecondary } from "../shared/character/secondary";
const require = createRequire(import.meta.url);
const { Parser } = require("mmd-parser");
const root = process.argv[2];
const only = process.argv[3];
for (const dir of fs.readdirSync(root)) {
  for (const f of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(".pmx"))) {
    if (/武器|伞|技能|补妆/.test(f)) continue;
    if (only && !f.includes(only)) continue;
    const buf = fs.readFileSync(path.join(root, dir, f));
    const rig = rigFromMmdParser(new Parser().parsePmx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    const h = mapHumanoid(rig.bones);
    const missing = HUMANOID_SLOTS.filter((s) => !h.slots[s]);
    const sec = analyzeSecondary(rig, h);
    console.log(`\n## ${rig.modelName} (${dir}) mapped=${Object.keys(h.slots).length}/${HUMANOID_SLOTS.length} missing=${missing.join(",")}`);
    console.log("  core:", ["HIPS","LOWER_BODY","SPINE","CHEST","UPPER_CHEST","NECK","HEAD","LEFT_SHOULDER","LEFT_UPPER_ARM","LEFT_LOWER_ARM","LEFT_HAND","LEFT_UPPER_LEG","LEFT_LOWER_LEG","LEFT_FOOT","LEFT_TOES","LEFT_THUMB_METACARPAL","LEFT_LITTLE_DISTAL"].map(s=>`${s}=${h.slots[s]?.bone}/${h.slots[s]?.method}`).join(" "));
    if (h.notes.length) console.log("  notes:", h.notes);
    console.log("  chains:", sec.chains.map((c) => `${c.id}[${c.bones.length}]<${c.anchor}>${c.classifiedBy}`).join(" | "));
    console.log("  colliders:", sec.colliders.length, sec.notes);
  }
}
