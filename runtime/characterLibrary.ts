/**
 * User-imported character library.
 *
 * Imported models live under the shared characters folder (Electron userData
 * → `characters/<id>/`), never in the app bundle, so third-party model
 * licences that forbid redistribution are respected. Each folder holds the
 * staged model, its textures and a `profile.json` (skeleton mapping, physics,
 * poses, companion and persona settings, compatibility report).
 */
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { importCharacter, loadAllProfiles, renderReport, type ImportResult } from "../character_import/importer";
import { defaultCharactersRoot } from "../character_import/paths";
import { analyzeRig, RUNTIME_TESTS, type CharacterProfile, type RuntimeTestResult } from "../shared/character/profile";
import { rigFromMmdParser } from "../shared/character/rig";
import { writeJsonFile } from "../shared/jsonFile";

const nodeRequire = createRequire(import.meta.url ?? __filename);

export interface CharacterProfileSummary {
  id: string;
  displayName: string;
  source: "user";
  modelUrl: string;
  textureMapUrl: string;
  profileUrl: string;
  restrictions: string[];
  importedAt?: string;
  /** Count of report items per status, for list badges. */
  summary: { supported: number; partial: number; unsupported: number; testsPassed: number; testsFailed: number };
}

const ID = /^[a-z0-9_-]{1,64}$/;

export class CharacterLibrary {
  readonly root: string;
  private importing: Promise<unknown> = Promise.resolve();

  constructor(root = defaultCharactersRoot()) {
    this.root = root;
  }

  private dir(id: string): string {
    if (!ID.test(id)) throw Object.assign(new Error("Invalid character id."), { status: 400 });
    return path.join(this.root, id);
  }

