// Print the concrete object shapes mmd-parser produces, so the loader is
// written against real data rather than assumptions.
import fs from 'node:fs';
import mmdParser from 'mmd-parser';

const buf = fs.readFileSync(process.argv[2]);
const pmx = new mmdParser.Parser().parsePmx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const show = (label, obj) => console.log(`\n=== ${label} ===\n` + JSON.stringify(obj, null, 2));

console.log('top-level keys:', Object.keys(pmx).join(', '));

// Vertices: find one of each weight type present.
const seen = new Set();
for (const v of pmx.vertices) {
  if (!seen.has(v.type)) {
    seen.add(v.type);
    show(`vertex (weight type ${v.type})`, v);
  }
  if (seen.size >= 5) break;
}
console.log('\nweight types present:', [...seen].sort().join(', '));

show('face[0]', pmx.faces[0]);
show('bone[16] (head)', pmx.bones[16]);
show('bone with IK', pmx.bones.find((b) => b.ik));
show('bone with append/grant', pmx.bones.find((b) => b.grant));

show('vertex morph "まばたき"', {
  ...pmx.morphs.find((m) => m.name === 'まばたき'),
  elements: pmx.morphs.find((m) => m.name === 'まばたき').elements.slice(0, 2),
});
show('bone morph "怒り"', {
  ...pmx.morphs.find((m) => m.name === '怒り'),
  elements: pmx.morphs.find((m) => m.name === '怒り').elements.slice(0, 3),
});
const grp = pmx.morphs.find((m) => m.type === 0);
if (grp) show('group morph', { ...grp, elements: grp.elements.slice(0, 3) });

show('material[0]', pmx.materials[0]);
show('rigidBody[0]', pmx.rigidBodies[0]);
show('constraint[0]', pmx.constraints[0]);
