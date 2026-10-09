/** Fingers tab: joint-by-joint curl/splay/twist plus optional presets. */
import React, { useState } from 'react';
import type { CharacterSystem } from '../../character/core/CharacterSystem';
import type { HandPreset } from '../../character/editor/PoseEditor';
import { FINGERS, FINGER_JOINTS, THUMB_JOINTS, type Side } from '@/shared/character/humanoid';
import { Btn, Section, Segmented, Slider } from './ui';

const JOINT_LABEL: Record<string, string> = {
  METACARPAL: 'Base',
  PROXIMAL: 'Proximal',
  INTERMEDIATE: 'Middle',
  DISTAL: 'Tip',
};

export const FingerPanel: React.FC<{ system: CharacterSystem; version: number }> = ({ system, version }) => {
  const editor = system.poseEditor!;
  const [side, setSide] = useState<Side>('LEFT');
  const [amount, setAmount] = useState(100);
  const [detail, setDetail] = useState<'curl' | 'all'>('curl');
  void version;
  const available = new Set(editor.fingerJoints);
  const sideCount = editor.fingerJoints.filter((k) => k.startsWith(side)).length;

  if (available.size === 0) {
    return (
      <Section title="Fingers">
        <p className="text-[11px] leading-relaxed text-slate-400">
          Individual finger control is unavailable because this source model does not contain finger bones.
        </p>
      </Section>
    );
  }

  return (
    <div>
      <Section title="Hand">
        <Segmented<Side> value={side} onChange={setSide} options={[['LEFT', 'Left hand'], ['RIGHT', 'Right hand']]} />
        <p className="mt-1 text-[10px] text-slate-500">{sideCount}/15 joints present on this hand.</p>
      </Section>
      <Section title="Presets (optional)">
        <div className="flex flex-wrap gap-1">
          {(['open', 'relaxed', 'fist', 'point'] as HandPreset[]).map((preset) => (
            <Btn key={preset} onClick={() => editor.applyHandPreset(side, preset, amount / 100)}>
              {preset}
            </Btn>
          ))}
          <Btn onClick={() => editor.resetLimb(side === 'LEFT' ? 'leftHand' : 'rightHand')}>reset</Btn>
        </div>
        <Slider label="Strength" value={amount} min={0} max={100} unit="%" onChange={setAmount} />
      </Section>
      <Section title="Pose fingers directly">
        <p className="text-[11px] leading-relaxed text-slate-400">
          Zoom to a hand (View: left/right hand) and drag any finger segment on the model to curl it. Double-click a segment to reset it.
        </p>
      </Section>
      <details className="border-b border-white/5">
        <summary className="cursor-pointer px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 hover:text-slate-300">Precise joint values</summary>
      <Section title="Joints" right={<Segmented value={detail} onChange={setDetail} options={[['curl', 'Curl'], ['all', 'Curl+splay+twist']]} />}>
        {FINGERS.map((finger) => {
          const joints = finger === 'THUMB' ? THUMB_JOINTS : FINGER_JOINTS;
          const present = joints.filter((j) => available.has(`${side}_${finger}_${j}`));
          return (
            <div key={finger} className="mb-2">
              <div className="mb-0.5 text-[11px] font-medium capitalize text-slate-300">{finger.toLowerCase()}</div>
              {present.length === 0 && <p className="text-[10px] text-slate-500">Not present in this model.</p>}
              {present.map((joint) => {
                const key = `${side}_${finger}_${joint}`;
                const state = editor.getFingerJoint(key);
                return (
                  <div key={key} className="pl-2">
                    <Slider label={`${JOINT_LABEL[joint]} curl`} value={state.curl} min={-30} max={120} unit="°" onChange={(v) => editor.setFingerJoint(key, { curl: v })} />
                    {detail === 'all' && (
                      <>
                        <Slider label="splay" value={state.splay} min={-35} max={35} unit="°" onChange={(v) => editor.setFingerJoint(key, { splay: v })} />
                        <Slider label="twist" value={state.twist} min={-45} max={45} unit="°" onChange={(v) => editor.setFingerJoint(key, { twist: v })} />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </Section>
      </details>
    </div>
  );
};
