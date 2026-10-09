/** Pose tab: ownership, gizmo tools, IK handles, selected bone, whole-pose ops. */
import React, { useEffect, useState } from 'react';
import type { CharacterSystem } from '../../character/core/CharacterSystem';
import type { IkHandleId, LimbGroup, PoseData, PoseOwnership } from '../../character/editor/PoseEditor';
import { Btn, Section, Segmented, Slider } from './ui';
import { studioApi, type SavedPoseRecord } from './studioApi';
import { SEAT_LABEL, STYLE_LABEL, STYLES_FOR_SEAT, type SeatKind, type SitStyle } from '../../character/scene/Seating';

const SEATS = Object.keys(SEAT_LABEL) as SeatKind[];

/** Sit on a real seat: pick the seat, then a style that suits it. */
const SeatSection: React.FC<{ system: CharacterSystem }> = ({ system }) => {
  const current = system.seat;
  const [seat, setSeat] = useState<SeatKind>(current?.seat ?? 'chair');
  const [side, setSide] = useState<1 | -1>(1);
  const [active, setActive] = useState(current);
  const styles = STYLES_FOR_SEAT[seat];
  const sit = (style: SitStyle) => {
    system.sit({ seat, style, side });
    setActive(system.seat);
  };
  return (
    <Section title="Sit">
      <div className="flex flex-wrap gap-1">
        {SEATS.map((s) => (
          <Btn key={s} active={seat === s} onClick={() => setSeat(s)}>{SEAT_LABEL[s]}</Btn>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {styles.map((style) => (
          <Btn key={style} tone={active?.seat === seat && active?.style === style ? 'accent' : 'default'} onClick={() => sit(style)}>
            {STYLE_LABEL[style]}
          </Btn>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1">
        <Btn active={side === 1} onClick={() => setSide(1)} title="Asymmetric styles lean to her left">Left</Btn>
        <Btn active={side === -1} onClick={() => setSide(-1)} title="Asymmetric styles lean to her right">Right</Btn>
        <span className="flex-1" />
        <Btn onClick={() => { system.stand(); setActive(null); }} disabled={!active}>Stand up</Btn>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        The seat is sized to her legs. Hips rest on it, feet reach the floor (or hang), hands rest where they naturally would, and she keeps breathing and looking around.
      </p>
    </Section>
  );
};

const HANDLES: Array<[IkHandleId, string]> = [
  ['LEFT_HAND', 'L hand'],
  ['RIGHT_HAND', 'R hand'],
  ['LEFT_FOOT', 'L foot'],
  ['RIGHT_FOOT', 'R foot'],
  ['LOOK', 'Head look'],
];

const LIMBS: Array<[LimbGroup, string]> = [
  ['leftArm', 'Left arm'],
  ['rightArm', 'Right arm'],
  ['leftHand', 'Left hand'],
  ['rightHand', 'Right hand'],
  ['leftLeg', 'Left leg'],
  ['rightLeg', 'Right leg'],
  ['torso', 'Torso'],
  ['head', 'Head & neck'],
];

export const PosePanel: React.FC<{ system: CharacterSystem; characterId: string; version: number }> = ({ system, characterId, version }) => {
  const editor = system.poseEditor!;
  const [gizmo, setGizmo] = useState<'rotate' | 'translate'>('rotate');
  const [space, setSpace] = useState<'local' | 'world'>('local');
  const [poses, setPoses] = useState<SavedPoseRecord[]>([]);
  const [poseName, setPoseName] = useState('');
  const [blendA, setBlendA] = useState<string>('');
  const [blendB, setBlendB] = useState<string>('');
  const [blendT, setBlendT] = useState(0.5);
  const [note, setNote] = useState<string | null>(null);
  void version;

  const reload = () => studioApi.poses(characterId).then(setPoses).catch(() => setPoses([]));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  const selected = editor.selection;
  const entry = selected ? editor.entry(selected) : undefined;
  const euler = selected ? editor.getBoneEuler(selected) : [0, 0, 0];
  const translation = selected ? editor.getBoneTranslation(selected) : [0, 0, 0];

  const save = async () => {
    const name = poseName.trim();
    if (!name) return;
    const data = editor.capture();
    if (Object.keys(data.bones).length === 0) {
      setNote('Nothing to save: the pose has no edits yet.');
      return;
    }
    await studioApi.savePose({ name, characterId, bones: data.bones, translations: data.translations, space: 'bind', tags: [] });
    setPoseName('');
    setNote(`Saved “${name}”.`);
    void reload();
  };

  const asData = (p: SavedPoseRecord): PoseData => ({ version: 2, space: p.space === 'bind' ? 'bind' : 'bind', bones: p.bones, translations: p.translations });

  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(editor.capture()));
    setNote('Pose copied to the clipboard as JSON.');
  };
  const paste = async () => {
    try {
      const data = JSON.parse(await navigator.clipboard.readText()) as PoseData;
      const count = editor.apply(data, { duration: 0.3 });
      setNote(`Pasted pose (${count} bones).`);
    } catch {
      setNote('Clipboard does not contain a pose.');
    }
  };

  return (
    <div>
      <Section title="Pose ownership">
        <Segmented<PoseOwnership>
          value={editor.ownership}
          onChange={(m) => editor.setOwnership(m)}
          options={[
            ['AI', 'AI'],
            ['USER', 'User'],
            ['BLENDED', 'Blended'],
          ]}
        />
        {editor.ownership === 'BLENDED' && (
          <Slider label="AI on top" value={Math.round(editor.blendAmount * 100)} min={0} max={100} unit="%" onChange={(v) => (editor.blendAmount = v / 100)} />
        )}
        <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
          AI animates freely · User holds your pose exactly (eyes stay alive) · Blended layers AI motion on top of your pose. Editing switches AI → User.
        </p>
      </Section>

      <Section title="Direct posing">
        <p className="text-[11px] leading-relaxed text-slate-400">
          Grab the character with the mouse: hands and feet move the whole limb (IK), the head turns, the hips move the body, arms, legs, spine and fingers rotate, and hair or clothes can be pulled — they swing back under physics when released. Double-click a part to reset it.
        </p>
      </Section>
      <details className="border-b border-white/5">
        <summary className="cursor-pointer px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 hover:text-slate-300">Precise tools (gizmos, IK handles, numbers)</summary>
      <Section title="Tools">
        <div className="flex gap-2">
          <Segmented value={gizmo} onChange={(v) => { setGizmo(v); editor.setGizmoMode(v); }} options={[['rotate', 'Rotate'], ['translate', 'Move']]} />
          <Segmented value={space} onChange={(v) => { setSpace(v); editor.setGizmoSpace(v); }} options={[['local', 'Local'], ['world', 'World']]} />
        </div>
        <div className="mt-2 text-[10px] uppercase tracking-wider text-slate-500">IK handles (drag to pose a limb)</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {HANDLES.filter(([id]) => editor.availableHandles.includes(id)).map(([id, label]) => (
            <Btn key={id} active={editor.handle === id} onClick={() => editor.selectHandle(editor.handle === id ? null : id)}>
              {label}
            </Btn>
          ))}
        </div>
        {editor.lastIk && editor.handle && editor.handle !== 'LOOK' && (
          <div className="mt-1 text-[10px] text-slate-500">
            {editor.lastIk.reached ? 'Target reached' : 'Out of reach — limb fully extended'} · bend {editor.lastIk.bendDeg.toFixed(0)}°
          </div>
        )}
      </Section>

      <Section
        title="Selected bone"
        right={selected && <Btn onClick={() => editor.select(null)}>Deselect</Btn>}
      >
        {!selected || !entry ? (
          <p className="text-[11px] text-slate-500">Click a bone on the character, or pick one in the Bones tab.</p>
        ) : (
          <div>
            <div className="text-sm">{entry.name}</div>
            <div className="mb-2 text-[10px] text-slate-500">
              {entry.englishName && `${entry.englishName} · `}
              {entry.slot ?? entry.category} · {entry.drivenBy === 'physics' ? 'physics-driven (held while dragging)' : entry.drivenBy === 'grant' ? 'follows another bone' : 'animated'}
            </div>
            {entry.rotatable ? (
              (['X', 'Y', 'Z'] as const).map((axis, i) => (
                <Slider
                  key={axis}
                  label={`Rotate ${axis}`}
                  value={euler[i]}
                  min={-180}
                  max={180}
                  step={0.5}
                  unit="°"
                  onChange={(v) => {
                    const next = [...euler] as [number, number, number];
                    next[i] = v;
                    editor.setBoneEuler(selected, next);
                  }}
                />
              ))
            ) : (
              <p className="text-[11px] text-slate-500">This bone is not rotatable in the source rig.</p>
            )}
            {entry.translatable &&
              (['X', 'Y', 'Z'] as const).map((axis, i) => (
                <Slider
                  key={`t${axis}`}
                  label={`Move ${axis}`}
                  value={translation[i]}
                  min={-10}
                  max={10}
                  step={0.01}
                  onChange={(v) => {
                    const next = [...translation] as [number, number, number];
                    next[i] = v;
                    editor.setBoneTranslation(selected, next);
                  }}
                />
              ))}
            <div className="mt-2 flex gap-1">
              <Btn onClick={() => editor.resetBone(selected)}>Reset bone</Btn>
            </div>
          </div>
        )}
      </Section>

      </details>

      <Section title="Reset & mirror">
        <div className="flex flex-wrap gap-1">
          {LIMBS.map(([id, label]) => (
            <Btn key={id} onClick={() => editor.resetLimb(id)}>
              Reset {label.toLowerCase()}
            </Btn>
          ))}
          <Btn tone="danger" onClick={() => editor.resetBody()}>
            Reset body
          </Btn>
        </div>
        <div className="mt-2 flex gap-1">
          <Btn onClick={() => editor.mirror('leftToRight')}>Mirror L → R</Btn>
          <Btn onClick={() => editor.mirror('rightToLeft')}>Mirror R → L</Btn>
          <Btn onClick={() => editor.mirror('flip')}>Flip</Btn>
        </div>
      </Section>

      <SeatSection system={system} />

      <Section title="Poses">
        <div className="flex gap-1">
          <input
            value={poseName}
            onChange={(e) => setPoseName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            placeholder="Pose name"
            className="flex-1 rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-xs outline-none"
          />
          <Btn tone="accent" onClick={save} disabled={!poseName.trim()}>
            Save
          </Btn>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <Btn onClick={() => { system.stand(0); editor.resetBody(); }}>Stand (rest)</Btn>
          <Btn onClick={copy}>Copy</Btn>
          <Btn onClick={paste}>Paste</Btn>
        </div>
        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
          {poses.length === 0 && <p className="text-[11px] text-slate-500">No saved poses for this character yet.</p>}
          {poses.map((p) => (
            <div key={p.id} className="flex items-center gap-1 rounded border border-white/5 px-2 py-1 text-[11px]">
              <span className="flex-1 truncate">
                {p.name}
                {p.characterId !== characterId && <span className="text-slate-500"> · from {p.characterId}</span>}
              </span>
              <Btn onClick={() => editor.apply(asData(p), { duration: 0.4 })}>Load</Btn>
              <Btn tone="danger" onClick={() => studioApi.deletePose(p.id).then(reload)}>
                ✕
              </Btn>
            </div>
          ))}
        </div>
        {poses.length >= 2 && (
          <div className="mt-2 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">Blend two poses</div>
            <div className="flex gap-1">
              {[blendA, blendB].map((value, i) => (
                <select
                  key={i}
                  value={value}
                  onChange={(e) => (i === 0 ? setBlendA(e.target.value) : setBlendB(e.target.value))}
                  className="flex-1 rounded border border-white/10 bg-slate-900 px-1 py-1 text-[11px]"
                >
                  <option value="">{i === 0 ? 'Pose A' : 'Pose B'}</option>
                  {poses.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ))}
            </div>
            <Slider
              label="A ↔ B"
              value={Math.round(blendT * 100)}
              min={0}
              max={100}
              unit="%"
              disabled={!blendA || !blendB}
              onChange={(v) => {
                setBlendT(v / 100);
                const a = poses.find((p) => p.id === blendA);
                const b = poses.find((p) => p.id === blendB);
                if (a && b) editor.blend(asData(a), asData(b), v / 100);
              }}
            />
          </div>
        )}
        {note && <p className="mt-2 text-[10px] text-slate-400">{note}</p>}
      </Section>
    </div>
  );
};
