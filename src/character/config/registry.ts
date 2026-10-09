/**
 * Character registry.
 *
 * Built-in characters are compiled in; user characters are imported locally
 * (see character_import/) and fetched from the backend, which serves them
 * from the user's data folder. Both resolve to the same CharacterConfig.
 */
import type { CharacterConfig } from './types';
import type { CharacterProfile } from '@/shared/character/profile';
import { evelynConfig } from './characters/evelyn';
import { configFromProfile } from './fromProfile';

/**
 * Public installers (npm run dist:public) ship without the bundled model:
 * its licence forbids redistribution. Each user imports their own character.
 */
export const PUBLIC_BUILD = import.meta.env.VITE_ABxAG_PUBLIC === '1';

export const CHARACTERS: Record<string, CharacterConfig> = PUBLIC_BUILD ? {} : {
  [evelynConfig.id]: evelynConfig,
};

export const DEFAULT_CHARACTER_ID = evelynConfig.id;

/** Raised when there is no character to show yet (public build, nothing imported). */
export const NO_CHARACTER = 'NO_CHARACTER';

export function getCharacterConfig(id: string = DEFAULT_CHARACTER_ID): CharacterConfig {
  return CHARACTERS[id] ?? CHARACTERS[DEFAULT_CHARACTER_ID] ?? evelynConfig;
}

export function isBuiltInCharacter(id: string): boolean {
  return id in CHARACTERS;
}

export interface CharacterListing {
  id: string;
  displayName: string;
  source: 'built-in' | 'user';
  restrictions?: string[];
  summary?: { supported: number; partial: number; unsupported: number; testsPassed: number; testsFailed: number };
}

export function listCharacters(): Array<{ id: string; displayName: string }> {
  return Object.values(CHARACTERS).map((c) => ({ id: c.id, displayName: c.displayName }));
}

/** Built-in plus locally imported characters. */
export async function listAllCharacters(): Promise<CharacterListing[]> {
  const builtIn: CharacterListing[] = Object.values(CHARACTERS).map((c) => ({ id: c.id, displayName: c.displayName, source: 'built-in' }));
  try {
    const response = await fetch('/api/characters');
    if (!response.ok) return builtIn;
    const users = (await response.json()) as Array<{ id: string; displayName: string; restrictions: string[]; summary: CharacterListing['summary'] }>;
    return [...builtIn, ...users.filter((u) => !(u.id in CHARACTERS)).map((u) => ({ id: u.id, displayName: u.displayName, source: 'user' as const, restrictions: u.restrictions, summary: u.summary }))];
  } catch {
    return builtIn;
  }
}

export async function fetchCharacterProfile(id: string): Promise<CharacterProfile> {
  const response = await fetch(`/api/characters/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Character "${id}" is not available (${response.status}).`);
  return (await response.json()) as CharacterProfile;
}

/** Resolve any character id to a runnable config (and its profile if imported). */
export async function resolveCharacter(id: string | undefined): Promise<{ config: CharacterConfig; profile?: CharacterProfile }> {
  if (id && id in CHARACTERS) return { config: getCharacterConfig(id) };
  if (!id && !PUBLIC_BUILD) return { config: getCharacterConfig() };
  if (!id) {
    // Public build: the first imported character, if any.
    const imported = (await listAllCharacters()).find((c) => c.source === 'user');
    if (!imported) throw new Error(NO_CHARACTER);
    id = imported.id;
  }
  try {
    const profile = await fetchCharacterProfile(id);
    return { config: configFromProfile(profile), profile };
  } catch (error) {
    if (!PUBLIC_BUILD) throw error;
    // The chosen character was removed: fall back to any other import.
    const imported = (await listAllCharacters()).find((c) => c.source === 'user' && c.id !== id);
    if (!imported) throw new Error(NO_CHARACTER);
    const profile = await fetchCharacterProfile(imported.id);
    return { config: configFromProfile(profile), profile };
  }
}



