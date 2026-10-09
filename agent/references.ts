/**
 * Reference resolution.
 *
 * Finds referring phrases in the user's request and resolves them against
 * evidence: what is selected or open on screen right now, working memory,
 * recent files (with temporal qualifiers like "kal"/"yesterday"), saved
 * contacts and remembered folder locations. Each result carries a confidence
 * and its evidence; near-ties are reported as ambiguous so the agent asks
 * instead of guessing.
 */
import type { ContactBook } from "../memory/contacts";
import type { Referent, WorkingMemory } from "../memory/workingMemory";
import type { AgentCall, DesktopState } from "./perception/engine";

export type ReferenceKind = "image" | "file" | "folder" | "person" | "app" | "window" | "video" | "document";

export interface ReferencePhrase {
  phrase: string;
  kind: ReferenceKind;
  demonstrative: "this" | "that" | null;
  temporal: "today" | "yesterday" | "recent" | "just_now" | null;
  ordinal: number | null;
  qualifier: string | null;
  name: string | null;
}

export interface Candidate {
  label: string;
  value: string;
  confidence: number;
  evidence: string;
}

export interface ResolvedReference {
  phrase: string;
  kind: ReferenceKind;
  status: "resolved" | "ambiguous" | "unresolved";
  best: Candidate | null;
  candidates: Candidate[];
}

const NOUN: Array<[RegExp, ReferenceKind]> = [
  [/\b(photo|photos|pic|pics|picture|image|images|tasveer|tasvir|foto|screenshot|thumbnail|wallpaper)\b/i, "image"],
  [/\b(video|videos|clip|recording)\b/i, "video"],
  [/\b(pdf|document|doc|docx|resume|report|notes)\b/i, "document"],
  [/\b(folder|directory)\b/i, "folder"],
  [/\b(file|files)\b/i, "file"],
  [/\b(browser|chrome|edge|tab)\b/i, "window"],
];
const THIS = /\b(yeh|ye|yahi|is|isko|ise|this|these|current|abhi wala|abhi wali)\b/i;
const THAT = /\b(woh|wo|vo|voh|us|usko|use|that|those|the same|wahi|wohi)\b/i;
const WALA = /\b(wala|wali|wale)\b/i;
const ORDINALS: Array<[RegExp, number]> = [
  [/\b(first|pehli|pehla|1st|ek number)\b/i, 1], [/\b(second|dusri|doosri|dusra|2nd)\b/i, 2],
  [/\b(third|teesri|tisri|3rd)\b/i, 3], [/\b(fourth|chauthi|4th)\b/i, 4],
  [/\b(last|latest|newest|aakhri|akhri|recent|nayi|naya)\b/i, -1],
];

/** Extract referring phrases. Deterministic; no model call. */
export function extractReferences(text: string): ReferencePhrase[] {
  const out: ReferencePhrase[] = [];
  const lower = text.toLowerCase();
  const temporal: ReferencePhrase["temporal"] = /\b(kal|yesterday)\b/.test(lower) ? "yesterday"
    : /\b(aaj|today)\b/.test(lower) ? "today"
      : /\b(abhi abhi|just now|abhi)\b/.test(lower) ? "just_now"
        : /\b(recent|recently|haal hi)\b/.test(lower) ? "recent" : null;
  const ordinal = ORDINALS.find(([pattern]) => pattern.test(lower))?.[1] ?? null;
  const demonstrative = THIS.test(lower) ? "this" : THAT.test(lower) || /\bjo\b/.test(lower) ? "that" : WALA.test(lower) ? "this" : null;

  for (const [pattern, kind] of NOUN) {
    const match = text.match(pattern);
    if (!match) continue;
    if (kind === "window" && !/\b(jo|that|woh|wo|abhi|was open|khula)\b/i.test(lower)) continue;
    // "mera Altrex folder", "the Altrex folder" -> a named folder.
    let name: string | null = null;
    if (kind === "folder") {
      const named = text.match(/(?:mera|meri|mere|my|the|apna|apni)\s+([\p{L}\p{N}_\- .]{2,40}?)\s+folder/iu) || text.match(/([\p{Lu}][\p{L}\p{N}_\-]{1,40})\s+folder/u);
      name = named ? named[1].trim() : null;
    }
    const qualifier = (text.match(/\b(thumbnail|screenshot|wallpaper|selfie|resume|invoice|receipt|ticket)\b/i) || [])[1] || null;
    out.push({
      phrase: match[0],
      kind,
      demonstrative,
      temporal,
      ordinal,
      qualifier: qualifier ? qualifier.toLowerCase() : null,
      name,
    });
    break;
  }
  if (!out.length && demonstrative === "this" && WALA.test(lower)) {
    out.push({ phrase: (text.match(/\b(yeh|ye)\s+(wala|wali|wale)\b/i) || ["yeh wala"])[0], kind: "file", demonstrative: "this", temporal, ordinal, qualifier: null, name: null });
  }
  // People: "Papa ko bhej", "send it to Rahul", "mummy ko WhatsApp".
  const name = extractRecipient(text);
  if (name) out.push({ phrase: name, kind: "person", demonstrative: null, temporal: null, ordinal: null, qualifier: null, name });
  return out;
}

