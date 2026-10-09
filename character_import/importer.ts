/**
 * Generic local character importer.
 *
 *   source (.zip / folder / model file)
 *     → pick the main model (the humanoid, not the weapon or prop files)
 *     → stage a converted cache copy under <characters>/<id>/
 *          model.<ext>     byte-identical copy of the original model
 *                          (model.pmx for PMX, model.vrm / model.glb / … otherwise)
 *          textures/       textures renamed to safe ASCII (TGA → PNG)
 *          textures.json   internal texture path → staged file
 *          profile.json    CharacterProfile (mapping, physics, report…)
 *          REPORT.md       human-readable compatibility report
 *          LICENSE-README.txt  the author's readme, kept with the model
 *
 * The original archive or folder is never modified. Staged characters live
 * in the user's data folder, never in the application bundle, so models whose
 * licence forbids redistribution are not shipped with ABxAG.
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { rigFromMmdParser, type RigDescription } from "../shared/character/rig";
import {
  PROFILE_SCHEMA, analyzeRig, extractRestrictions, slugify, type AnalysisResult, type CharacterProfile,
} from "../shared/character/profile";
import { HUMANOID_SLOTS } from "../shared/character/humanoid";
import { ZipArchive } from "./zip";
// @ts-ignore - plain ESM helper shared with the CLI staging script.
import { decodeTga, encodePng } from "../tools/tga2png.mjs";

const nodeRequire = createRequire(import.meta.url ?? __filename);

/** Every model format ABxAG can stage and render. PMX/PMD go through the
 *  full MMD pipeline (rig, morphs, physics); VRM/GLB/glTF/FBX/OBJ load
 *  through the generic three.js path (mesh + humanoid bone mapping). */
export const SUPPORTED_MODEL_EXTS = ["pmx", "pmd", "vrm", "glb", "gltf", "fbx", "obj"] as const;
export type SupportedModelFormat = (typeof SUPPORTED_MODEL_EXTS)[number];
const MODEL_FILE_RE = /\.(pmx|pmd|vrm|glb|gltf|fbx|obj)$/i;

export function detectModelFormat(fileName: string): SupportedModelFormat | null {
  const m = /\.([a-z0-9]+)$/i.exec(fileName);
  if (!m) return null;
  const ext = m[1].toLowerCase() as SupportedModelFormat;
  return (SUPPORTED_MODEL_EXTS as readonly string[]).includes(ext) ? ext : null;
}

export interface ImportOptions {
  /** .zip, model file or a folder. */
  source: string;
  /** Root folder holding all imported characters. */
  charactersRoot: string;
  displayName?: string;
  /** Pick a specific model file inside the archive/folder (relative path). */
  modelFile?: string;
  /** Re-import into an existing id, keeping its user overrides. */
  id?: string;
  onProgress?: (phase: string, ratio: number) => void;
}

export interface ImportResult {
  profile: CharacterProfile;
  directory: string;
  warnings: string[];
  replaced: boolean;
}

interface SourceFiles {
  kind: CharacterProfile["source"]["kind"];
  /** Folder containing the source files (a temp extraction for archives). */
  root: string;
  sha256: string;
  cleanup: () => Promise<void>;
}

async function hashFile(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, rel)));
    else out.push(rel);
  }
  return out;
}

async function openSource(source: string, scratch: string): Promise<SourceFiles> {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat) throw new Error(`Source not found: ${source}`);
  if (stat.isDirectory()) {
    const files = await listFiles(source);
    const hash = createHash("sha256");
    for (const file of files.filter((f) => MODEL_FILE_RE.test(f)).sort()) hash.update(await fs.readFile(path.join(source, file)));
    return { kind: "folder", root: source, sha256: hash.digest("hex"), cleanup: async () => undefined };
  }
  if (/\.zip$/i.test(source)) {
    const archive = await ZipArchive.open(source);
    const root = path.join(scratch, "source");
    await archive.extractAll(root);
    return { kind: "zip", root, sha256: await hashFile(source), cleanup: () => fs.rm(root, { recursive: true, force: true }) };
  }
  {
    const format = detectModelFormat(source);
    if (format) {
      return { kind: format, root: path.dirname(source), sha256: await hashFile(source), cleanup: async () => undefined };
    }
  }
  throw new Error("Unsupported character source. Use a .zip archive, a folder, or a model file (.pmx/.pmd/.vrm/.glb/.gltf/.fbx/.obj).");
}

