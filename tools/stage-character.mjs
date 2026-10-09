/**
 * Stage a PMX character into the app's served asset folder.
 *
 * PMX files reference their textures by relative path using the original
 * author's locale-encoded filenames (e.g. `tex\衣.tga`). Serving those over
 * HTTP is fragile across platforms, and the TGAs are enormous. This script:
 *
 *   1. copies the .pmx verbatim (never modified - the model is redistributed
 *      under the author's terms and its internal data stays untouched),
 *   2. rewrites every referenced texture to a safe ASCII filename,
 *      converting TGA -> PNG on the way,
 *   3. writes `textures.json`, the internal-path -> served-file map that the
 *      runtime loader feeds to THREE.LoadingManager.setURLModifier().
 *
 * Usage:
 *   node tools/stage-character.mjs <source-dir> <model.pmx> <dest-dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import mmdParser from 'mmd-parser';
import { decodeTga, encodePng } from './tga2png.mjs';

const [, , sourceDir, pmxName, destDir] = process.argv;
if (!sourceDir || !pmxName || !destDir) {
  console.error('Usage: node tools/stage-character.mjs <source-dir> <model.pmx> <dest-dir>');
  process.exit(1);
}

const pmxPath = path.join(sourceDir, pmxName);
const buf = fs.readFileSync(pmxPath);
const pmx = new mmdParser.Parser().parsePmx(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
);

fs.mkdirSync(path.join(destDir, 'textures'), { recursive: true });

// Copy the model itself under a stable ASCII name.
fs.writeFileSync(path.join(destDir, 'model.pmx'), buf);
console.log(`model.pmx  (${(buf.length / 1048576).toFixed(2)} MB)`);

/** Resolve a PMX-internal texture path (backslash separated) against the source dir. */
const resolveSource = (internal) => path.join(sourceDir, ...internal.split(/[\\/]/));

const map = {};
pmx.textures.forEach((internal, index) => {
  const src = resolveSource(internal);
  if (!fs.existsSync(src)) {
    console.warn(`  ! missing texture referenced by model: ${internal}`);
    return;
  }

  const ext = path.extname(internal).toLowerCase();
  // Browsers decode BMP/JPG/PNG natively; only TGA needs converting.
  const outName = ext === '.tga' ? `tex_${index}.png` : `tex_${index}${ext}`;
  const outPath = path.join(destDir, 'textures', outName);

  if (ext === '.tga') {
    const { width, height, rgba } = decodeTga(fs.readFileSync(src));
    const png = encodePng(width, height, rgba);
    fs.writeFileSync(outPath, png);
    const before = fs.statSync(src).size;
    console.log(
      `  [${index}] ${internal} -> textures/${outName}  ${width}x${height}  ` +
        `${(before / 1048576).toFixed(1)} MB -> ${(png.length / 1048576).toFixed(2)} MB`
    );
  } else {
    fs.copyFileSync(src, outPath);
    console.log(`  [${index}] ${internal} -> textures/${outName}  (copied)`);
  }

  map[internal] = `textures/${outName}`;
});

fs.writeFileSync(
  path.join(destDir, 'textures.json'),
  JSON.stringify({ model: 'model.pmx', textures: map }, null, 2),
  'utf8'
);

const total = fs
  .readdirSync(path.join(destDir, 'textures'))
  .reduce((sum, f) => sum + fs.statSync(path.join(destDir, 'textures', f)).size, 0);
console.log(`\nStaged to ${destDir}`);
console.log(`Textures total: ${(total / 1048576).toFixed(2)} MB across ${Object.keys(map).length} files`);
