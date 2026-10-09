/**
 * ABxAG — path & secret resolution.
 *
 * Separates read-only *code/asset* locations (shipped with the app) from the
 * writable *data* location (per-user, survives reinstalls). In development both
 * collapse to the project root, so existing behaviour is unchanged. When the
 * packaged Electron app launches the backend it sets ABxAG_DATA_DIR to a
 * writable folder under %APPDATA%\ABxAG, because the install directory
 * (Program Files) is read-only.
 *
 * The Gemini API key is NOT shipped with the app. Each user supplies their own
 * on first run; it is stored here in the per-user data dir (never returned to
 * the frontend).
 */

import fs from "fs";
import path from "path";
import { SecretStore } from "./secrets/secretStore";

/** Writable per-user data directory. Falls back to cwd in development. */
export const DATA_DIR: string = process.env.ABxAG_DATA_DIR || process.cwd();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* already exists / best-effort */
}

/** Absolute path to a file inside the writable data directory. */
export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}

// ---------------------------------------------------------------------------
// Gemini API key store.
//
// The key lives in DPAPI-protected storage (secrets/secretStore.ts). The
// legacy plaintext secrets.json is migrated on first access and afterwards
// only carries the non-secret `ignoreEnvironmentApiKey` flag.
// ---------------------------------------------------------------------------
const SECRETS_FILE = dataFile("secrets.json");
export const secretStore = new SecretStore(DATA_DIR);
const GEMINI_SECRET = "provider:gemini";
let legacyMigrationAttempted = false;

function migrateLegacySecrets(): void {
  if (legacyMigrationAttempted) return;
  legacyMigrationAttempted = true;
  secretStore.migrateLegacyPlaintext(SECRETS_FILE, "geminiApiKey", GEMINI_SECRET);
}

interface Secrets {
  /** Legacy plaintext field; migrated into protected storage. */
  geminiApiKey?: string;
  /** Suppress a rejected development .env key until the user saves a replacement. */
  ignoreEnvironmentApiKey?: boolean;
}

function readSecrets(): Secrets {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8")) as Secrets;
    }
  } catch {
    /* corrupt — treat as empty */
  }
  return {};
}

/**
 * Resolve the active Gemini API key.
 * Priority: user-entered key (secrets.json) → environment (.env, dev only).
 */
export function getGeminiApiKey(): string | undefined {
  migrateLegacySecrets();
  const stored = secretStore.get(GEMINI_SECRET)?.trim();
  if (stored) return stored;
  const legacy = readSecrets();
  // A legacy plaintext key that could not be migrated still works.
  if (legacy.geminiApiKey?.trim()) return legacy.geminiApiKey.trim();
  if (legacy.ignoreEnvironmentApiKey) return undefined;
  const env = process.env.GEMINI_API_KEY?.trim();
  return env || undefined;
}

/** Whether any usable key is configured (without revealing it). */
export function hasGeminiApiKey(): boolean {
  return Boolean(getGeminiApiKey());
}

/** Persist a user-supplied key in protected storage. */
export function setGeminiApiKey(key: string): void {
  const trimmed = (key || "").trim();
  if (!trimmed) throw new Error("API key must not be empty.");
  secretStore.set(GEMINI_SECRET, trimmed);
  const current = readSecrets();
  delete current.geminiApiKey;
  delete current.ignoreEnvironmentApiKey;
  try {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

/** Remove the stored key (used by "reset"/sign-out flows). */
export function clearGeminiApiKey(): void {
  secretStore.delete(GEMINI_SECRET);
  const current = readSecrets();
  delete current.geminiApiKey;
  current.ignoreEnvironmentApiKey = true;
  try {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}



