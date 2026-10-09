/** Report tab: compatibility report, runtime tests, profile & persona. */
import React, { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import type { CharacterSystem } from '../../character/core/CharacterSystem';
import { runCharacterTests, type TestResults } from '../../character/testing/CharacterTests';
import { RUNTIME_TESTS, type CharacterProfile } from '@/shared/character/profile';
import { Btn, Section, Slider, StatusDot } from './ui';
import { studioApi } from './studioApi';

const VOICES = ['', 'Leda', 'Zephyr', 'Autonoe', 'Laomedeia', 'Achernar', 'Aoede', 'Kore', 'Callirrhoe', 'Vindemiatrix', 'Sulafat', 'Puck', 'Charon', 'Fenrir', 'Orus'];
const TEST_LABEL: Record<string, string> = {
  renders: 'Renders correctly',
  textures: 'Textures & materials load',
  skeleton: 'Skeleton detected',
  bodyPose: 'Body pose editing',
  handIk: 'Hand IK',
  footIk: 'Foot IK',
  fingers: 'Finger support',
  expressions: 'Expressions',
  animations: 'Animations',
  hairPhysics: 'Hair physics',
  clothPhysics: 'Clothing physics',
  companionRender: 'Desktop companion rendering',
  dragging: 'Dragging',
  sitting: 'Sitting',
  cursorLookAt: 'Cursor look-at',
};

export const ReportPanel: React.FC<{
  system: CharacterSystem;
  characterId: string;
  profile: CharacterProfile | null;
  onProfile: (p: CharacterProfile) => void;
  onDeleted: () => void;
}> = ({ system, characterId, profile, onProfile, onDeleted }) => {
  const [running, setRunning] = useState<string | null>(null);
  const [local, setLocal] = useState<TestResults | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tests = local ?? profile?.report.tests ?? {};

  const run = async () => {
    setError(null);
    setRunning('starting');
    try {
      const results = await runCharacterTests(system, (name) => setRunning(name));
      setLocal(results);
      if (profile) onProfile(await studioApi.recordTests(characterId, results as Record<string, never>));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(null);
    }
  };

  const update = async (patch: Partial<CharacterProfile>) => {
    if (!profile) return;
    try {
      onProfile(await studioApi.update(profile.id, patch));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <Section
        title="Runtime tests"
        right={
          <Btn tone="accent" disabled={!!running} onClick={run}>
            {running ? <Loader2 size={11} className="mr-1 inline animate-spin" /> : <Play size={11} className="mr-1 inline" />}
            {running ? `Running ${TEST_LABEL[running] ?? '…'}` : 'Run all'}
          </Btn>
        }
      >
        <div className="space-y-1.5">
          {RUNTIME_TESTS.map((name) => {
            const result = tests[name];
            return (
              <div key={name} className="flex gap-2 text-[11px]">
                <StatusDot status={result?.status ?? 'not-run'} />
                <div className="min-w-0 flex-1">
                  <div className="text-slate-300">
                    {TEST_LABEL[name]}{' '}
                    <span className="text-[10px] uppercase text-slate-500">{result ? (result.status === 'not-run' ? 'n/a' : result.status) : 'not run'}</span>
                  </div>
                  {result?.detail && <div className="text-[10px] leading-snug text-slate-500">{result.detail}</div>}
                </div>
              </div>
            );
          })}
        </div>
        {!profile && <p className="mt-2 text-[10px] text-slate-500">Built-in character: results are shown here but not stored.</p>}
        {error && <p className="mt-2 text-[10px] text-rose-300">{error}</p>}
      </Section>

      {profile && (
        <>
          <Section title="Compatibility report">
            <div className="space-y-1.5">
              {profile.report.items.map((item) => (
                <div key={item.feature} className="flex gap-2 text-[11px]">
                  <StatusDot status={item.status} />
                  <div className="min-w-0 flex-1">
                    <div className="text-slate-300">{item.feature}</div>
                    <div className="text-[10px] leading-snug text-slate-500">{item.detail}</div>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-slate-500">
              {profile.model.boneCount} bones · {profile.model.morphCount} morphs · {profile.model.rigidBodyCount} rigid bodies · {profile.model.vertexCount.toLocaleString()} vertices
              {profile.source.companionModels.length > 0 && ` · also in archive (not imported): ${profile.source.companionModels.join(', ')}`}
            </p>
          </Section>

          <Section title="Profile">
            <label className="mb-1 flex items-center gap-2 text-[11px]">
              <span className="w-20 text-slate-400">Name</span>
              <input
                defaultValue={profile.displayName}
                onBlur={(e) => e.target.value.trim() && e.target.value !== profile.displayName && update({ displayName: e.target.value })}
                className="flex-1 rounded border border-white/10 bg-slate-900 px-2 py-1 text-xs outline-none"
              />
            </label>
            <Slider label="Scale" value={profile.scale} min={0.1} max={4} step={0.01} unit="×" onChange={(v) => update({ scale: v })} />
            <Slider label="Ground offset" value={profile.groundOffset} min={-5} max={5} step={0.05} onChange={(v) => update({ groundOffset: v })} />
            <Slider label="Companion size" value={profile.companion.scale} min={0.3} max={3} step={0.05} unit="×" onChange={(v) => update({ companion: { ...profile.companion, scale: v } })} />
            <label className="mt-1 flex items-center gap-2 text-[11px]">
              <span className="w-20 text-slate-400">Voice</span>
              <select
                value={profile.persona.voiceName ?? ''}
                onChange={(e) => update({ persona: { ...profile.persona, voiceName: e.target.value || undefined } })}
                className="flex-1 rounded border border-white/10 bg-slate-900 px-1 py-1 text-xs"
              >
                {VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v || 'Use the global voice setting'}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-1 flex items-center gap-2 text-[11px]">
              <span className="w-20 text-slate-400">Personality</span>
              <select
                value={profile.persona.personalityId ?? ''}
                onChange={(e) => update({ persona: { ...profile.persona, personalityId: e.target.value || undefined } })}
                className="flex-1 rounded border border-white/10 bg-slate-900 px-1 py-1 text-xs"
              >
                <option value="">ABxAG (default)</option>
                <option value="calm">Calm & gentle</option>
                <option value="playful">Playful</option>
                <option value="focused">Focused & brief</option>
              </select>
            </label>
          </Section>

          <Section title="Licence & files">
            {profile.source.restrictions.length > 0 && (
              <p className="mb-1 text-[11px] text-amber-200/90">Author restrictions: {profile.source.restrictions.join(' · ')}. Kept local; never bundled or shared by ABxAG.</p>
            )}
            {profile.source.licenseText && (
              <details className="text-[10px] text-slate-400">
                <summary className="cursor-pointer text-slate-500">Original readme</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-900 p-2">{profile.source.licenseText}</pre>
              </details>
            )}
            <p className="mt-1 break-all text-[10px] text-slate-500">Source: {profile.source.originalPath}</p>
            <div className="mt-2">
              {!confirmDelete ? (
                <Btn tone="danger" onClick={() => setConfirmDelete(true)}>
                  Remove from ABxAG…
                </Btn>
              ) : (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="text-slate-400">Delete the imported copy? Your original file is not touched.</span>
                  <Btn tone="danger" onClick={() => studioApi.remove(profile.id).then(onDeleted)}>
                    Delete
                  </Btn>
                  <Btn onClick={() => setConfirmDelete(false)}>Cancel</Btn>
                </div>
              )}
            </div>
          </Section>
        </>
      )}
    </div>
  );
};

