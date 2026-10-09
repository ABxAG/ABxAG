/**
 * Personality layer for task events.
 *
 * Turns factual task state ("File transfer complete") into a short line in
 * ABxAG's voice ("Ho gaya."). It only phrases; it never changes what is
 * reported. Lines are suggestions: with a live voice session the Live model
 * voices them naturally, otherwise they are shown as a bubble. Recent lines
 * are not repeated back-to-back.
 */

export type TaskEventKind =
  | "started"
  | "need_confirmation"
  | "question"
  | "done"
  | "failed"
  | "login_required"
  | "waiting_for_user_input"
  | "stopped"
  | "recovered";

const LINES: Record<TaskEventKind, string[]> = {
  started: ["Ek sec, dekh rahi hoon.", "Haan, kar rahi hoon.", "Okay, ek minute.", "Dekhti hoon."],
  need_confirmation: ["{detail} — kar doon?", "{detail}. Bhej doon?", "Bas confirm kar do: {detail}"],
  question: ["{detail}"],
  done: ["Ho gaya.", "Ho gaya — {detail}", "Done. {detail}", "Ye lo, ho gaya."],
  failed: ["Nahi ho paaya — {detail}", "Hmm, atak gayi: {detail}", "Ye nahi hua: {detail}"],
  login_required: ["Wait, {detail} mein login nahi hai.", "{detail} login maang raha hai — tum login kar do?"],
  waiting_for_user_input: ["Tum use kar rahe ho, main ruk jaati hoon.", "Theek hai, tum karo — main wait karti hoon."],
  stopped: ["Ruk gayi.", "Okay, band kar diya.", "Theek hai, chhod diya."],
  recovered: ["Ek aur tareeke se try karti hoon.", "Wait, dusra rasta dekhti hoon."],
};

export class PersonalityVoice {
  private readonly recent: string[] = [];

  constructor(private readonly random: () => number = Math.random) {}

  line(kind: TaskEventKind, detail = ""): string {
    const templates = LINES[kind].filter((template) => detail || !template.includes("{detail}"));
    const pool = templates.length ? templates : LINES[kind];
    const fresh = pool.filter((template) => !this.recent.includes(template));
    const choices = fresh.length ? fresh : pool;
    const template = choices[Math.floor(this.random() * choices.length) % choices.length];
    this.recent.push(template);
    if (this.recent.length > 6) this.recent.shift();
    return template.replace("{detail}", trimDetail(detail)).replace(/\s+—\s*$/, "").trim();
  }
}

function trimDetail(detail: string): string {
  const text = detail.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

/**
 * Instruction handed to the Live voice model so it voices a task event in
 * persona without inventing facts. The factual line is authoritative.
 */
export function voicePrompt(kind: TaskEventKind, suggested: string, facts: string): string {
  return [
    "PRIVATE TASK UPDATE — not something the user said.",
    `Event: ${kind}. Facts (authoritative, do not add or change facts): ${facts}`,
    `Say one short natural line in your own Hinglish voice, close to: "${suggested}"`,
    "No questions unless the event is a question or confirmation. Do not call tools in response to this update.",
  ].join("\n");
}