function parsePmx(buffer: Buffer): any {
  const { Parser } = nodeRequire("mmd-parser");
  return new Parser().parsePmx(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/** PMD (older MMD format) parses through the same mmd-parser package. */
function parseMmd(buffer: Buffer, fileName: string): any {
  const { Parser } = nodeRequire("mmd-parser");
  const parser = new Parser();
  const view = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  if (/\.pmd$/i.test(fileName) && typeof parser.parsePmd === "function") {
    return parser.parsePmd(view);
  }
  return parser.parsePmx(view);
}

/** Score a model as "the character": humanoid bones and size beat props. */
function scoreModel(rig: RigDescription): number {
  const analysis = analyzeRig(rig);
  const mapped = Object.keys(analysis.skeleton.humanoid).length;
  return mapped * 1000 + rig.bones.length + rig.vertexCount / 1000;
}

/** Case-insensitive path resolution (archives are often authored on Windows). */
async function resolveInsensitive(root: string, relative: string): Promise<string | null> {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    const entries = await fs.readdir(current).catch(() => [] as string[]);
    const hit = entries.find((e) => e === part) ?? entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    current = path.join(current, hit);
  }
  return current;
}

async function readTextAuto(file: string): Promise<string> {
  const bytes = await fs.readFile(file);
  for (const encoding of ["utf-8", "gbk", "shift_jis"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes).replace(/^﻿/, "");
    } catch {
      /* next */
    }
  }
  return bytes.toString("latin1");
}

