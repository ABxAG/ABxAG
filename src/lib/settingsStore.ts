/**
 * ABxAG Settings Store — persistent user preferences (V2).
 *
 * Establishes the persistence pattern for ABxAG: settings are mirrored to
 * localStorage (instant local read) AND synced to the backend (settings.json)
 * so auto-start / wake-word preferences survive across browsers and the
 * Python desktop agent can read them too.
 *
 * Pattern follows the existing codebase conventions: plain state + ref mirrors.
 * No Context/Zustand — this is deliberately lightweight to match audio.ts/memoryTypes.ts.
 */

export interface ABxAGSettings {
  /** Launch ABxAG (backends + browser tab) silently on Windows login. */
  autoStart: boolean;
  /** Enable the always-listening wake-word detector. */
  wakeWordEnabled: boolean;
  /** Phrase that activates ABxAG (case-insensitive substring match). */
  wakePhrase: string;
  /** Preferred microphone device id ("" = system default). */
  micDeviceId: string;
  /** Wake-word sensitivity: 0 (strict) .. 100 (loose). Affects debounce window. */
  sensitivity: number;
  /** Master toggle for UI animations. */
  animations: boolean;
  /** Reflected character highlight amount: 0 (matte) .. 100 (strong). */
  characterShine: number;
}

export const DEFAULT_SETTINGS: ABxAGSettings = {
  autoStart: false,
  wakeWordEnabled: false,
  wakePhrase: "hey ab",
  micDeviceId: "",
  sensitivity: 60,
  animations: true,
  characterShine: 50,
};

const STORAGE_KEY = "abxag.settings.v2";

/** Settings keys that the browser should never persist (security). */
const NEVER_PERSIST: ReadonlySet<keyof ABxAGSettings> = new Set([]);

/**
 * Load settings from localStorage, merged over defaults so new keys always
 * have a sane value even when an older payload is present.
 */
export function loadSettings(): ABxAGSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ABxAGSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // One-time migration: the default wake phrase changed from "hey abxag"
    // to "hey ab". Users who never customised it follow the new default.
    if (typeof merged.wakePhrase === "string" && merged.wakePhrase.trim().toLowerCase() === "hey abxag") {
      merged.wakePhrase = DEFAULT_SETTINGS.wakePhrase;
    }
    const shine = Number(merged.characterShine);
    return {
      ...merged,
      characterShine: Number.isFinite(shine) ? Math.max(0, Math.min(100, shine)) : 50,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist a full or partial settings update to localStorage.
 * Returns the fully merged settings object.
 */
export function saveSettings(patch: Partial<ABxAGSettings>): ABxAGSettings {
  const current = loadSettings();
  const next: ABxAGSettings = { ...current, ...patch };
  if (typeof window !== "undefined") {
    try {
      // Strip any sensitive keys before writing to localStorage.
      const safe: Record<string, unknown> = {};
      (Object.keys(next) as (keyof ABxAGSettings)[]).forEach((k) => {
        if (!NEVER_PERSIST.has(k)) safe[k] = next[k];
      });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
    } catch {
      /* localStorage may be unavailable (private mode) — fail silently. */
    }
  }
  // Best-effort sync to backend so the Python agent can read auto-start state.
  void syncSettingsToBackend(next).catch(() => {});
  return next;
}

/** Push settings to the backend (server.ts persists to settings.json). */
async function syncSettingsToBackend(settings: ABxAGSettings): Promise<void> {
  try {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch {
    /* Backend may be briefly unavailable during boot — non-fatal. */
  }
}


