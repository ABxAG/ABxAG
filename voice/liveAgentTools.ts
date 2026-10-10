/**
 * Gemini Live ⇄ ABxAG agent bridge.
 *
 * The Live model is the conversational/personality layer. Anything that
 * needs more than one simple action — or needs to look at the screen — is
 * handed to the autonomous task engine with startTask, which plans, acts,
 * verifies and reports back on its own. The Live model never drives those
 * steps itself and never bypasses permissions: confirmations it relays are
 * resolved by the same broker as the UI buttons.
 */
import { Type } from "@google/genai";
import { publicTaskView, TERMINAL_STATES } from "../agent/taskSession";
import type { ABxAGRuntime } from "../runtime/ABxAGRuntime";

export const LIVE_AGENT_INSTRUCTIONS = [
  "AUTONOMOUS TASKS:",
  "- For any request that needs several steps on the PC or needs to look at the screen (finding or sending files/photos, using WhatsApp or any app UI, downloading from a website, organizing files, filling forms, working in an unfamiliar app), call startTask with the user's request in their own words plus any clarification. Then say only a very short acknowledgement (e.g. 'Ek sec, dekh rahi hoon.') and stop. The task engine reports progress, asks questions and confirms risky steps itself — don't narrate steps and don't drive those tasks with the low-level desktop tools.",
  "- Simple single actions (volume, brightness, open one app or website, a web search) can still use the direct tools.",
  "- 'Message <person> <text>' / '<person> ko <text> bhejo' on WhatsApp (or any chat app) with plain text → call sendChatMessage(to, text, app) ONCE. It opens the person's own chat, sends and verifies by itself in a few seconds. If the user did not say WHAT to send, ask first. If they want a file or photo sent, use startTask and name the file they mean; if they did not say which file, ask.",
  "- 'Open <folder> and select all .zip (or any type / named) files' → ONE call: selectFiles(folder, extension or pattern or names). Never try to select files with clickText, column headers, typing or shift/ctrl key presses.",
  "- If the user answers a question the task asked, call answerTask with their answer.",
  "- If the user approves or rejects a pending ABxAG confirmation (e.g. 'haan bhej do', 'nahi rehne do'), call respondToConfirmation. Only call it with approve=true after an explicit yes from the user in this conversation.",
  "- 'Stop', 'ruk', 'bas', 'cancel' → controlTask(stop). 'Main karta hoon' / 'let me do it' → controlTask(take_over). 'Ab tum karo' → controlTask(return_control).",
  "- Alarms, timers, reminders: setReminder. Quiet requests: setDoNotDisturb or setProactivity. Contact aliases ('Papa is \"Papa ❤️\" on WhatsApp'): saveContact.",
  "- Your desktop companion body (the character on the user's desktop): 'idhar aao' / 'come here' → companionAction(come_here); 'icons wapas rakho' / 'put the icons back' / 'fix my icons' → companionAction(restore_icons); also sit, stand, stretch, wave, hide, play_with_icons. Say a short, playful line about it.",
  "- Your MAIN 3D stage body (the big character in this window) moves on request: 'jump karo' / 'laaf dao' / 'dance karo' / 'bow down' / 'spin' / 'nod' / 'shrug' / 'stretch' / 'backflip' / 'dickbaazi karo' → characterPerform(action). 'Character change karo' / 'dusri wali aao' → switchCharacter (no target = next one). 'Dress red karo' / 'baal kaale karo' → setOutfitColor(color, part); add target companion to recolor only the desktop doll (e.g. 'companion ki dress blue karo'), target stage for only the main one — each keeps its own color. The DESKTOP-COMPANION doll obeys the same moves: 'doll dance karo' / 'putul ta nacho' / 'companion backflip karo' → companionPerform(action). Always perform first via the tool, then say one short playful line — never describe the move instead of doing it.",
  "STYLE: Short tasks get short replies — 'Ho gaya.', 'Mil gaya.', 'Yeh wala?', 'Wait, WhatsApp login nahi hai.' Explain at length only when asked. Never claim an action happened unless the task engine reported it.",
].join("\n");