export async function importCharacter(options: ImportOptions): Promise<ImportResult> {
  const report = (phase: string, ratio: number) => options.onProgress?.(phase, ratio);
  const warnings: string[] = [];
  await fs.mkdir(options.charactersRoot, { recursive: true });
  const scratch = path.join(options.charactersRoot, `.import-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(scratch, { recursive: true });
  let source: SourceFiles | null = null;
  try {
    report("Reading source", 0.02);
    source = await openSource(path.resolve(options.source), scratch);
    const files = await listFiles(source.root);
    const modelFiles = files.filter((f) => MODEL_FILE_RE.test(f));
    if (modelFiles.length === 0) throw new Error("No supported 3D model was found in the source (.pmx/.pmd/.vrm/.glb/.gltf/.fbx/.obj).");

    // ---- choose the main model ------------------------------------------
    // Preference: parseable MMD (pmx/pmd, full rig) first, then VRM/GLB,
    // then FBX/OBJ by file size. Props/weapons lose to humanoid-sized rigs.
    report("Inspecting models", 0.1);
    const wanted = options.modelFile
      ? modelFiles.filter((f) => f === options.modelFile || path.basename(f) === options.modelFile)
      : modelFiles;
    if (options.modelFile && wanted.length === 0) throw new Error(`Model ${options.modelFile} not found in the source.`);
    const mmdCandidates: Array<{ file: string; rig: RigDescription; buffer: Buffer; score: number; format: SupportedModelFormat }> = [];
    for (const file of wanted.filter((f) => /\.(pmx|pmd)$/i.test(f))) {
      const buffer = await fs.readFile(path.join(source.root, file));
      try {
        const rig = rigFromMmdParser(parseMmd(buffer, file));
        mmdCandidates.push({ file, rig, buffer, score: scoreModel(rig), format: detectModelFormat(file)! });
      } catch (error) {
        warnings.push(`Could not parse ${file}: ${(error as Error).message}`);
      }
    }
    let mainFile: string;
    let mainBuffer: Buffer;
    let mainFormat: SupportedModelFormat;
    let mainRig: RigDescription | null = null;
    if (mmdCandidates.length > 0) {
      mmdCandidates.sort((a, b) => b.score - a.score);
      mainFile = mmdCandidates[0].file;
      mainBuffer = mmdCandidates[0].buffer;
      mainFormat = mmdCandidates[0].format;
      mainRig = mmdCandidates[0].rig;
    } else {
      // Generic path: biggest model file wins (character >> prop).
      const sized: Array<{ file: string; size: number }> = [];
      for (const file of wanted) {
        const stat = await fs.stat(path.join(source.root, file)).catch(() => null);
        sized.push({ file, size: stat?.size ?? 0 });
      }
      sized.sort((a, b) => b.size - a.size);
      mainFile = sized[0].file;
      mainBuffer = await fs.readFile(path.join(source.root, mainFile));
      mainFormat = detectModelFormat(mainFile)!;
    }
    const companionModels = modelFiles.filter((f) => f !== mainFile);
    const modelDir = path.dirname(path.join(source.root, mainFile));
    const isMmd = mainRig !== null;

    // ---- identity --------------------------------------------------------
    const mainModelName = mainRig?.modelName || path.basename(mainFile, path.extname(mainFile));
    const mainEnglishName = mainRig?.englishModelName || "";
    const baseName = mainEnglishName || mainModelName || path.basename(mainFile, path.extname(mainFile));
    const existingProfiles = await loadAllProfiles(options.charactersRoot);
    let id = options.id ?? "";
    let previous: CharacterProfile | null = null;
    if (id) {
      previous = existingProfiles.find((p) => p.id === id) ?? null;
    } else {
      // Same source bytes → same character; re-import updates it in place.
      previous = existingProfiles.find((p) => p.source.sha256 === source!.sha256 && p.model.modelName === mainModelName) ?? null;
      if (previous) id = previous.id;
    }
    if (!id) {
      const base = slugify(baseName, `character-${source.sha256.slice(0, 8)}`);
      id = base;
      for (let n = 2; existingProfiles.some((p) => p.id === id) || (await exists(path.join(options.charactersRoot, id))); n += 1) id = `${base}-${n}`;
    }
    if (!/^[a-z0-9_-]{1,64}$/.test(id)) throw new Error(`Invalid character id "${id}".`);
    const sameNameCount = existingProfiles.filter((p) => p.id !== id && p.model.modelName === mainModelName).length;
    const displayName = options.displayName?.trim() || previous?.displayName || (sameNameCount > 0 ? `${baseName} ${sameNameCount + 1}` : baseName);

    // ---- stage files -----------------------------------------------------
    const stage = path.join(scratch, "stage");
    const stagedModelFile = `model.${mainFormat}`;
    await fs.mkdir(path.join(stage, "textures"), { recursive: true });
    await fs.writeFile(path.join(stage, stagedModelFile), mainBuffer);
    report("Converting textures", 0.25);
    const textureMap: Record<string, string> = {};
    const missing: string[] = [];
    let converted = 0;
    let referencedTextures = 0;
    if (isMmd && mainRig) {
      const pmx = parseMmd(mainBuffer, mainFile);
      const textures: string[] = pmx.textures ?? [];
      referencedTextures = textures.length;
      for (let index = 0; index < textures.length; index += 1) {
        const internal = textures[index];
        report("Converting textures", 0.25 + (0.5 * index) / Math.max(1, textures.length));
        const file = await resolveInsensitive(modelDir, internal);
        if (!file) {
          missing.push(internal);
          continue;
        }
        const ext = path.extname(internal).toLowerCase();
        try {
          if (ext === ".tga") {
            const { width, height, rgba } = decodeTga(await fs.readFile(file));
            await fs.writeFile(path.join(stage, "textures", `tex_${index}.png`), encodePng(width, height, rgba));
            textureMap[internal] = `textures/tex_${index}.png`;
            converted += 1;
          } else if ([".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp"].includes(ext)) {
            const out = `tex_${index}${ext === ".jpeg" ? ".jpg" : ext}`;
            await fs.copyFile(file, path.join(stage, "textures", out));
            textureMap[internal] = `textures/${out}`;
          } else {
            missing.push(`${internal} (unsupported format ${ext || "none"})`);
          }
        } catch (error) {
          missing.push(`${internal} (${(error as Error).message})`);
        }
      }
    } else {
      // Generic formats (VRM/GLB/FBX/OBJ): textures are usually embedded or
      // next to the model — copy every sibling image/material alongside it.
      report("Staging companion assets", 0.4);
      const siblingImages = files.filter((f) =>
        /\.(png|jpe?g|bmp|gif|webp|tga|tif?f|mtl|bin)$/i.test(f) && path.dirname(path.join(source.root, f)) === modelDir,
      );
      referencedTextures = siblingImages.length;
      let staged = 0;
      for (const rel of siblingImages) {
        const base = path.basename(rel).toLowerCase();
        if (base === path.basename(mainFile).toLowerCase()) continue;
        try {
          if (/\.tga$/i.test(rel)) {
            const { width, height, rgba } = decodeTga(await fs.readFile(path.join(source.root, rel)));
            await fs.writeFile(path.join(stage, "textures", `${path.basename(rel, path.extname(rel))}.png`), encodePng(width, height, rgba));
            converted += 1;
          } else {
            await fs.copyFile(path.join(source.root, rel), path.join(stage, "textures", path.basename(rel)));
          }
          staged += 1;
        } catch (error) {
          missing.push(`${rel} (${(error as Error).message})`);
        }
      }
      if (siblingImages.length === 0) {
        // GLB/VRM often embed textures — nothing to copy is normal.
        warnings.push(`${mainFile}: no external textures found (embedded textures are used at runtime).`);
      } else if (staged === 0) {
        missing.push(`${siblingImages.length} sibling asset(s) could not be staged`);
      }
    }
    await fs.writeFile(path.join(stage, "textures.json"), JSON.stringify({ model: stagedModelFile, textures: textureMap }, null, 2));
    if (missing.length) warnings.push(`${missing.length} texture(s) missing or unsupported: ${missing.slice(0, 5).join(", ")}`);

    // Licence / readme travels with the model.
    let licenseText: string | undefined;
    let licenseFile: string | undefined;
    const readme = files.find((f) => /readme|read_me|説明|说明|license|licence|利用規約|规约|規約|使用规则|使用規則|规则|規則|rules?|terms|注意事项|注意事項|必読|必读|一定要看/i.test(path.basename(f)) && /\.(txt|md)$/i.test(f));
    if (readme) {
      licenseText = (await readTextAuto(path.join(source.root, readme))).slice(0, 20000);
      licenseFile = readme;
      await fs.writeFile(path.join(stage, "LICENSE-README.txt"), licenseText, "utf8");
    }

    // ---- analyse ---------------------------------------------------------
    // MMD models get the full rig analysis (humanoid map, morphs, physics).
    // Generic formats (VRM/GLB/FBX/OBJ) are staged as-is; the renderer maps
    // their humanoid bones by name at load time, so we record a generic
    // profile here and let the runtime report refine it.
    report("Analysing skeleton and physics", 0.8);
    const overrides = previous?.overrides ?? {};
    const analysis: AnalysisResult = isMmd && mainRig
      ? analyzeRig(mainRig, overrides)
      : {
          facing: 1,
          height: 1.7,
          skeleton: { humanoid: {}, bones: [], notes: [`${mainFormat.toUpperCase()} model: humanoid bones are mapped at runtime by name.`] },
          morphs: { map: {}, available: [] },
          materials: { roles: {} },
          physics: { chains: [], colliders: [], nodeGroups: {}, notes: [`${mainFormat.toUpperCase()} physics (spring/cloth) auto-detects at runtime when bone names match.`] },
          items: [
            {
              feature: "Model format",
              status: "supported" as const,
              detail: `${mainFormat.toUpperCase()} staged as ${stagedModelFile}; loads through the generic three.js path.`,
            },
            {
              feature: "Face morphs & physics",
              status: "partial" as const,
              detail: "MMD morphs/physics auto-apply to PMX/PMD only; VRM/GLB/FBX/OBJ use bone animation + material fallback.",
            },
          ],
        } as AnalysisResult;
    const now = new Date().toISOString();
    const sameModel = previous?.source.sha256 === source.sha256;
    const profile: CharacterProfile = {
      schema: PROFILE_SCHEMA,
      id,
      displayName,
      importedAt: previous?.importedAt ?? now,
      updatedAt: now,
      source: {
        kind: source.kind,
        originalPath: path.resolve(options.source),
        originalName: path.basename(options.source),
        sha256: source.sha256,
        companionModels,
        licenseFile,
        licenseText,
        restrictions: licenseText ? extractRestrictions(licenseText) : [],
      },
      model: {
        format: mainFormat,
        file: stagedModelFile,
        textureMap: "textures.json",
        modelName: mainModelName,
        englishName: mainEnglishName,
        vertexCount: mainRig?.vertexCount ?? 0,
        boneCount: mainRig?.bones.length ?? 0,
        morphCount: mainRig?.morphs.length ?? 0,
        materialCount: mainRig?.materials.length ?? 0,
        rigidBodyCount: mainRig?.bodies.length ?? 0,
        jointCount: mainRig?.joints.length ?? 0,
        textures: { referenced: referencedTextures, staged: Object.keys(textureMap).length, converted, missing },
      },
      facing: analysis.facing,
      height: analysis.height,
      // Normalise every character to roughly the same on-screen size as the
      // built-in one (≈ 20 model units tall) unless the user changed it.
      scale: previous?.scale ?? (analysis.height > 0 ? +(20 / analysis.height).toFixed(4) : 1),
      groundOffset: previous?.groundOffset ?? 0,
      skeleton: analysis.skeleton,
      morphs: analysis.morphs,
      materials: analysis.materials,
      physics: analysis.physics,
      report: {
        generatedAt: now,
        items: [
          ...analysis.items,
          {
            feature: "Textures & materials",
            status: missing.length === 0 ? "supported" : Object.keys(textureMap).length > 0 ? "partial" : "unsupported",
            detail: missing.length === 0
              ? `${Object.keys(textureMap).length} textures staged (${converted} converted from TGA to PNG).`
              : `${missing.length} referenced texture(s) missing or unsupported: ${missing.slice(0, 4).join(", ")}.`,
          },
        ],
        tests: sameModel ? (previous?.report.tests ?? {}) : {},
      },
      companion: previous?.companion ?? { scale: 1, anchor: "free", sitOffset: 0 },
      persona: previous?.persona ?? {},
      overrides,
    };
    await fs.writeFile(path.join(stage, "profile.json"), JSON.stringify(profile, null, 2), "utf8");
    await fs.writeFile(path.join(stage, "REPORT.md"), renderReport(profile), "utf8");
    await fs.writeFile(
      path.join(stage, "LOCAL-ONLY.txt"),
      "This character was imported from your own files. It is stored only in your ABxAG data folder and is never bundled with or uploaded by ABxAG.\n" +
        (profile.source.restrictions.length ? `Author restrictions: ${profile.source.restrictions.join("; ")}.\n` : ""),
      "utf8"
    );

    // ---- commit atomically ----------------------------------------------
    report("Saving", 0.95);
    const target = path.join(options.charactersRoot, id);
    let replaced = false;
    if (await exists(target)) {
      replaced = true;
      // Keep the user's saved poses across re-imports.
      const posesDir = path.join(target, "poses");
      if (await exists(posesDir)) await fs.cp(posesDir, path.join(stage, "poses"), { recursive: true });
      const trash = path.join(scratch, "previous");
      await fs.rename(target, trash);
    }
    await fs.rename(stage, target);
    report("Imported", 1);
    return { profile, directory: target, warnings, replaced };
  } finally {
    await source?.cleanup().catch(() => undefined);
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true, () => false);
}

export async function loadAllProfiles(root: string): Promise<CharacterProfile[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: CharacterProfile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9_-]{1,64}$/.test(entry.name)) continue;
    try {
      const profile = JSON.parse(await fs.readFile(path.join(root, entry.name, "profile.json"), "utf8")) as CharacterProfile;
      if (profile && profile.id === entry.name) out.push(profile);
    } catch {
      /* not a character folder */
    }
  }
  return out;
}

const STATUS_ICON = { supported: "✅", partial: "⚠️", unsupported: "❌" } as const;
const TEST_ICON = { pass: "✅ pass", fail: "❌ fail", "not-run": "— not run" } as const;

export function renderReport(profile: CharacterProfile): string {
  const lines = [
    `# ${profile.displayName} — Character Compatibility Report`,
    "",
    `Model: ${profile.model.modelName}${profile.model.englishName && profile.model.englishName !== profile.model.modelName ? ` (${profile.model.englishName})` : ""} · ${profile.model.vertexCount.toLocaleString()} vertices · ${profile.model.boneCount} bones · ${profile.model.morphCount} morphs · ${profile.model.rigidBodyCount} rigid bodies`,
    `Source: ${profile.source.originalName} (${profile.source.kind}) · imported ${profile.importedAt}`,
    profile.source.restrictions.length ? `Author restrictions (kept local, never bundled): ${profile.source.restrictions.join("; ")}` : "",
    "",
    "## Capabilities",
    "",
    "| Feature | Status | Detail |",
    "|---|---|---|",
    ...profile.report.items.map((item) => `| ${item.feature} | ${STATUS_ICON[item.status]} ${item.status} | ${item.detail.replace(/\|/g, "/")} |`),
    "",
    "## Runtime tests",
    "",
    "| Test | Result | Detail |",
    "|---|---|---|",
    ...Object.entries(profile.report.tests).map(([name, t]) => `| ${name} | ${TEST_ICON[t.status]} | ${t.detail.replace(/\|/g, "/")} |`),
    Object.keys(profile.report.tests).length === 0 ? "| (none yet) | — not run | Open the character in ABxAG → Character → Run compatibility tests |" : "",
    "",
    "## Skeleton mapping",
    "",
    `${Object.keys(profile.skeleton.humanoid).length}/${HUMANOID_SLOTS.length} humanoid slots mapped; ${profile.skeleton.bones.filter((b) => b.rotatable).length} rotatable bones available in the advanced editor.`,
    "",
    ...HUMANOID_SLOTS.map((slot) => `- ${slot}: ${profile.skeleton.humanoid[slot] ? `${profile.skeleton.humanoid[slot].bone} (${profile.skeleton.humanoid[slot].method})` : "— not present"}`),
    ...(profile.skeleton.notes.length ? ["", "Notes:", ...profile.skeleton.notes.map((n) => `- ${n}`)] : []),
    "",
    "## Physics chains",
    "",
    ...profile.physics.chains.map((c) => `- ${c.id}: ${c.class} · ${c.material} · ${c.bones.length} bones · anchored to ${c.anchor ?? "root"} · classified by ${c.classifiedBy}${c.enabled ? "" : " · disabled"}`),
    "",
    `Colliders: ${profile.physics.colliders.length} (${profile.physics.colliders.filter((c) => c.source === "rigid-body").length} from rigid bodies)`,
    ...profile.physics.notes.map((n) => `- ${n}`),
  ];
  return lines.filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n") + "\n";
}

