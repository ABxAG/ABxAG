/**
 * Import one or more local character models into ABxAG's data folder.
 *
 *   npx tsx tools/import-character.ts <model.zip|folder|model.pmx|model.pmd|model.vrm|model.glb|model.fbx|model.obj> [...more]
 *       [--name "Display Name"] [--model inner/file.pmx] [--id existing-id] [--root <characters dir>]
 *
 * Nothing is uploaded and the source files are not modified. Imported models
 * stay in the local data folder and are never packaged into the installer.
 */
import { importCharacter } from "../character_import/importer";
import { defaultCharactersRoot } from "../character_import/paths";

const args = process.argv.slice(2);
const sources: string[] = [];
const flags: Record<string, string> = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[++i] ?? "";
  else sources.push(args[i]);
}
if (sources.length === 0) {
  console.error("Usage: npx tsx tools/import-character.ts <source.zip|folder|model.pmx|model.pmd|model.vrm|model.glb|model.gltf|model.fbx|model.obj> [...] [--name N] [--model file] [--id id] [--root dir]");
  process.exit(1);
}
const root = flags.root || defaultCharactersRoot();
let failed = 0;
for (const source of sources) {
  const started = Date.now();
  try {
    const result = await importCharacter({
      source,
      charactersRoot: root,
      displayName: sources.length === 1 ? flags.name : undefined,
      modelFile: flags.model,
      id: sources.length === 1 ? flags.id : undefined,
    });
    const p = result.profile;
    const bad = p.report.items.filter((i) => i.status !== "supported");
    console.log(`\n✔ ${p.displayName}  →  ${result.directory}  (${((Date.now() - started) / 1000).toFixed(1)}s${result.replaced ? ", updated" : ""})`);
    console.log(`  ${p.model.boneCount} bones · ${Object.keys(p.skeleton.humanoid).length} humanoid slots · ${p.physics.chains.length} physics chains · ${p.physics.colliders.length} colliders · ${Object.keys(p.morphs.map).length} expression slots`);
    for (const item of bad) console.log(`  ${item.status === "partial" ? "⚠" : "✖"} ${item.feature}: ${item.detail}`);
    for (const warning of result.warnings) console.log(`  ! ${warning}`);
    if (p.source.restrictions.length) console.log(`  Licence: ${p.source.restrictions.join("; ")} — kept local only.`);
  } catch (error) {
    failed += 1;
    console.error(`\n✖ ${source}: ${(error as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);

