/** Physics tab: global cloth/hair settings, per-chain control, debug view. */
import React, { useEffect, useState } from 'react';
import type { CharacterSystem } from '../../character/core/CharacterSystem';
import type { CharacterProfile } from '@/shared/character/profile';
import type { PhysicsMaterial } from '@/shared/character/secondary';
import { Btn, Section, Segmented, Slider } from './ui';
import { studioApi, type AppSettingsLite } from './studioApi';

const MATERIALS: PhysicsMaterial[] = ['LIGHT_FABRIC', 'MEDIUM_FABRIC', 'HEAVY_FABRIC', 'HAIR', 'RIBBON', 'ACCESSORY', 'SOFT_BODY', 'TAIL'];

export const PhysicsPanel: React.FC<{
  system: CharacterSystem;
  profile: CharacterProfile | null;
  settings: AppSettingsLite | null;
  onSettings: (s: AppSettingsLite) => void;
  onProfile: (p: CharacterProfile) => void;
  onReload: () => void;
}> = ({ system, profile, settings, onSettings, onProfile, onReload }) => {
  const [stats, setStats] = useState(system.secondaryMotion?.stats ?? null);
  const [chainState, setChainState] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setStats(system.secondaryMotion?.stats ?? null), 500);
    return () => window.clearInterval(id);
  }, [system]);

  if (!settings) return <div className="p-4 text-xs text-slate-500">Loading settings…</div>;
  const p = settings.physics;
  const patch = async (physics: Partial<AppSettingsLite['physics']>, developer?: Partial<AppSettingsLite['developer']>) => {
    const next = await studioApi.patchSettings({ physics, ...(developer ? { developer } : {}) });
    onSettings(next);
  };
  const chains = system.rig?.chains ?? [];
  const persistChain = async (id: string, change: { enabled?: boolean; material?: PhysicsMaterial }) => {
    if (!profile) return;
    setBusy(true);
    try {
      const next = await studioApi.update(profile.id, { overrides: { ...profile.overrides, chains: { ...(profile.overrides.chains ?? {}), [id]: { ...(profile.overrides.chains?.[id] ?? {}), ...change } } } });
      onProfile(next);
      if (change.material) onReload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Section title="Cloth & hair physics" right={<input type="checkbox" checked={p.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />}>
        <div className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">Quality</div>
        <Segmented value={p.quality} onChange={(quality) => patch({ quality })} options={[['low', 'Low'], ['balanced', 'Balanced'], ['high', 'High']]} />
        <Slider label="Secondary motion" value={p.secondaryMotion} min={0} max={100} unit="%" onChange={(v) => patch({ secondaryMotion: v })} />
        <div className="mt-2 mb-1 text-[10px] uppercase tracking-wider text-slate-500">Body collision</div>
        <Segmented value={p.collisionQuality} onChange={(collisionQuality) => patch({ collisionQuality })} options={[['off', 'Off'], ['low', 'Torso & legs'], ['high', 'Full body']]} />
        <Slider label="Wind" value={Math.round(p.wind * 100)} min={0} max={100} unit="%" onChange={(v) => patch({ wind: v / 100 })} />
        <p className="text-[10px] text-slate-500">Wind is off by default; ABxAG never adds it on her own.</p>
      </Section>
      <Section title="Advanced">
        <Slider label="Gravity" value={p.gravityMultiplier} min={0} max={3} step={0.05} unit="×" onChange={(v) => patch({ gravityMultiplier: v })} />
        <Slider label="Stiffness" value={p.stiffness} min={0.2} max={3} step={0.05} unit="×" onChange={(v) => patch({ stiffness: v })} />
        <Slider label="Damping" value={p.damping} min={0.2} max={3} step={0.05} unit="×" onChange={(v) => patch({ damping: v })} />
        <Slider label="Drag" value={p.drag} min={0.2} max={3} step={0.05} unit="×" onChange={(v) => patch({ drag: v })} />
        <div className="mt-2 flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <input
              type="checkbox"
              checked={settings.developer.physicsDebug}
              onChange={(e) => {
                system.setPhysicsDebug(e.target.checked);
                void patch({}, { physicsDebug: e.target.checked });
              }}
            />
            Debug view (strands & colliders)
          </label>
          <Btn
            onClick={() => {
              for (let i = 0; i < 16; i += 1) setTimeout(() => system.addScreenMotion(i < 10 ? 40 : -25, i < 10 ? -6 : 3), i * 16);
            }}
          >
            Test shake
          </Btn>
        </div>
        {stats && (
          <p className="mt-2 font-mono text-[10px] text-slate-500">
            {stats.nodes} simulated bones · {stats.colliders} colliders · {stats.hz} Hz ({stats.effectiveQuality}) · {stats.stepMs} ms/frame · max swing {stats.maxDeviationDeg}°
          </p>
        )}
      </Section>
      <Section title={`Chains (${chains.length})`}>
        {chains.length === 0 && <p className="text-[11px] text-slate-500">This model has no secondary-motion chains.</p>}
        {profile && (
          <label className="mb-2 flex items-center gap-1.5 text-[11px] text-slate-400">
            <input
              type="checkbox"
              disabled={busy}
              checked={!!profile.overrides.generateMissingPhysics}
              onChange={async (e) => {
                setBusy(true);
                try {
                  onProfile(await studioApi.update(profile.id, { overrides: { ...profile.overrides, generateMissingPhysics: e.target.checked } }));
                  onReload();
                } finally {
                  setBusy(false);
                }
              }}
            />
            Also simulate hair/cloth bones the author left without physics
          </label>
        )}
        <div className="space-y-1">
          {chains.map((chain) => {
            const enabled = chainState[chain.id] ?? chain.enabled;
            return (
              <div key={chain.id} className="flex items-center gap-2 rounded border border-white/5 px-2 py-1 text-[11px]">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => {
                    system.setChainEnabled(chain.id, e.target.checked);
                    setChainState((s) => ({ ...s, [chain.id]: e.target.checked }));
                    void persistChain(chain.id, { enabled: e.target.checked });
                  }}
                />
                <span className="flex-1 truncate" title={`${chain.bones.length} bones, anchored to ${chain.anchor ?? 'root'}, classified by ${chain.classifiedBy}`}>
                  <span className="capitalize">{chain.class}</span> <span className="text-slate-500">{chain.label} · {chain.bones.length}</span>
                </span>
                <select
                  value={chain.material}
                  disabled={!profile || busy}
                  onChange={(e) => persistChain(chain.id, { material: e.target.value as PhysicsMaterial })}
                  className="rounded border border-white/10 bg-slate-900 px-1 py-0.5 text-[10px]"
                >
                  {MATERIALS.map((m) => (
                    <option key={m} value={m}>
                      {m.replace('_', ' ').toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        {!profile && chains.length > 0 && <p className="mt-1 text-[10px] text-slate-500">Built-in character: chain toggles apply to this session only.</p>}
      </Section>
    </div>
  );
};