export const LIVE_AGENT_TOOL_DECLARATIONS = [
  {
    name: "startTask",
    description: "Start an autonomous multi-step PC task (perceive → plan → act → verify). Pass the user's request verbatim plus clarifications. Returns immediately; progress is reported separately.",
    parameters: { type: Type.OBJECT, properties: { goal: { type: Type.STRING, description: "The user's request in their own words, with any clarification." } }, required: ["goal"] },
  },
  {
    name: "getTaskStatus",
    description: "Current status of the active/most recent autonomous task.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "controlTask",
    description: "Control the active autonomous task.",
    parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, enum: ["stop", "pause", "resume", "take_over", "return_control"] } }, required: ["action"] },
  },
  {
    name: "answerTask",
    description: "Give the user's answer to the question the running task asked.",
    parameters: { type: Type.OBJECT, properties: { answer: { type: Type.STRING } }, required: ["answer"] },
  },
  {
    name: "respondToConfirmation",
    description: "Approve or reject the most recent pending ABxAG confirmation (send message, delete, run installer…) after the user explicitly said yes or no.",
    parameters: { type: Type.OBJECT, properties: { approve: { type: Type.BOOLEAN } }, required: ["approve"] },
  },
  {
    name: "setReminder",
    description: "Create an alarm (clock time), timer (duration) or reminder.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        kind: { type: Type.STRING, enum: ["alarm", "timer", "reminder"] },
        label: { type: Type.STRING },
        time: { type: Type.STRING, description: "Clock time like 07:30 or 6:15 pm (alarms/reminders)." },
        in_minutes: { type: Type.NUMBER, description: "Minutes from now (timers/reminders)." },
        repeat: { type: Type.STRING, enum: ["none", "daily", "weekdays"] },
      },
      required: ["kind"],
    },
  },
  {
    name: "listReminders",
    description: "List upcoming alarms, timers and reminders.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "setDoNotDisturb",
    description: "Turn Do Not Disturb on or off (no unprompted speech while on).",
    parameters: { type: Type.OBJECT, properties: { active: { type: Type.BOOLEAN } }, required: ["active"] },
  },
  {
    name: "setProactivity",
    description: "How often ABxAG speaks on her own: quiet, balanced or lively.",
    parameters: { type: Type.OBJECT, properties: { level: { type: Type.STRING, enum: ["quiet", "balanced", "lively"] } }, required: ["level"] },
  },
  {
    name: "saveContact",
    description: "Save a contact alias, e.g. Papa / Dad and the exact name shown in WhatsApp.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        aliases: { type: Type.ARRAY, items: { type: Type.STRING } },
        app: { type: Type.STRING, description: "App, e.g. whatsapp" },
        app_name: { type: Type.STRING, description: "Exact name shown in that app" },
      },
      required: ["name"],
    },
  },
  {
    name: "sendChatMessage",
    description: "Send a plain text message to a person in WhatsApp (default) or another chat app, in one step: opens that person's personal chat (searches the app, never a group), types the text, sends, verifies. Permission rules for sending messages apply.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        to: { type: Type.STRING, description: "The person, as the user said it (e.g. Papa, Priya Sharma)." },
        text: { type: Type.STRING, description: "The exact message to send, in the user's words." },
        app: { type: Type.STRING, description: "App name, default WhatsApp." },
      },
      required: ["to", "text"],
    },
  },
  {
    name: "companionAction",
    description: "Make ABxAG's desktop companion (her character on the user's desktop) do something: come out to the user, put back desktop icons she moved, sit, stand up, stretch, wave, hide behind the screen edge, or play with a desktop icon.",
    parameters: {
      type: Type.OBJECT,
      properties: { action: { type: Type.STRING, enum: ["come_here", "restore_icons", "sit", "stand", "stretch", "wave", "hide", "play_with_icons"] } },
      required: ["action"],
    },
  },
  {
    name: "characterPerform",
    description: "Make the MAIN 3D character in this window perform a body move right now: jump, wave, bow, spin, nod, shake_head, shrug, dance, stretch, backflip. Call it first, then say one short playful line.",
    parameters: {
      type: Type.OBJECT,
      properties: { action: { type: Type.STRING, description: "One of: jump, wave, bow, spin, nod, shake_head, shrug, dance, stretch, backflip." } },
      required: ["action"],
    },
  },
  {
    name: "companionPerform",
    description: "Make the DESKTOP-COMPANION doll (her small character on the user's desktop) perform a body move right now: jump, wave, bow, spin, nod, shake_head, shrug, dance, stretch, backflip. Full control, same moves as the main stage. Call it first, then say one short playful line.",
    parameters: {
      type: Type.OBJECT,
      properties: { action: { type: Type.STRING, description: "One of: jump, wave, bow, spin, nod, shake_head, shrug, dance, stretch, backflip." } },
      required: ["action"],
    },
  },
  {
    name: "switchCharacter",
    description: "Change which character ABxAG appears as (the main 3D stage). Give a name to pick it, or leave empty to cycle to the next one. Use mode random for a surprise.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        target: { type: Type.STRING, description: "Character display name or id (optional)." },
        which: { type: Type.STRING, enum: ["next", "random"], description: "Cycle order when no target is given (default next)." },
      },
      required: [],
    },
  },
  {
    name: "setOutfitColor",
    description: "Recolor her clothes or hair live (e.g. dress red, black hair). Pass a hex color (#e11d48) or a plain name (red, blue, pink, black…). reset=true restores the authored colors. target picks the main stage, the desktop-companion doll, or both (default both) — so each can keep its own color.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        color: { type: Type.STRING, description: "Hex (#e11d48) or color name." },
        part: { type: Type.STRING, enum: ["outfit", "hair", "all"], description: "What to recolor (default outfit)." },
        target: { type: Type.STRING, enum: ["stage", "companion", "both"], description: "Which doll to recolor (default both)." },
        reset: { type: Type.BOOLEAN, description: "True to restore original colors." },
      },
      required: [],
    },
  },
];

