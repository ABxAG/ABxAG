/**
 * Server-side settings for the agent, presence, companion, character,
 * physics, privacy, performance and developer areas.
 *
 * Stored in `<data>/app-settings.v3.json`. The legacy `settings.json`
 * (auto-start, wake word, mic, shine) is left untouched because the Python
 * agent and the existing renderer already read it. Unknown keys are dropped,
 * values are clamped, and missing keys fall back to defaults, so older files
 * always load.
 */
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";

export interface AppSettings {
  version: 3;
  onboardingComplete: boolean;
  behavior: {
    proactivity: "quiet" | "balanced" | "lively";
    awayCheckin: boolean;
    returnGreeting: boolean;
    awayAfterMin: number;
    dndManual: boolean;
    autoDndFullscreen: boolean;
    autoDndMeetings: boolean;
    autoDndRecording: boolean;
  };
  autonomy: {
    maxSteps: number;
    conflictWaitSec: number;
    emergencyShortcut: string;
    showTaskHud: boolean;
  };
  voice: {
    voiceName: string;
    /** How she delivers lines: natural, or bright and cute (anime heroine). */
    style: "natural" | "anime";
    /** Raise her voice by this many semitones (0 = as Gemini speaks). */
    pitch: number;
    bargeIn: boolean;
    speakTaskUpdates: "all" | "important" | "none";
  };
  companion: {
    enabled: boolean;
    setupComplete: boolean;
    scale: number;
    monitorId: string | null;
    position: { x: number; y: number } | null;
    anchor: { kind: "free" | "desktop" | "taskbar" | "window"; edge?: "top" | "bottom" | "left" | "right"; offset?: number; windowTitle?: string } | null;
    fullscreenBehavior: "hide" | "notifications_only" | "always" | "game_aware";
    clickThrough: boolean;
    interactionLevel: "minimal" | "normal" | "playful";
    walkAround: boolean;
    /** She may pull desktop icons around (always restorable). Off by default. */
    iconPlay: boolean;
    /** 0..1: outline and shadow that keep her readable on busy wallpapers. */
    standOut: number;
    /** She sometimes hides behind a screen edge and peeks back in. */
    hideAndPeek: boolean;
  };
  character: {
    activeCharacterId: string;
    eyeFollowCursor: boolean;
    headFollowCursor: boolean;
    idleVariety: number;
  };
  graphics: {
    /** 0 = art-directed anime shading, 1 = physically based "realistic" shading. */
    realism: number;
    /** GPU budget: high, balanced (Medium), low (Optimized), potato. "auto" picks for the PC. */
    quality: "auto" | "potato" | "low" | "balanced" | "high";
    /** Levels Auto has stepped down after crashes on this PC (0..3). */
    autoStep: number;
  };
  physics: {
    enabled: boolean;
    quality: "low" | "balanced" | "high";
    secondaryMotion: number;
    gravityMultiplier: number;
    stiffness: number;
    damping: number;
    drag: number;
    collisionQuality: "off" | "low" | "high";
    wind: number;
    /** Vertex-level cloth on every garment (stays worn). */
    clothEnabled: boolean;
    /** 0..2: how far fabric may move away from the body. */
    clothLooseness: number;
  };
  privacy: {
    screenAwareness: boolean;
    cameraPresence: boolean;
    clipboardInContext: boolean;
  };
  performance: {
    activeFps: number;
    idleFps: number;
    sleepFps: number;
    perceptionPollSec: number;
  };
  developer: {
    debugView: boolean;
    physicsDebug: boolean;
    verboseLogs: boolean;
  };
  updates: {
    /** auto: check + download in the background; manual: only on demand. */
    mode: "auto" | "manual";
  };
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: 3,
  onboardingComplete: false,
  behavior: {
    proactivity: "balanced",
    awayCheckin: true,
    returnGreeting: true,
    awayAfterMin: 5,
    dndManual: false,
    autoDndFullscreen: true,
    autoDndMeetings: true,
    autoDndRecording: false,
  },
  autonomy: {
    maxSteps: 30,
    conflictWaitSec: 6,
    emergencyShortcut: "Control+Alt+Shift+S",
    showTaskHud: true,
  },
  voice: {
    voiceName: "Aoede",
    style: "natural",
    pitch: 0,
    bargeIn: true,
    speakTaskUpdates: "important",
  },
  companion: {
    enabled: false,
    setupComplete: false,
    scale: 1,
    monitorId: null,
    position: null,
    anchor: { kind: "taskbar", edge: "top", offset: 0.85 },
    fullscreenBehavior: "game_aware",
    clickThrough: true,
    interactionLevel: "normal",
    walkAround: true,
    iconPlay: false,
    standOut: 0.7,
    hideAndPeek: true,
  },
  character: {
    activeCharacterId: "evelyn",
    eyeFollowCursor: true,
    headFollowCursor: true,
    idleVariety: 0.6,
  },
  graphics: {
    realism: 0.85,
    quality: "auto",
    autoStep: 0,
  },
  physics: {
    enabled: true,
    quality: "balanced",
    secondaryMotion: 100,
    gravityMultiplier: 1,
    stiffness: 1,
    damping: 1,
    drag: 1,
    collisionQuality: "low",
    wind: 0,
    clothEnabled: true,
    clothLooseness: 1,
  },
  privacy: {
    screenAwareness: true,
    cameraPresence: false,
    clipboardInContext: false,
  },
  performance: {
    activeFps: 60,
    idleFps: 30,
    sleepFps: 10,
    perceptionPollSec: 4,
  },
  developer: {
    debugView: false,
    physicsDebug: false,
    verboseLogs: false,
  },
  updates: {
    mode: "auto",
  },
};

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? value as T : fallback);
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** Merge a (possibly partial or stale) settings object over defaults, validating every field. */
export function normalizeSettings(input: unknown, base: AppSettings = DEFAULT_APP_SETTINGS): AppSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const d = base;
  const b = raw.behavior || {}, a = raw.autonomy || {}, v = raw.voice || {}, c = raw.companion || {}, ch = raw.character || {}, p = raw.physics || {}, pr = raw.privacy || {}, pe = raw.performance || {}, dev = raw.developer || {}, gr = raw.graphics || {}, up = raw.updates || {};
  return {
    version: 3,
    onboardingComplete: bool(raw.onboardingComplete, d.onboardingComplete),
    behavior: {
      proactivity: oneOf(b.proactivity, ["quiet", "balanced", "lively"] as const, d.behavior.proactivity),
      awayCheckin: bool(b.awayCheckin, d.behavior.awayCheckin),
      returnGreeting: bool(b.returnGreeting, d.behavior.returnGreeting),
      awayAfterMin: clamp(b.awayAfterMin, 2, 60, d.behavior.awayAfterMin),
      dndManual: bool(b.dndManual, d.behavior.dndManual),
      autoDndFullscreen: bool(b.autoDndFullscreen, d.behavior.autoDndFullscreen),
      autoDndMeetings: bool(b.autoDndMeetings, d.behavior.autoDndMeetings),
      autoDndRecording: bool(b.autoDndRecording, d.behavior.autoDndRecording),
    },
    autonomy: {
      maxSteps: clamp(a.maxSteps, 5, 80, d.autonomy.maxSteps),
      conflictWaitSec: clamp(a.conflictWaitSec, 1, 30, d.autonomy.conflictWaitSec),
      emergencyShortcut: typeof a.emergencyShortcut === "string" && /^[A-Za-z0-9+]{3,40}$/.test(a.emergencyShortcut) ? a.emergencyShortcut : d.autonomy.emergencyShortcut,
      showTaskHud: bool(a.showTaskHud, d.autonomy.showTaskHud),
    },
    voice: {
      voiceName: typeof v.voiceName === "string" && /^[A-Za-z]{2,24}$/.test(v.voiceName) ? v.voiceName : d.voice.voiceName,
      style: oneOf(v.style, ["natural", "anime"] as const, d.voice.style),
      pitch: clamp(v.pitch, 0, 5, d.voice.pitch),
      bargeIn: bool(v.bargeIn, d.voice.bargeIn),
      speakTaskUpdates: oneOf(v.speakTaskUpdates, ["all", "important", "none"] as const, d.voice.speakTaskUpdates),
    },
    companion: {
      enabled: bool(c.enabled, d.companion.enabled),
      setupComplete: bool(c.setupComplete, d.companion.setupComplete),
      scale: clamp(c.scale, 0.4, 2.5, d.companion.scale),
      monitorId: typeof c.monitorId === "string" ? c.monitorId : c.monitorId === null ? null : d.companion.monitorId,
      position: c.position && Number.isFinite(c.position.x) && Number.isFinite(c.position.y) ? { x: Math.round(c.position.x), y: Math.round(c.position.y) } : c.position === null ? null : d.companion.position,
      anchor: c.anchor && typeof c.anchor === "object" && ["free", "desktop", "taskbar", "window"].includes(c.anchor.kind)
        ? {
            kind: c.anchor.kind,
            edge: oneOf(c.anchor.edge, ["top", "bottom", "left", "right"] as const, "top"),
            offset: clamp(c.anchor.offset, 0, 1, 0.5),
            ...(typeof c.anchor.windowTitle === "string" ? { windowTitle: c.anchor.windowTitle.slice(0, 200) } : {}),
          }
        : c.anchor === null ? null : d.companion.anchor,
      fullscreenBehavior: oneOf(c.fullscreenBehavior, ["hide", "notifications_only", "always", "game_aware"] as const, d.companion.fullscreenBehavior),
      clickThrough: bool(c.clickThrough, d.companion.clickThrough),
      interactionLevel: oneOf(c.interactionLevel, ["minimal", "normal", "playful"] as const, d.companion.interactionLevel),
      walkAround: bool(c.walkAround, d.companion.walkAround),
      iconPlay: bool(c.iconPlay, d.companion.iconPlay),
      standOut: clamp(c.standOut, 0, 1, d.companion.standOut),
      hideAndPeek: bool(c.hideAndPeek, d.companion.hideAndPeek),
    },
    character: {
      activeCharacterId: typeof ch.activeCharacterId === "string" && /^[a-z0-9_-]{1,64}$/.test(ch.activeCharacterId) ? ch.activeCharacterId : d.character.activeCharacterId,
      eyeFollowCursor: bool(ch.eyeFollowCursor, d.character.eyeFollowCursor),
      headFollowCursor: bool(ch.headFollowCursor, d.character.headFollowCursor),
      idleVariety: clamp(ch.idleVariety, 0, 1, d.character.idleVariety),
    },
    graphics: {
      realism: clamp(gr.realism, 0, 1, d.graphics.realism),
      quality: oneOf(gr.quality, ["auto", "potato", "low", "balanced", "high"] as const, d.graphics.quality),
      autoStep: Math.round(clamp(gr.autoStep, 0, 3, d.graphics.autoStep)),
    },
    physics: {
      enabled: bool(p.enabled, d.physics.enabled),
      quality: oneOf(p.quality, ["low", "balanced", "high"] as const, d.physics.quality),
      secondaryMotion: clamp(p.secondaryMotion, 0, 100, d.physics.secondaryMotion),
      gravityMultiplier: clamp(p.gravityMultiplier, 0, 3, d.physics.gravityMultiplier),
      stiffness: clamp(p.stiffness, 0.2, 3, d.physics.stiffness),
      damping: clamp(p.damping, 0.2, 3, d.physics.damping),
      drag: clamp(p.drag, 0.2, 3, d.physics.drag),
      collisionQuality: oneOf(p.collisionQuality, ["off", "low", "high"] as const, d.physics.collisionQuality),
      wind: clamp(p.wind, 0, 1, d.physics.wind),
      clothEnabled: bool(p.clothEnabled, d.physics.clothEnabled),
      clothLooseness: clamp(p.clothLooseness, 0, 2, d.physics.clothLooseness),
    },
    privacy: {
      screenAwareness: bool(pr.screenAwareness, d.privacy.screenAwareness),
      cameraPresence: bool(pr.cameraPresence, d.privacy.cameraPresence),
      clipboardInContext: bool(pr.clipboardInContext, d.privacy.clipboardInContext),
    },
    performance: {
      activeFps: clamp(pe.activeFps, 24, 144, d.performance.activeFps),
      idleFps: clamp(pe.idleFps, 10, 60, d.performance.idleFps),
      sleepFps: clamp(pe.sleepFps, 2, 30, d.performance.sleepFps),
      perceptionPollSec: clamp(pe.perceptionPollSec, 2, 30, d.performance.perceptionPollSec),
    },
    developer: {
      debugView: bool(dev.debugView, d.developer.debugView),
      physicsDebug: bool(dev.physicsDebug, d.developer.physicsDebug),
      verboseLogs: bool(dev.verboseLogs, d.developer.verboseLogs),
    },
    updates: {
      mode: oneOf(up.mode, ["auto", "manual"] as const, d.updates.mode),
    },
  };
}

