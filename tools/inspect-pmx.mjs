// Inspect a PMX model: dump bones, morphs, rigid bodies, joints, materials.
import fs from 'node:fs';
import pkg from 'mmd-parser';

const { Parser } = pkg;
const file = process.argv[2];
const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const parser = new Parser();
const pmx = parser.parsePmx(ab);

const out = {};
out.header = pmx.metadata;

out.counts = {
  vertices: pmx.metadata.vertexCount,
  faces: pmx.metadata.faceCount,
  materials: pmx.metadata.materialCount,
  bones: pmx.metadata.boneCount,
  morphs: pmx.metadata.morphCount,
  rigidBodies: pmx.metadata.rigidBodyCount,
  joints: pmx.metadata.constraintCount,
  textures: pmx.metadata.textureCount,
};

out.materials = pmx.materials.map((m, i) => ({
  i,
  name: m.name,
  englishName: m.englishName,
  faceCount: m.faceCount,
  diffuse: m.diffuse,
  specular: m.specular,
  shininess: m.shininess,
  ambient: m.ambient,
  textureIndex: m.textureIndex,
  envTextureIndex: m.envTextureIndex,
  envFlag: m.envFlag,
  toonIndex: m.toonIndex,
  toonFlag: m.toonFlag,
  flag: m.flag,
  edgeSize: m.edgeSize,
  edgeColor: m.edgeColor,
}));

out.textures = pmx.textures;

out.bones = pmx.bones.map((b, i) => ({
  i,
  name: b.name,
  englishName: b.englishName,
  parentIndex: b.parentIndex,
  position: b.position.map((v) => +v.toFixed(4)),
  flag: b.flag,
  ik: b.ik ? { target: b.ik.target, iteration: b.ik.iteration, links: b.ik.links?.length } : undefined,
}));

const morphTypeName = (t) =>
  ({ 0: 'group', 1: 'vertex', 2: 'bone', 3: 'uv', 4: 'uv1', 5: 'uv2', 6: 'uv3', 7: 'uv4', 8: 'material', 9: 'flip', 10: 'impulse' }[t] || `type${t}`);
const panelName = (p) =>
  ({ 0: 'system', 1: 'eyebrow', 2: 'eye', 3: 'mouth', 4: 'other' }[p] || `panel${p}`);

out.morphs = pmx.morphs.map((m, i) => ({
  i,
  name: m.name,
  englishName: m.englishName,
  panel: panelName(m.panel),
  type: morphTypeName(m.type),
  elementCount: m.elementCount,
}));

out.rigidBodies = pmx.rigidBodies.map((r, i) => ({
  i,
  name: r.name,
  boneIndex: r.boneIndex,
  groupIndex: r.groupIndex,
  shapeType: ['sphere', 'box', 'capsule'][r.shapeType] ?? r.shapeType,
  width: +r.width.toFixed(4),
  height: +r.height.toFixed(4),
  depth: +r.depth.toFixed(4),
  position: r.position.map((v) => +v.toFixed(3)),
  mass: r.weight,
  positionDamping: r.positionDamping,
  rotationDamping: r.rotationDamping,
  friction: r.friction,
  restitution: r.restitution,
  type: ['kinematic(bone)', 'dynamic', 'dynamic+bonepos'][r.type] ?? r.type,
}));

out.joints = pmx.constraints.map((c, i) => ({
  i,
  name: c.name,
  rigidBodyIndex1: c.rigidBodyIndex1,
  rigidBodyIndex2: c.rigidBodyIndex2,
  translationLimitation1: c.translationLimitation1?.map((v) => +v.toFixed(3)),
  translationLimitation2: c.translationLimitation2?.map((v) => +v.toFixed(3)),
  rotationLimitation1: c.rotationLimitation1?.map((v) => +v.toFixed(3)),
  rotationLimitation2: c.rotationLimitation2?.map((v) => +v.toFixed(3)),
  springPosition: c.springPosition?.map((v) => +v.toFixed(3)),
  springRotation: c.springRotation?.map((v) => +v.toFixed(3)),
}));

fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out.counts, null, 2));
console.log('\n=== MORPHS ===');
for (const m of out.morphs) console.log(`${m.i}\t[${m.panel}/${m.type}]\t${m.name}\t| en: ${m.englishName}`);
