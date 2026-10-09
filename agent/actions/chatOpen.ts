/**
 * Open a person's own chat in a messaging app (WhatsApp first), reliably.
 *
 * Planners used to click whatever element carried the name, which in a
 * group conversation is the SENDER label of a message — so "message Priya"
 * opened the family group. And when the person was not in ABxAG's own
 * contact list, the task gave up without ever searching the app.
 *
 * This action does it the way a person would:
 *   1. bring the app up (launch it if needed);
 *   2. type the name into the app's own search box;
 *   3. among the results, pick a chat row whose title IS that person
 *      (tolerant of small spelling differences: "Sharmaa" ↔ "Sharma"),
 *      never a group and never a message hit;
 *   4. open it and verify the conversation header shows that person and is
 *      not a group (a group header lists several members).
 */
import type { AgentCall, UiElement } from "../perception/engine";

interface WindowInfo { hwnd: number; title: string; rect?: { left: number; top: number; right: number; bottom: number } }

export interface ChatOpenResult {
  ok: boolean;
  chat?: string;
  error?: string;
  candidates?: string[];
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
});

/** Lower-case letters/digits only, words kept. Emoji and punctuation dropped. */
export function normalizeName(value: string): string[] {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/**
 * How well a chat row's title starts with the wanted name: 1 = exact, lower
 * for small typos, 0 = not this person. Only the leading words of the row
 * count (WhatsApp appends the time and last message to the row's name).
 */
export function nameMatch(wanted: string, rowName: string): number {
  const target = normalizeName(wanted);
  const row = normalizeName(rowName);
  if (!target.length || row.length < target.length) return 0;
  let score = 1;
  for (let i = 0; i < target.length; i++) {
    const a = target[i], b = row[i];
    if (a === b) continue;
    if (b.startsWith(a) && a.length >= 3) { score -= 0.05; continue; }
    const allowed = a.length <= 3 ? 0 : a.length <= 6 ? 1 : 2;
    const d = editDistance(a, b);
    if (d > allowed) return 0;
    score -= 0.15 * d;
  }
  return score;
}

/**
 * The chat title at the start of a WhatsApp row ("Priya Sharma Yesterday
 * in Myra bol rahi hun." → "Priya Sharma"): everything before the first
 * time or date word.
 */
export function rowTitle(name: string): string {
  const words = String(name).trim().split(/\s+/);
  const stop = words.findIndex((w, i) => i > 0 && /^(yesterday|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[:/.]\d{1,2}([:/.]\d{2,4})?|\d{1,2}:\d{2}(am|pm)?)$/i.test(w.replace(/[,]/g, "")));
  return (stop > 0 ? words.slice(0, stop) : words.slice(0, 6)).join(" ");
}

/** Kinship / respect words people add when speaking, not part of the saved name. */
const HONORIFICS = /^(dii?|didi|didii|bhai|bhaiya|bhaiyya|bhaia|ji|jii|sir|madam|mam|maam|ma'am|aunty|auntie|uncle|bro|sis|bhabhi|jiju|mausi|chachu|chacha|mama|mami)$/i;

/** "Priya Dii" → "Priya"; "Rahul Bhaiya" → "Rahul". Single words are kept. */
export function withoutHonorifics(name: string): string {
  const words = String(name).trim().split(/\s+/);
  if (words.length < 2) return words.join(" ");
  const kept = words.filter((w, i) => i === 0 || !HONORIFICS.test(w));
  return kept.join(" ");
}

/** A group's header or row lists several members ("Komal, Murli, Nana, …"). */
function looksLikeGroup(text: string): boolean {
  return (String(text).match(/,/g) || []).length >= 2 || /\bgroup\b/i.test(text);
}

export async function openChat(call: AgentCall, appName: string, person: string, signal?: AbortSignal): Promise<ChatOpenResult> {
  const app = appName || "WhatsApp";
  const appKey = app.toLowerCase();
  const findWindow = async (): Promise<WindowInfo | null> => {
    const listed = await call("listVisibleWindows", { limit: 60 }, signal);
    const windows = ((listed.result as { windows?: WindowInfo[] })?.windows) || [];
    return windows.find((w) => String(w.title).toLowerCase().includes(appKey)) || null;
  };

  let window = await findWindow();
  if (!window) {
    const opened = await call("openApplication", { name: app }, signal);
    if (!opened.ok) return { ok: false, error: `Could not open ${app}: ${opened.error}` };
    for (let i = 0; i < 20 && !window; i++) {
      await sleep(500, signal);
      window = await findWindow();
    }
    if (!window) return { ok: false, error: `${app} did not open a window.` };
    await sleep(1200, signal); // let the chat list load
  }
  const focus = await call("windowControl", { hwnd: window.hwnd, action: "focus" }, signal);
  if (!focus.ok) return { ok: false, error: `Could not bring ${app} to the front: ${focus.error}` };
  await sleep(250, signal);

  const inspect = async (query?: string, roles?: string[]) => {
    const args = { hwnd: window!.hwnd, max_elements: 220, ...(query ? { query } : {}), ...(roles ? { roles } : {}) };
    let response = await call("inspectUi", args, signal);
    // UI Automation sometimes throws a transient COM error: read again once.
    if (!response.ok) {
      await sleep(300, signal);
      response = await call("inspectUi", args, signal);
    }
    if (!response.ok) return null;
    const result = response.result as { snapshot_id: string; elements: UiElement[]; window?: { rect?: WindowInfo["rect"] } };
    return result;
  };

  // ---- 1. the app's search box (it may still be loading) ---------------------------
  let first: Awaited<ReturnType<typeof inspect>> = null;
  let search: UiElement | undefined;
  let rect = window.rect || { left: 0, top: 0, right: 1920, bottom: 1080 };
  let width = rect.right - rect.left;
  for (let attempt = 0; attempt < 6 && !search; attempt++) {
    if (attempt > 0) await sleep(1200, signal);
    first = await inspect(undefined, ["edit"]);
    if (!first) continue;
    rect = first.window?.rect || rect;
    width = rect.right - rect.left;
    search = first.elements.find((e) => e.role === "edit" && /search|start a new chat|chat search/i.test(e.name || ""))
      || first.elements.find((e) => e.role === "edit" && e.rect.left < rect.left + width * 0.45 && e.rect.top < rect.top + 200);
  }
  if (!first || !search) return { ok: false, error: `Could not find ${app}'s search box (is ${app} logged in?).` };
  const typeQuery = async (query: string) => {
    const focused = await call("uiAction", { element_id: search!.id, snapshot_id: first!.snapshot_id, action: "focus" }, signal);
    if (!focused.ok) {
      const clicked = await call("uiAction", { element_id: search!.id, snapshot_id: first!.snapshot_id, action: "click" }, signal);
      if (!clicked.ok) return `Could not use the search box: ${clicked.error}`;
    }
    // Clear what was typed before: through the box itself when it allows it,
    // else select-all + delete.
    const cleared = await call("uiAction", { element_id: search!.id, snapshot_id: first!.snapshot_id, action: "set_value", value: "" }, signal);
    if (!cleared.ok) {
      await call("hotkey", { keys: ["ctrl", "a"] }, signal);
      await call("pressKey", { key: "backspace" }, signal);
    }
    const typed = await call("typeUnicode", { text: query }, signal);
    return typed.ok ? null : `Could not type the name: ${typed.error}`;
  };

  // ---- 2. pick the person's own chat row ----------------------------------------------
  // WhatsApp's search is an exact substring search, so a small slip in the
  // surname ("Sharmaa") finds nothing: then search the first name alone and
  // match the full name tolerantly against those results.
  const plain = withoutHonorifics(person);
  const words = plain.split(/\s+/);
  const queries = [...new Set([person.trim(), plain, ...(words.length > 1 ? [words[0]] : [])])];
  let best: { element: UiElement; score: number; title: string } | null = null;
  let snapshot: string | null = null;
  const seen = new Set<string>();
  const titles = new Map<string, number>();
  for (const query of queries) {
    const problem = await typeQuery(query);
    if (problem) return { ok: false, error: problem };
    for (let attempt = 0; attempt < 3 && !best; attempt++) {
      await sleep(attempt === 0 ? 1100 : 800, signal);
      const results = await inspect(undefined, ["listitem", "dataitem", "treeitem", "button"]);
      if (!results) continue;
      snapshot = results.snapshot_id;
      for (const element of results.elements) {
        // Rows in the left (chat list) pane, below the search box.
        if (element.rect.left > rect.left + width * 0.45 || element.rect.top <= search.rect.bottom) continue;
        if (!["listitem", "dataitem", "button", "treeitem"].includes(element.role)) continue;
        const name = element.name || "";
        if (!name.trim()) continue;
        const title = rowTitle(name);
        seen.add(title.slice(0, 50));
        if (looksLikeGroup(title)) continue;
        const score = Math.max(nameMatch(person, title), nameMatch(plain, title)) * (normalizeName(title).length === normalizeName(plain).length ? 1 : 0.92);
        if (score > 0.55) titles.set(title.toLowerCase(), Math.max(titles.get(title.toLowerCase()) ?? 0, score));
        if (score > 0.55 && (!best || score > best.score)) best = { element, score, title };
      }
    }
    if (best) break;
  }
  if (!best || !snapshot) {
    const firstName = normalizeName(plain)[0];
    const close = [...seen].filter((t) => firstName && normalizeName(t)[0] === firstName && !looksLikeGroup(t));
    if (close.length) {
      return { ok: false, error: `AMBIGUOUS_TARGET: no chat is called exactly "${person}"; closest: ${close.join(", ")}.`, candidates: close.slice(0, 5) };
    }
    return {
      ok: false,
      error: `No chat named "${person}" in ${app}'s search results.`,
      candidates: [...seen].filter((t) => !/^(chats|status|channels|communities|recent searches|clear all|meta ai|locked chats)$/i.test(t)).slice(0, 8),
    };
  }
  // Two different people match about equally ("Priya" → Priya Sharma, Priya ke papa): ask.
  const rivals = [...titles.entries()].filter(([t, sc]) => t !== best!.title.toLowerCase() && sc >= best!.score - 0.05);
  if (rivals.length && best.score < 0.999) {
    return { ok: false, error: `AMBIGUOUS_TARGET: "${person}" matches several chats.`, candidates: [best.title, ...rivals.map(([t]) => t)].slice(0, 6) };
  }
  const open = await call("uiAction", { element_id: best.element.id, snapshot_id: snapshot, action: "click" }, signal);
  if (!open.ok) return { ok: false, error: `Could not open the chat: ${open.error}` };
  await sleep(900, signal);

  // ---- 3. verify the conversation header -------------------------------------------------
  const after = await inspect();
  if (!after) return { ok: false, error: "Opened something, but could not read the window to verify it." };
  const header = after.elements
    .filter((e) => e.rect.left > rect.left + width * 0.3 && e.rect.top < rect.top + 140 && (e.name || "").trim())
    .map((e) => e.name);
  const headerText = header.join(" | ");
  const isPerson = header.some((h) => nameMatch(person, h) > 0.55 || nameMatch(plain, h) > 0.55 || nameMatch(best!.title, h) > 0.55);
  // A group header lists its members ("Komal, Murli, Nana, …").
  if (!isPerson || header.some((h) => (h.match(/,/g) || []).length >= 2)) {
    return { ok: false, error: `The chat that opened does not look like ${person}'s personal chat (header: "${headerText.slice(0, 120)}").` };
  }
  const chatName = best.title || header.find((h) => nameMatch(plain, h) > 0.55) || person;
  return { ok: true, chat: chatName };
}

/**
 * Type `text` into the open chat's message box and press Enter. Verified by
 * re-reading the box: after a send it is empty again.
 */
export async function sendInOpenChat(call: AgentCall, text: string, signal?: AbortSignal): Promise<{ ok: boolean; verified: boolean; error?: string }> {
  const read = async () => {
    let response = await call("inspectUi", { max_elements: 220, roles: ["edit"] }, signal);
    if (!response.ok) {
      await sleep(300, signal);
      response = await call("inspectUi", { max_elements: 220, roles: ["edit"] }, signal);
    }
    if (!response.ok) return null;
    return response.result as { snapshot_id: string; elements: UiElement[] };
  };
  const snapshot = await read();
  const box = snapshot?.elements.find((e) => e.role === "edit" && /type a message|message|write a message/i.test(e.name || "") && !/search/i.test(e.name || ""));
  if (!snapshot || !box) return { ok: false, verified: false, error: "Could not find the message box in the open chat." };
  const focus = await call("uiAction", { element_id: box.id, snapshot_id: snapshot.snapshot_id, action: "focus" }, signal);
  if (!focus.ok) {
    const click = await call("uiAction", { element_id: box.id, snapshot_id: snapshot.snapshot_id, action: "click" }, signal);
    if (!click.ok) return { ok: false, verified: false, error: `Could not focus the message box: ${click.error}` };
  }
  const typed = await call("typeUnicode", { text }, signal);
  if (!typed.ok) return { ok: false, verified: false, error: `Could not type: ${typed.error}` };
  const enter = await call("pressKey", { key: "enter" }, signal);
  if (!enter.ok) return { ok: false, verified: false, error: `Could not press Enter: ${enter.error}` };
  await sleep(600, signal);
  const after = await read();
  const again = after?.elements.find((e) => e.role === "edit" && e.name === box.name);
  const value = String(again?.value ?? "").trim();
  return { ok: true, verified: Boolean(again) && value.length === 0 };
}