const RECIPIENT_STOPWORDS = new Set([
  "ye", "yeh", "wo", "woh", "vo", "is", "us", "isko", "usko", "wali", "wala", "wale", "photo", "photos", "pic", "image",
  "file", "video", "this", "that", "the", "it", "mera", "meri", "mere", "my", "apna", "apni", "ek", "a", "an", "screenshot",
  "document", "pdf", "link", "message", "msg", "please", "pls", "jaldi", "abhi", "kal", "aaj", "and", "aur",
]);

function isCapitalized(word: string): boolean {
  return /^\p{Lu}/u.test(word);
}

/** The person a message/file should go to, from Hinglish or English phrasing. */
export function extractRecipient(text: string): string | null {
  const hindi = text.match(/^(.*?)\s+(?:ko|को)\s+(?:bhej|send|whatsapp|message|msg|mail|forward|share|dikha|call)/iu);
  let words: string[] = [];
  if (hindi) {
    words = hindi[1].split(/\s+/);
  } else {
    const english = text.match(/\b(?:send|forward|share|message|whatsapp|mail|text)\b.*?\bto\s+(.+?)(?:\s+(?:on|via|through|using|in)\b|[.,!?]|$)/iu);
    if (!english) return null;
    words = english[1].split(/\s+/).slice(0, 3);
  }
  const kept: string[] = [];
  for (const word of [...words].reverse()) {
    const clean = word.replace(/[^\p{L}\p{N}.'\-]/gu, "");
    if (!clean) continue;
    if (RECIPIENT_STOPWORDS.has(clean.toLowerCase()) || /\.(png|jpe?g|pdf|docx?|mp4|zip)$/i.test(clean)) {
      if (kept.length) break;
      continue;
    }
    // A second word is only joined for proper names ("Rahul Sharma"), never
    // for Hinglish function words ("…ki thi Papa").
    if (kept.length === 1 && !(isCapitalized(clean) && isCapitalized(kept[0]))) break;
    kept.unshift(clean);
    if (kept.length === 2) break;
  }
  const name = kept.join(" ").trim();
  return name && !/^(me|mujhe|isse|use|unhe|inhe)$/i.test(name) ? name : null;
}

export interface ResolverDeps {
  call: AgentCall;
  contacts: ContactBook;
  working: WorkingMemory;
  /** Remembered facts such as "The user's Altrex folder is D:\\Work\\Altrex". */
  recallLocations: (name: string) => Promise<string[]>;
}

const KIND_TO_FILE_KINDS: Partial<Record<ReferenceKind, string[]>> = {
  image: ["image"], video: ["video"], document: ["document"], file: ["image", "video", "document", "archive", "audio", "design"],
};

export async function resolveReferences(text: string, state: DesktopState | null, deps: ResolverDeps, signal?: AbortSignal): Promise<ResolvedReference[]> {
  const phrases = extractReferences(text);
  const results: ResolvedReference[] = [];
  // "…in C:\Users\me\Thumbs folder…": file references are scoped to that folder.
  const needsFolder = phrases.some((phrase) => !["person", "folder", "window"].includes(phrase.kind));
  const explicitFolder = needsFolder ? await explicitFolderIn(text, deps, signal) : null;
  for (const phrase of phrases) {
    if (phrase.kind === "person") results.push(resolvePerson(phrase, deps));
    else if (phrase.kind === "folder") results.push(await resolveFolder(phrase, deps, signal));
    else if (phrase.kind === "window") results.push(resolveWindow(phrase, state, deps.working));
    else results.push(await resolveFile(phrase, state, deps, signal, explicitFolder));
  }
  return results;
}

/** The longest existing folder path written in the request, if any. */
export async function explicitFolderIn(text: string, deps: Pick<ResolverDeps, "call">, signal?: AbortSignal): Promise<string | null> {
  const match = text.match(/[A-Za-z]:\\[^\n"'<>|?*]*/);
  if (!match) return null;
  const words = match[0].split(" ");
  for (let take = words.length; take >= 1; take -= 1) {
    const candidate = words.slice(0, take).join(" ").replace(/[\\.,;:]+$/, "");
    if (candidate.length < 3) continue;
    const response = await deps.call("statPath", { path: candidate }, signal);
    const info = response.ok ? response.result as Record<string, unknown> : null;
    if (info?.exists === true && info.is_dir === true) return candidate;
  }
  return null;
}

function finalize(phrase: ReferencePhrase, candidates: Candidate[]): ResolvedReference {
  const sorted = dedupe(candidates).sort((a, b) => b.confidence - a.confidence).slice(0, 6);
  const [best, second] = sorted;
  if (!best || best.confidence < 0.45) return { phrase: phrase.phrase, kind: phrase.kind, status: "unresolved", best: null, candidates: sorted };
  if (second && best.confidence - second.confidence < 0.12 && second.confidence >= 0.45) {
    return { phrase: phrase.phrase, kind: phrase.kind, status: "ambiguous", best: null, candidates: sorted };
  }
  return { phrase: phrase.phrase, kind: phrase.kind, status: "resolved", best, candidates: sorted };
}

function resolvePerson(phrase: ReferencePhrase, deps: ResolverDeps): ResolvedReference {
  const resolution = deps.contacts.resolve(phrase.name || phrase.phrase);
  if (resolution.status === "resolved") {
    return {
      phrase: phrase.phrase, kind: "person", status: "resolved",
      best: { label: resolution.contact.displayName, value: resolution.contact.id, confidence: 0.95, evidence: `Saved contact (alias "${resolution.matchedAlias}")` },
      candidates: [],
    };
  }
  if (resolution.status === "ambiguous") {
    return {
      phrase: phrase.phrase, kind: "person", status: "ambiguous", best: null,
      candidates: resolution.candidates.map((contact) => ({ label: contact.displayName, value: contact.id, confidence: 0.6, evidence: "Saved contact with the same alias" })),
    };
  }
  const recent = deps.working.recent(["person"]).find((item) => item.label.toLowerCase() === (phrase.name || "").toLowerCase());
  return {
    phrase: phrase.phrase, kind: "person", status: "unresolved", best: null,
    candidates: recent ? [{ label: recent.label, value: recent.value, confidence: 0.5, evidence: "Mentioned recently" }] : [],
  };
}

function resolveWindow(phrase: ReferencePhrase, state: DesktopState | null, working: WorkingMemory): ResolvedReference {
  const candidates: Candidate[] = [];
  for (const item of working.recent(["window", "url"], 30 * 60_000)) {
    candidates.push({ label: item.label, value: item.value, confidence: Math.min(0.9, 0.5 + item.score * 0.4), evidence: `Recently used (${item.source})` });
  }
  for (const window of state?.windows || []) {
    if (/chrome|edge|firefox|brave|opera/i.test(window.title)) {
      candidates.push({ label: window.title, value: window.title, confidence: 0.55, evidence: "Open browser window" });
    }
  }
  return finalize(phrase, candidates);
}

async function resolveFolder(phrase: ReferencePhrase, deps: ResolverDeps, signal?: AbortSignal): Promise<ResolvedReference> {
  const candidates: Candidate[] = [];
  const name = phrase.name;
  if (name) {
    for (const remembered of await deps.recallLocations(name)) {
      const pathMatch = remembered.match(/[A-Za-z]:\\[^"'\n]+/);
      if (pathMatch) candidates.push({ label: pathMatch[0], value: pathMatch[0].trim(), confidence: 0.92, evidence: "Remembered location" });
    }
    if (!candidates.length) {
      const response = await deps.call("searchFiles", { name: `*${name}*`, folder: "home", limit: 40 }, signal);
      const matches = response.ok ? ((response.result as Record<string, unknown>).matches || (response.result as Record<string, unknown>).files || []) as unknown[] : [];
      // searchFiles lists files; derive parent folders that carry the name.
      const folders = new Map<string, number>();
      for (const item of matches) {
        const full = typeof item === "string" ? item : String((item as Record<string, unknown>).path || "");
        const parts = full.split(/[\\/]/);
        const index = parts.findIndex((part) => part.toLowerCase() === name.toLowerCase());
        if (index > 0) {
          const folder = parts.slice(0, index + 1).join("\\");
          folders.set(folder, (folders.get(folder) || 0) + 1);
        }
      }
      for (const [folder] of folders) candidates.push({ label: folder, value: folder, confidence: folders.size === 1 ? 0.8 : 0.6, evidence: "Folder with that name found on disk" });
    }
  }
  for (const item of deps.working.recent(["folder"], 30 * 60_000)) {
    if (!name || item.label.toLowerCase().includes(name.toLowerCase())) {
      candidates.push({ label: item.label, value: item.value, confidence: 0.55 + item.score * 0.3, evidence: "Recently used folder" });
    }
  }
  return finalize(phrase, candidates);
}

async function resolveFile(phrase: ReferencePhrase, state: DesktopState | null, deps: ResolverDeps, signal?: AbortSignal, folder: string | null = null): Promise<ResolvedReference> {
  const candidates: Candidate[] = [];
  const kinds = KIND_TO_FILE_KINDS[phrase.kind] || ["image"];
  const folderPrefix = folder ? `${folder.toLowerCase().replace(/\\+$/, "")}\\` : "";
  const inFolder = (value: string) => !folder || value.toLowerCase().startsWith(folderPrefix);
  const isKind = (name: string) => kindOf(name, kinds);

  // 1. On screen right now: selection in File Explorer, file open in a viewer.
  if (state && phrase.temporal !== "yesterday") {
    const explorerFolder = state.elements.find((element) => /^address:\s*/i.test(element.name))?.name.replace(/^address:\s*/i, "").trim();
    const selected = state.elements.filter((element) => element.selected && element.role === "listitem" && isKind(element.name));
    for (const item of selected) {
      const value = explorerFolder && /^[a-z]:\\/i.test(explorerFolder) ? `${explorerFolder.replace(/\\$/, "")}\\${item.name}` : item.name;
      candidates.push({ label: item.name, value, confidence: phrase.demonstrative === "this" ? 0.93 : 0.85, evidence: "Selected in File Explorer" });
    }
    const title = state.activeWindow?.title || "";
    const viewer = title.match(/^(.+?\.(png|jpe?g|gif|webp|bmp|heic|mp4|mkv|mov|pdf|docx?))\b/i);
    if (viewer && isKind(viewer[1])) {
      candidates.push({ label: viewer[1], value: viewer[1], confidence: phrase.demonstrative === "this" ? 0.9 : 0.82, evidence: `Open in ${state.activeWindow?.process || "a viewer"}` });
    }
  }

  // 2. Working memory: files mentioned, opened, sent or downloaded recently.
  for (const item of deps.working.recent(["image", "file", "download"], 6 * 60 * 60_000)) {
    if (!isKind(item.label) || !inFolder(item.value)) continue;
    candidates.push({ label: item.label, value: item.value, confidence: Math.min(0.88, 0.45 + item.score * 0.45), evidence: `Recently ${verb(item)}` });
  }

  // 3. Recent files on disk, honouring temporal/ordinal qualifiers.
  const sinceHours = folder ? 24 * 3650 : phrase.temporal === "yesterday" ? 72 : phrase.temporal === "today" ? 24 : phrase.temporal === "just_now" ? 2 : 24 * 14;
  const response = await deps.call("recentFiles", {
    kinds,
    folders: folder ? [folder] : phrase.temporal === "yesterday" && /download/i.test(phrase.phrase) ? ["downloads"] : undefined,
    allow_anywhere: Boolean(folder),
    max_depth: folder ? 1 : undefined,
    name_contains: phrase.qualifier && phrase.qualifier !== "photo" ? phrase.qualifier : undefined,
    since_hours: sinceHours,
    limit: 12,
  }, signal);
  if (response.ok) {
    let files = ((response.result as Record<string, unknown>).files as Array<Record<string, unknown>>) || [];
    if (phrase.temporal === "yesterday") {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const day = yesterday.toISOString().slice(0, 10);
      const filtered = files.filter((file) => String(file.modified || "").startsWith(day));
      if (filtered.length) files = filtered;
    }
    if (phrase.ordinal && phrase.ordinal > 0 && files[phrase.ordinal - 1]) {
      const chosen = files[phrase.ordinal - 1];
      candidates.push({ label: String(chosen.name), value: String(chosen.path), confidence: 0.7, evidence: `Number ${phrase.ordinal} of the newest ${kinds.join("/")} files` });
    } else {
      files.slice(0, 5).forEach((file, index) => {
        const base = phrase.ordinal === -1 || phrase.qualifier ? 0.72 : 0.55;
        candidates.push({
          label: String(file.name),
          value: String(file.path),
          confidence: Math.max(0.2, base - index * 0.12),
          evidence: `${index === 0 ? "Newest" : `#${index + 1} newest`} ${kinds[0]} (modified ${String(file.modified).replace("T", " ")})`,
        });
      });
    }
  }
  return finalize(phrase, candidates);
}

function kindOf(name: string, kinds: string[]): boolean {
  const extension = (name.match(/\.([a-z0-9]{2,5})$/i)?.[1] || "").toLowerCase();
  if (!extension) return kinds.includes("file") || kinds.length > 1;
  const map: Record<string, string> = {
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", heic: "image",
    mp4: "video", mkv: "video", mov: "video", avi: "video", webm: "video",
    pdf: "document", doc: "document", docx: "document", txt: "document", pptx: "document", xlsx: "document",
    zip: "archive", rar: "archive", "7z": "archive", mp3: "audio", wav: "audio", psd: "design", blend: "design",
  };
  return kinds.includes(map[extension] || "other");
}

function verb(item: Referent): string {
  return item.source === "download" ? "downloaded" : item.source === "task" ? "used in a task" : item.source === "screen" ? "seen on screen" : "mentioned";
}

function dedupe(candidates: Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = candidate.value.toLowerCase();
    const existing = best.get(key);
    if (!existing) best.set(key, candidate);
    else if (candidate.confidence > existing.confidence) best.set(key, { ...candidate, confidence: Math.min(0.97, candidate.confidence + 0.05), evidence: `${candidate.evidence}; ${existing.evidence}` });
    else existing.confidence = Math.min(0.97, existing.confidence + 0.05);
  }
  return [...best.values()];
}

export function formatReferences(references: ResolvedReference[]): string {
  if (!references.length) return "none detected";
  return references.map((ref) => {
    if (ref.status === "resolved" && ref.best) {
      return `"${ref.phrase}" (${ref.kind}) → ${ref.best.label} [${ref.best.value}] confidence ${ref.best.confidence.toFixed(2)} — ${ref.best.evidence}`;
    }
    const options = ref.candidates.slice(0, 4).map((c) => `${c.label} [${c.value}] ${c.confidence.toFixed(2)} (${c.evidence})`).join("; ");
    return `"${ref.phrase}" (${ref.kind}) → ${ref.status.toUpperCase()}${options ? `; candidates: ${options}` : ""}`;
  }).join("\n");
}