export const LIVE_AGENT_TOOL_NAMES = new Set(LIVE_AGENT_TOOL_DECLARATIONS.map((tool) => tool.name));

/** Stage body moves the main 3D character can perform (mirrors the renderer's CharacterActions). */
export const STAGE_ACTIONS = ["jump", "wave", "bow", "spin", "nod", "shake_head", "shrug", "dance", "stretch", "backflip"] as const;
export type StageAction = (typeof STAGE_ACTIONS)[number];

export function normalizeStageAction(raw: string): StageAction | null {
  const key = String(raw || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  const aliases: Record<string, StageAction> = {
    jump: "jump", hop: "jump", leap: "jump", laaf: "jump",
    wave: "wave", hi: "wave", hello: "wave",
    bow: "bow", greet: "bow",
    spin: "spin", twirl: "spin", turn: "spin",
    nod: "nod", yes: "nod",
    shake_head: "shake_head", no: "shake_head",
    shrug: "shrug", dance: "dance", stretch: "stretch",
    backflip: "backflip", flip: "backflip", somersault: "backflip",
  };
  if ((STAGE_ACTIONS as readonly string[]).includes(key)) return key as StageAction;
  return aliases[key] ?? null;
}

const STAGE_COLOR_NAMES: Record<string, string> = {
  red: "#e11d48", pink: "#ec4899", purple: "#8b5cf6", blue: "#2563eb",
  green: "#16a34a", yellow: "#eab308", orange: "#ea580c", black: "#1f2937",
  white: "#f8fafc", gray: "#6b7280", grey: "#6b7280", brown: "#92400e",
};

/** "#e11d48" or a plain color name → "#rrggbb", or null. */
export function parseStageColor(raw: string): string | null {
  const text = String(raw || "").trim().toLowerCase();
  const hex = /^#?([0-9a-f]{6})$/i.exec(text);
  if (hex) return `#${hex[1].toLowerCase()}`;
  return STAGE_COLOR_NAMES[text] ?? null;
}

export async function handleLiveAgentTool(runtime: ABxAGRuntime, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const active = () => runtime.tasks.active().find((session) => !TERMINAL_STATES.has(session.state)) || null;
  switch (name) {
    case "startTask": {
      const goal = String(args.goal || "").trim();
      if (!goal) return { error: "goal is required" };
      const session = runtime.manager.start(goal, "voice");
      return { started: true, taskId: session.id, note: "The task engine now works on this and will report progress and ask for confirmation itself. Say a brief acknowledgement only." };
    }
    case "getTaskStatus": {
      const session = active() || runtime.tasks.list(1)[0];
      if (!session) return { status: "no tasks yet" };
      const view = publicTaskView(session);
      return { goal: view.goal, state: view.state, status: view.currentStatus, result: view.result, recentSteps: view.actions.slice(-5).map((a) => `${a.summary} (${a.status})`) };
    }
    case "controlTask": {
      const session = active();
      if (!session) return { ok: false, note: "No task is running." };
      const action = String(args.action);
      const ok = action === "stop" ? runtime.manager.stop(session.id)
        : action === "pause" ? runtime.manager.pause(session.id)
          : action === "resume" ? runtime.manager.resume(session.id)
            : action === "take_over" ? runtime.manager.takeOver(session.id)
              : runtime.manager.returnControl(session.id);
      return { ok, action };
    }
    case "answerTask": {
      const session = active();
      if (!session) return { ok: false, note: "No task is waiting for an answer." };
      return { ok: runtime.manager.answer(session.id, String(args.answer || "")) };
    }
    case "respondToConfirmation": {
      const request = runtime.confirmations.resolveLatest({ approved: args.approve === true, via: "voice" });
      return request ? { ok: true, approved: args.approve === true, what: request.description } : { ok: false, note: "Nothing is waiting for confirmation." };
    }
    case "setReminder": {
      const kind = String(args.kind) as "alarm" | "timer" | "reminder";
      const utility = await runtime.utilities.add({
        kind,
        label: typeof args.label === "string" ? args.label : undefined,
        time: typeof args.time === "string" ? args.time : undefined,
        inSeconds: Number.isFinite(Number(args.in_minutes)) ? Number(args.in_minutes) * 60 : undefined,
        repeat: ["daily", "weekdays"].includes(String(args.repeat)) ? String(args.repeat) as "daily" | "weekdays" : "none",
      });
      return { ok: true, id: utility.id, due: new Date(utility.dueAt).toLocaleString(), label: utility.label };
    }
    case "listReminders":
      return { items: runtime.utilities.list().map((item) => ({ kind: item.kind, label: item.label, due: new Date(item.dueAt).toLocaleString() })) };
    case "setDoNotDisturb":
      await runtime.settings.update({ behavior: { dndManual: args.active === true } });
      return { ok: true, active: args.active === true };
    case "setProactivity":
      await runtime.settings.update({ behavior: { proactivity: args.level } });
      return { ok: true, level: runtime.settings.get().behavior.proactivity };
    case "saveContact": {
      const app = typeof args.app === "string" ? args.app.toLowerCase() : "";
      const contact = await runtime.contacts.upsert({
        displayName: String(args.name || ""),
        aliases: Array.isArray(args.aliases) ? args.aliases.map(String) : [],
        appNames: app && typeof args.app_name === "string" ? { [app]: args.app_name } : {},
      });
      return { ok: true, contact: contact.displayName, aliases: contact.aliases.slice(0, 8) };
    }
    case "sendChatMessage": {
      const to = String(args.to || "").trim();
      const text = String(args.text || "").trim();
      if (!to || !text) return { error: "Both 'to' and 'text' are required. Ask the user who to message and what to say." };
      const app = String(args.app || "WhatsApp");
      // A saved alias (Papa → the name in WhatsApp) wins over the raw word.
      const resolved = runtime.contacts.resolve(to);
      const name = resolved.status === "resolved" ? runtime.contacts.nameForApp(resolved.contact, app) || resolved.contact.displayName : to;
      const session = runtime.manager.runDirect(`${app}: message ${to} — "${text}"`, { tool: "chat.send", args: { name, text, app } }, "voice",
        resolved.status === "resolved" ? { name: resolved.contact.displayName, contactId: resolved.contact.id } : { name: to, contactId: null });
      return { started: true, taskId: session.id, note: "Sending now; the result is reported when it is done. Say a very short acknowledgement only." };
    }
    case "companionAction": {
      const action = String(args.action || "");
      const allowed = ["come_here", "restore_icons", "sit", "stand", "stretch", "wave", "hide", "play_with_icons"];
      if (!allowed.includes(action)) return { error: `Unknown companion action ${action}` };
      const settings = runtime.settings.get();
      if (!settings.companion.enabled) return { ok: false, note: "The desktop companion is turned off (Settings → Character & companion)." };
      if (action === "play_with_icons" && !settings.companion.iconPlay) return { ok: false, note: "Playing with desktop icons is turned off in Settings → Character & companion." };
      return { ok: runtime.companionCommand(action), action };
    }
    case "characterPerform": {
      const name = normalizeStageAction(String(args.action || ""));
      if (!name) {
        return { ok: false, note: `I can do: ${STAGE_ACTIONS.join(", ")}. Ask for one of those.` };
      }
      runtime.characterCommand({ kind: "action", action: name });
      return { ok: true, action: name, note: "She performs it on the main stage right now. Say one short playful line." };
    }
    case "companionPerform": {
      const name = normalizeStageAction(String(args.action || ""));
      if (!name) {
        return { ok: false, note: `The doll can do: ${STAGE_ACTIONS.join(", ")}. Ask for one of those.` };
      }
      const settings = runtime.settings.get();
      if (!settings.companion.enabled) return { ok: false, note: "The desktop companion is turned off (Settings → Character & companion)." };
      runtime.companionCommand(`perform:${name}`);
      return { ok: true, action: name, note: "The desktop-companion doll performs it right now. Say one short playful line." };
    }
    case "switchCharacter": {
      const profiles = await runtime.characters.list();
      if (profiles.length === 0) {
        return { ok: false, note: "No imported characters yet — ask them to import one first (Settings → Character → Character Studio)." };
      }
      const current = runtime.settings.get().character.activeCharacterId;
      const target = String(args.target || "").trim().toLowerCase();
      let pick = profiles.find((p) => p.id.toLowerCase() === target || p.displayName.toLowerCase() === target) ?? null;
      if (!pick) {
        if (String(args.which || "next") === "random" || target === "") {
          const others = profiles.filter((p) => p.id !== current);
          const pool = others.length > 0 ? others : profiles;
          pick = pool[Math.floor(Math.random() * pool.length)];
        } else {
          const at = Math.max(0, profiles.findIndex((p) => p.id === current));
          pick = profiles[(at + 1) % profiles.length];
        }
      }
      if (!/^[a-z0-9_-]{1,64}$/.test(pick.id)) return { ok: false, note: "That character id looks invalid." };
      await runtime.settings.update({ character: { activeCharacterId: pick.id } });
      runtime.characterCommand({ kind: "switch", id: pick.id });
      return { ok: true, id: pick.id, name: pick.displayName, note: "She changes on the main stage right now. Say one short playful line." };
    }
    case "setOutfitColor": {
      const targetRaw = String(args.target || "both").toLowerCase();
      const target = targetRaw === "stage" || targetRaw === "companion" ? targetRaw : "both";
      if (args.reset === true) {
        runtime.characterCommand({ kind: "outfit", cloth: null, hair: null, target });
        return { ok: true, reset: true, target, note: "Her original colors are back. Say one short line." };
      }
      const hex = parseStageColor(String(args.color || ""));
      if (!hex) {
        return { ok: false, note: "Give a hex color (#e11d48) or a name like red, blue, pink, black, white, green, purple, yellow, orange." };
      }
      const part = String(args.part || "outfit").toLowerCase();
      if (part === "hair") runtime.characterCommand({ kind: "outfit", hair: hex, target });
      else if (part === "all") runtime.characterCommand({ kind: "outfit", cloth: hex, hair: hex, target });
      else runtime.characterCommand({ kind: "outfit", cloth: hex, target });
      return { ok: true, color: hex, part, target, note: "Her look changes right now. Say one short playful line." };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}



