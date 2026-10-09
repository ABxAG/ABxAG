// Summarize a dumped PMX JSON: materials, dynamic physics chains, key bones.
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

console.log('=== MATERIALS ===');
for (const m of d.materials) {
  console.log(
    `${String(m.i).padStart(2)}  ${m.name}  | tex=${d.textures[m.textureIndex] ?? '-'} | env=${d.textures[m.envTextureIndex] ?? '-'}(mode ${m.envFlag}) | toonIdx=${m.toonIndex} toonFlag=${m.toonFlag} | shininess=${m.shininess} spec=[${m.specular}] | faces=${m.faceCount} | flag=${m.flag} edge=${m.edgeSize}`
  );
}

const byIndex = new Map(d.bones.map((b) => [b.i, b]));
const dyn = d.rigidBodies.filter((r) => r.type !== 'kinematic(bone)');
console.log(`\n=== DYNAMIC RIGID BODIES (${dyn.length} of ${d.rigidBodies.length}) ===`);
const groups = new Map();
for (const r of dyn) {
  const bone = byIndex.get(r.boneIndex);
  const key = (bone?.name ?? r.name).replace(/[0-9０-９]+$/u, '').trim();
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ rb: r.name, bone: bone?.name, mass: r.mass, pd: r.positionDamping, rd: r.rotationDamping, shape: r.shapeType, grp: r.groupIndex });
}
for (const [k, v] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n-- chain root "${k}" (${v.length} bodies)`);
  for (const x of v.slice(0, 6))
    console.log(`     rb=${x.rb} bone=${x.bone} mass=${x.mass} posDamp=${x.pd} rotDamp=${x.rd} shape=${x.shape} grp=${x.grp}`);
  if (v.length > 6) console.log(`     ... +${v.length - 6} more`);
}

console.log('\n=== IK BONES ===');
for (const b of d.bones.filter((b) => b.ik)) console.log(`${b.i}\t${b.name}\ttarget=${byIndex.get(b.ik.target)?.name} links=${b.ik.links} iter=${b.ik.iteration}`);

console.log('\n=== KEY STANDARD BONES ===');
const keys = ['全ての親','センター','グルーブ','腰','上半身','上半身2','上半身3','首','頭','両目','左目','右目','左肩','右肩','左腕','右腕','左ひじ','右ひじ','左手首','右手首','下半身','左足','右足','左ひざ','右ひざ','左足首','右足首'];
for (const k of keys) {
  const b = d.bones.find((x) => x.name === k);
  console.log(`${k.padEnd(8)} ${b ? `idx=${b.i} pos=[${b.position}] parent=${byIndex.get(b.parentIndex)?.name ?? b.parentIndex}` : 'MISSING'}`);
}

console.log('\n=== BONE NAME GROUPS (prefix histogram) ===');
const hist = new Map();
for (const b of d.bones) {
  const k = b.name.replace(/[0-9０-９_\-\s]+/gu, '').slice(0, 6);
  hist.set(k, (hist.get(k) ?? 0) + 1);
}
for (const [k, v] of [...hist].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${String(v).padStart(4)}  ${k}`);
