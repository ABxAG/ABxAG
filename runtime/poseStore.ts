/**
 * Saved poses per character. A pose stores local bone rotations keyed by
 * semantic slot when known (portable across characters with a mapped rig)
 * and by raw bone name otherwise.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";

export interface SavedPose {
  id: string;
  name: string;
  characterId: string;
  createdAt: string;
  updatedAt: string;
  /** slot or bone name → quaternion [x, y, z, w] (local, relative to rest). */
  bones: Record<string, [number, number, number, number]>;
  /** Optional root offset in model units. */
  rootOffset?: [number, number, number];
  /** Bone translation offsets (translatable bones such as the centre). */
  translations?: Record<string, [number, number, number]>;
  /** "bind": rotations are relative to the model's bind pose (portable). */
  space?: "bind";
  tags: string[];
  builtIn?: boolean;
}

export class PoseStore {
  private poses: SavedPose[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "character", "poses.v1.json");
  }

  async initialize(): Promise<void> {
    const stored = await readJsonFile<{ poses: SavedPose[] }>(this.file, { poses: [] });
    this.poses = Array.isArray(stored.poses) ? stored.poses.filter(isValid) : [];
  }

  list(characterId?: string): SavedPose[] {
    return this.poses.filter((pose) => !characterId || pose.characterId === characterId || pose.characterId === "*");
  }

  async save(input: Omit<SavedPose, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<SavedPose> {
    const now = new Date().toISOString();
    const name = String(input.name || "").trim().slice(0, 60);
    if (!name) throw new Error("Pose name is required.");
    const bones: SavedPose["bones"] = {};
    for (const [key, value] of Object.entries(input.bones || {})) {
      if (Array.isArray(value) && value.length === 4 && value.every((n) => Number.isFinite(n)) && key.length <= 80) {
        const [x, y, z, w] = value.map(Number);
        const length = Math.hypot(x, y, z, w) || 1;
        bones[key] = [x / length, y / length, z / length, w / length];
      }
    }
    if (Object.keys(bones).length === 0) throw new Error("A pose needs at least one bone rotation.");
    if (Object.keys(bones).length > 600) throw new Error("Too many bones in pose.");
    const translations: Record<string, [number, number, number]> = {};
    for (const [key, value] of Object.entries(input.translations || {})) {
      if (Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(n) && Math.abs(n) < 1000) && key.length <= 80) {
        translations[key] = [Number(value[0]), Number(value[1]), Number(value[2])];
      }
    }
    const existing = input.id ? this.poses.find((pose) => pose.id === input.id) : undefined;
    const pose: SavedPose = {
      id: existing?.id || randomUUID(),
      name,
      characterId: String(input.characterId || "*").slice(0, 64),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      bones,
      translations: Object.keys(translations).length ? translations : undefined,
      space: input.space === "bind" ? "bind" : undefined,
      rootOffset: Array.isArray(input.rootOffset) && input.rootOffset.length === 3 && input.rootOffset.every(Number.isFinite) ? input.rootOffset : undefined,
      tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 8) : [],
    };
    this.poses = this.poses.filter((item) => item.id !== pose.id);
    this.poses.push(pose);
    await writeJsonFile(this.file, { poses: this.poses });
    return pose;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.poses.length;
    this.poses = this.poses.filter((pose) => pose.id !== id);
    if (before !== this.poses.length) await writeJsonFile(this.file, { poses: this.poses });
    return before !== this.poses.length;
  }
}

function isValid(pose: SavedPose): boolean {
  return Boolean(pose && pose.id && pose.name && pose.bones && typeof pose.bones === "object");
}
