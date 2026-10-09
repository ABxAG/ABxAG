/** Backend calls used by the Character Studio. All go to the local server. */
import type { CharacterProfile, RuntimeTestResult } from '@/shared/character/profile';

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || `Request failed (${response.status})`);
  return body as T;
}

export const studioApi = {
  profile: (id: string) => fetch(`/api/characters/${encodeURIComponent(id)}`).then((r) => json<CharacterProfile>(r)),
  update: (id: string, patch: Partial<CharacterProfile>) =>
    fetch(`/api/characters/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => json<CharacterProfile>(r)),
  remove: (id: string) => fetch(`/api/characters/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  importSource: (source: string, displayName?: string) =>
    fetch('/api/characters/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, displayName }) }).then((r) =>
      json<{ profile: CharacterProfile; warnings: string[]; replaced: boolean }>(r)
    ),
  recordTests: (id: string, results: Record<string, RuntimeTestResult>) =>
    fetch(`/api/characters/${encodeURIComponent(id)}/tests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ results }) }).then((r) => json<CharacterProfile>(r)),
  poses: (characterId: string) =>
    fetch(`/api/poses?characterId=${encodeURIComponent(characterId)}`).then((r) => json<SavedPoseRecord[]>(r)),
  savePose: (pose: Omit<SavedPoseRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) =>
    fetch('/api/poses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pose) }).then((r) => json<SavedPoseRecord>(r)),
  deletePose: (id: string) => fetch(`/api/poses/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  settings: () => fetch('/api/app-settings').then((r) => json<AppSettingsLite>(r)),
  patchSettings: (patch: Record<string, unknown>) =>
    fetch('/api/app-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => json<AppSettingsLite>(r)),
};

export interface SavedPoseRecord {
  id: string;
  name: string;
  characterId: string;
  createdAt: string;
  updatedAt: string;
  bones: Record<string, [number, number, number, number]>;
  translations?: Record<string, [number, number, number]>;
  space?: 'bind';
  tags: string[];
}

export interface AppSettingsLite {
  character: { activeCharacterId: string; eyeFollowCursor: boolean; headFollowCursor: boolean; idleVariety: number };
  physics: {
    enabled: boolean;
    quality: 'low' | 'balanced' | 'high';
    secondaryMotion: number;
    gravityMultiplier: number;
    stiffness: number;
    damping: number;
    drag: number;
    collisionQuality: 'off' | 'low' | 'high';
    wind: number;
  };
  developer: { physicsDebug: boolean };
}

/** Map persisted physics settings onto the runtime solver's settings. */
export function physicsFromSettings(p: AppSettingsLite['physics']) {
  return {
    enabled: p.enabled,
    quality: p.quality,
    secondaryMotion: p.secondaryMotion / 100,
    gravityMultiplier: p.gravityMultiplier,
    stiffness: p.stiffness,
    damping: p.damping,
    drag: p.drag,
    collisionQuality: p.collisionQuality,
    wind: p.wind,
  };
}