/** Deep merge of a partial patch onto current settings, then validation. */
export function patchSettings(current: AppSettings, patch: unknown): AppSettings {
  const merge = (target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(source || {})) {
      out[key] = value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object"
        ? merge(target[key] as Record<string, unknown>, value as Record<string, unknown>)
        : value;
    }
    return out;
  };
  return normalizeSettings(merge(current as unknown as Record<string, unknown>, (patch || {}) as Record<string, unknown>), current);
}

export class AppSettingsStore {
  private settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
  private readonly file: string;
  private readonly listeners = new Set<(settings: AppSettings, previous: AppSettings) => void>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "app-settings.v3.json");
  }

  async initialize(legacy: Record<string, unknown> = {}): Promise<AppSettings> {
    const stored = await readJsonFile<unknown>(this.file, null);
    if (stored) {
      this.settings = normalizeSettings(stored);
    } else {
      // First run of this version: users of the previous release have already
      // been through first-use, so only the new areas get defaults.
      this.settings = normalizeSettings({ onboardingComplete: false });
      if (legacy.autoStart !== undefined || legacy.wakeWordEnabled !== undefined) this.settings.onboardingComplete = false;
      await writeJsonFile(this.file, this.settings);
    }
    return this.get();
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  async update(patch: unknown): Promise<AppSettings> {
    const previous = this.settings;
    this.settings = patchSettings(this.settings, patch);
    await writeJsonFile(this.file, this.settings);
    for (const listener of this.listeners) listener(this.get(), previous);
    return this.get();
  }

  onChange(listener: (settings: AppSettings, previous: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
