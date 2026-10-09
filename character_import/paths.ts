/**
 * Where imported characters live.
 *
 * Shared by the packaged app, the dev server and the CLI importer so a model
 * imported once is available everywhere: Electron's userData folder
 * (%APPDATA%\ABxAG on Windows) unless overridden.
 */
import os from "node:os";
import path from "node:path";

export function defaultCharactersRoot(): string {
  if (process.env.ABxAG_CHARACTERS_DIR) return path.resolve(process.env.ABxAG_CHARACTERS_DIR);
  if (process.env.ABxAG_DATA_DIR) return path.join(process.env.ABxAG_DATA_DIR, "characters");
  const base = process.platform === "win32"
    ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "ABxAG", "characters");
}



