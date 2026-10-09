/** Bones tab: every bone in the rig, searchable and filterable by category. */
import React, { useMemo, useState } from 'react';
import type { CharacterSystem } from '../../character/core/CharacterSystem';
import type { BoneCategory } from '@/shared/character/profile';
import { Section } from './ui';

const CATEGORIES: Array<[BoneCategory | 'all', string]> = [
  ['all', 'All'],
  ['body', 'Body'],
  ['finger', 'Fingers'],
  ['face', 'Face'],
  ['secondary', 'Hair/cloth'],
  ['control', 'Control'],
  ['twist', 'Twist'],
  ['helper', 'Helper'],
  ['ik', 'IK'],
  ['prop', 'Props'],
  ['other', 'Other'],
];

export const BonesPanel: React.FC<{ system: CharacterSystem; version: number }> = ({ system, version }) => {
  const editor = system.poseEditor!;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<BoneCategory | 'all'>('all');
  const [editableOnly, setEditableOnly] = useState(true);
  void version;

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const b of editor.catalog) out[b.category] = (out[b.category] ?? 0) + 1;
    return out;
  }, [editor]);

  const q = query.trim().toLowerCase();
  const list = editor.catalog.filter(
    (b) =>
      (category === 'all' || b.category === category) &&
      (!editableOnly || b.rotatable || b.translatable) &&
      (!q || b.name.toLowerCase().includes(q) || b.englishName.toLowerCase().includes(q) || (b.slot ?? '').toLowerCase().includes(q))
  );

  return (
    <div>
      <Section title={`${editor.catalog.length} bones · ${editor.catalog.filter((b) => b.rotatable).length} rotatable`}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, English name or slot"
          className="mb-2 w-full rounded-md border border-white/10 bg-slate-900 px-2 py-1 text-xs outline-none"
        />
        <div className="flex flex-wrap gap-1">
          {CATEGORIES.filter(([c]) => c === 'all' || counts[c]).map(([c, label]) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${category === c ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-100' : 'border-white/10 text-slate-400'}`}
            >
              {label} {c === 'all' ? editor.catalog.length : counts[c]}
            </button>
          ))}
        </div>
        <label className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400">
          <input type="checkbox" checked={editableOnly} onChange={(e) => setEditableOnly(e.target.checked)} /> Editable bones only
        </label>
      </Section>
      <div className="px-2 pb-4">
        {list.slice(0, 600).map((b) => (
          <button
            key={b.name}
            type="button"
            onClick={() => editor.select(b.name)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] ${editor.selection === b.name ? 'bg-cyan-500/15 text-cyan-100' : 'hover:bg-white/5'}`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${editor.isEdited(b.name) ? 'bg-amber-300' : 'bg-transparent'}`} />
            <span className="flex-1 truncate">
              {b.name}
              {b.englishName && b.englishName !== b.name && <span className="text-slate-500"> · {b.englishName}</span>}
            </span>
            <span className="shrink-0 text-[9px] uppercase tracking-wider text-slate-500">
              {b.slot ? b.slot.replace(/_/g, ' ').toLowerCase() : b.drivenBy === 'physics' ? 'physics' : b.category}
            </span>
          </button>
        ))}
        {list.length > 600 && <p className="px-2 text-[10px] text-slate-500">Showing 600 of {list.length}; refine the search.</p>}
      </div>
    </div>
  );
};
