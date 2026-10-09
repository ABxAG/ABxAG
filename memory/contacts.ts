/**
 * Contact aliases.
 *
 * "Papa", "Dad" and "Father" may all mean one user-configured contact whose
 * name in WhatsApp is "Papa ❤️". Resolution is deterministic and never
 * guesses: an unknown alias or a tie between contacts is reported as such so
 * the agent asks instead of messaging the wrong person.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/jsonFile";

export interface Contact {
  id: string;
  /** How the user refers to them / default display name. */
  displayName: string;
  aliases: string[];
  /** Exact name as shown inside specific apps, e.g. { whatsapp: "Papa ❤️" }. */
  appNames: Record<string, string>;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export type ContactResolution =
  | { status: "resolved"; contact: Contact; matchedAlias: string }
  | { status: "ambiguous"; candidates: Contact[] }
  | { status: "unknown"; query: string };

/**
 * True synonyms only, used to widen a user-defined alias set. Deliberately
 * limited to parents: "mama" (maternal uncle), "nani"/"dadi" (different
 * grandmothers) and siblings are not interchangeable or unique.
 */
const KINSHIP: string[][] = [
  ["papa", "dad", "daddy", "father", "pitaji", "pappa", "abbu"],
  ["mummy", "mom", "mommy", "mother", "maa", "mumma", "ammi", "mum"],
];

export function normalizeAlias(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\b(ko|ka|ki|ke|se|to)\b/g, " ")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class ContactBook {
  private contacts: Contact[] = [];
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "memory", "contacts.v1.json");
  }

  async initialize(): Promise<void> {
    const stored = await readJsonFile<{ version: 1; contacts: Contact[] }>(this.file, { version: 1, contacts: [] });
    this.contacts = Array.isArray(stored.contacts) ? stored.contacts : [];
  }

  list(): Contact[] {
    return this.contacts.map((contact) => structuredClone(contact));
  }

  get(id: string): Contact | undefined {
    return this.contacts.find((contact) => contact.id === id);
  }

  async upsert(input: { id?: string; displayName: string; aliases?: string[]; appNames?: Record<string, string>; notes?: string; expandKinship?: boolean }): Promise<Contact> {
    const now = new Date().toISOString();
    const displayName = input.displayName.trim();
    if (!displayName) throw new Error("Contact name is required.");
    let aliases = [...new Set([displayName, ...(input.aliases || [])].map(normalizeAlias).filter(Boolean))];
    if (input.expandKinship !== false) {
      for (const group of KINSHIP) {
        if (aliases.some((alias) => group.includes(alias))) aliases = [...new Set([...aliases, ...group])];
      }
    }
    const existing = input.id ? this.get(input.id) : this.contacts.find((contact) => normalizeAlias(contact.displayName) === normalizeAlias(displayName));
    if (existing) {
      existing.displayName = displayName;
      existing.aliases = [...new Set([...existing.aliases, ...aliases])];
      existing.appNames = { ...existing.appNames, ...(input.appNames || {}) };
      if (input.notes !== undefined) existing.notes = input.notes;
      existing.updatedAt = now;
      await this.save();
      return structuredClone(existing);
    }
    const contact: Contact = {
      id: input.id || randomUUID(),
      displayName,
      aliases,
      appNames: input.appNames || {},
      notes: input.notes,
      createdAt: now,
      updatedAt: now,
    };
    this.contacts.push(contact);
    await this.save();
    return structuredClone(contact);
  }

  async remove(id: string): Promise<boolean> {
    const before = this.contacts.length;
    this.contacts = this.contacts.filter((contact) => contact.id !== id);
    if (this.contacts.length !== before) await this.save();
    return this.contacts.length !== before;
  }

  resolve(query: string): ContactResolution {
    const wanted = normalizeAlias(query);
    if (!wanted) return { status: "unknown", query };
    const exact = this.contacts.filter((contact) => contact.aliases.includes(wanted) || normalizeAlias(contact.displayName) === wanted
      || Object.values(contact.appNames).some((name) => normalizeAlias(name) === wanted));
    if (exact.length === 1) return { status: "resolved", contact: structuredClone(exact[0]), matchedAlias: wanted };
    if (exact.length > 1) return { status: "ambiguous", candidates: exact.map((contact) => structuredClone(contact)) };
    // Token containment ("papa ji" -> "papa"), still requiring a unique winner.
    const tokens = new Set(wanted.split(" "));
    const partial = this.contacts.filter((contact) => contact.aliases.some((alias) => alias.split(" ").every((part) => tokens.has(part))));
    if (partial.length === 1) return { status: "resolved", contact: structuredClone(partial[0]), matchedAlias: wanted };
    if (partial.length > 1) return { status: "ambiguous", candidates: partial.map((contact) => structuredClone(contact)) };
    return { status: "unknown", query };
  }

  /** Name to search for inside a specific app. */
  nameForApp(contact: Contact, app: string): string {
    const key = app.toLowerCase();
    return contact.appNames[key] || contact.displayName;
  }

  async markUsed(id: string, app?: string, nameSeenInApp?: string): Promise<void> {
    const contact = this.contacts.find((item) => item.id === id);
    if (!contact) return;
    contact.lastUsedAt = new Date().toISOString();
    if (app && nameSeenInApp) contact.appNames[app.toLowerCase()] = nameSeenInApp;
    await this.save();
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.file, { version: 1, contacts: this.contacts });
  }
}