  async list(): Promise<CharacterProfileSummary[]> {
    const profiles = await loadAllProfiles(this.root);
    return profiles
      .map((profile) => {
        const items = profile.report?.items ?? [];
        const tests = Object.values(profile.report?.tests ?? {});
        return {
          id: profile.id,
          displayName: profile.displayName,
          source: "user" as const,
          modelUrl: `/user-characters/${profile.id}/${profile.model?.file ?? "model.pmx"}`,
          textureMapUrl: `/user-characters/${profile.id}/textures.json`,
          profileUrl: `/user-characters/${profile.id}/profile.json`,
          restrictions: profile.source?.restrictions ?? [],
          importedAt: profile.importedAt,
          summary: {
            supported: items.filter((i) => i.status === "supported").length,
            partial: items.filter((i) => i.status === "partial").length,
            unsupported: items.filter((i) => i.status === "unsupported").length,
            testsPassed: tests.filter((t) => t.status === "pass").length,
            testsFailed: tests.filter((t) => t.status === "fail").length,
          },
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async get(id: string): Promise<CharacterProfile> {
    const raw = await fs.readFile(path.join(this.dir(id), "profile.json"), "utf8").catch(() => null);
    if (!raw) throw Object.assign(new Error("Character not found."), { status: 404 });
    return JSON.parse(raw) as CharacterProfile;
  }

  /** Imports are serialised: each one converts large textures. */
  import(source: string, options: { displayName?: string; modelFile?: string; id?: string } = {}): Promise<ImportResult> {
    if (!source || !path.isAbsolute(source)) {
      return Promise.reject(Object.assign(new Error("Choose a local model file (.pmx/.pmd/.vrm/.glb/.gltf/.fbx/.obj), .zip or folder (absolute path)."), { status: 400 }));
    }
    const run = this.importing.then(() => importCharacter({ source, charactersRoot: this.root, ...options }));
    this.importing = run.catch(() => undefined);
    return run;
  }

  /**
   * Update user-editable parts of a profile. Mapping/physics overrides
   * trigger a re-analysis of the staged model so the report stays truthful.
   */
  async update(id: string, patch: Partial<Pick<CharacterProfile, "displayName" | "scale" | "groundOffset" | "companion" | "persona" | "overrides">>): Promise<CharacterProfile> {
    const profile = await this.get(id);
    if (typeof patch.displayName === "string" && patch.displayName.trim()) profile.displayName = patch.displayName.trim().slice(0, 60);
    if (Number.isFinite(patch.scale) && patch.scale! > 0.01 && patch.scale! < 100) profile.scale = patch.scale!;
    if (Number.isFinite(patch.groundOffset) && Math.abs(patch.groundOffset!) < 100) profile.groundOffset = patch.groundOffset!;
    if (patch.companion && typeof patch.companion === "object") {
      const c = patch.companion;
      profile.companion = {
        scale: Number.isFinite(c.scale) && c.scale > 0.2 && c.scale < 4 ? c.scale : profile.companion.scale,
        anchor: ["free", "taskbar", "window", "screen-edge"].includes(c.anchor) ? c.anchor : profile.companion.anchor,
        sitOffset: Number.isFinite(c.sitOffset) && Math.abs(c.sitOffset) < 10 ? c.sitOffset : profile.companion.sitOffset,
      };
    }
    if (patch.persona && typeof patch.persona === "object") {
      profile.persona = {
        voiceName: typeof patch.persona.voiceName === "string" ? patch.persona.voiceName.slice(0, 40) : profile.persona.voiceName,
        personalityId: typeof patch.persona.personalityId === "string" ? patch.persona.personalityId.slice(0, 40) : profile.persona.personalityId,
      };
    }
    if (patch.overrides && typeof patch.overrides === "object") {
      profile.overrides = { ...profile.overrides, ...patch.overrides };
      await this.reanalyse(profile);
    }
    profile.updatedAt = new Date().toISOString();
    await this.save(profile);
    return profile;
  }

  private async reanalyse(profile: CharacterProfile): Promise<void> {
    // Generic formats have no MMD rig to re-analyse — overrides apply at
    // runtime by bone name, so the staged profile stays as imported.
    if (profile.model?.format !== "pmx" && profile.model?.format !== "pmd") return;
    const buffer = await fs.readFile(path.join(this.dir(profile.id), profile.model.file));
    const { Parser } = nodeRequire("mmd-parser");
    const rig = rigFromMmdParser(new Parser().parsePmx(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)));
    const analysis = analyzeRig(rig, profile.overrides);
    const textureItem = profile.report.items.find((i) => i.feature === "Textures & materials");
    profile.skeleton = analysis.skeleton;
    profile.morphs = analysis.morphs;
    profile.materials = analysis.materials;
    profile.physics = analysis.physics;
    profile.facing = analysis.facing;
    profile.report = { ...profile.report, generatedAt: new Date().toISOString(), items: [...analysis.items, ...(textureItem ? [textureItem] : [])] };
  }

  async recordTests(id: string, results: Record<string, RuntimeTestResult>): Promise<CharacterProfile> {
    const profile = await this.get(id);
    const at = new Date().toISOString();
    for (const [name, result] of Object.entries(results || {})) {
      if (!(RUNTIME_TESTS as readonly string[]).includes(name)) continue;
      if (!result || !["pass", "fail", "not-run"].includes(result.status)) continue;
      profile.report.tests[name] = { status: result.status, detail: String(result.detail ?? "").slice(0, 400), at };
    }
    await this.save(profile);
    return profile;
  }

  async remove(id: string): Promise<boolean> {
    const dir = this.dir(id);
    const exists = await fs.stat(path.join(dir, "profile.json")).then(() => true, () => false);
    if (!exists) return false;
    // Only ABxAG's staged copy is removed; the user's original files are untouched.
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  }

  private async save(profile: CharacterProfile): Promise<void> {
    const dir = this.dir(profile.id);
    await writeJsonFile(path.join(dir, "profile.json"), profile);
    await fs.writeFile(path.join(dir, "REPORT.md"), renderReport(profile), "utf8");
  }
}

