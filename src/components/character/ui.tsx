/** Small, consistent controls for the Character Studio panels. */
import React from 'react';

export const Section: React.FC<{ title: string; right?: React.ReactNode; children: React.ReactNode }> = ({ title, right, children }) => (
  <section className="border-b border-white/5 px-4 py-3">
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">{title}</h3>
      {right}
    </div>
    {children}
  </section>
);

export const Btn: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'accent' | 'danger'; active?: boolean }> = ({
  tone = 'default',
  active,
  className,
  ...props
}) => (
  <button
    type="button"
    {...props}
    className={`rounded-md border px-2 py-1 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
      active
        ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-100'
        : tone === 'accent'
          ? 'border-cyan-400/40 bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/20'
          : tone === 'danger'
            ? 'border-rose-400/40 text-rose-200 hover:bg-rose-500/10'
            : 'border-white/10 text-slate-300 hover:bg-white/5'
    } ${className ?? ''}`}
  />
);

export const Slider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  disabled?: boolean;
}> = ({ label, value, min, max, step = 1, unit = '', onChange, disabled }) => (
  <label className={`flex items-center gap-2 py-0.5 text-[11px] ${disabled ? 'opacity-40' : ''}`}>
    <span className="w-20 shrink-0 truncate text-slate-400" title={label}>
      {label}
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-1 flex-1 accent-cyan-400"
    />
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={Number.isFinite(value) ? +value.toFixed(step < 1 ? 2 : 0) : 0}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-14 rounded border border-white/10 bg-slate-900 px-1 py-0.5 text-right font-mono text-[10px] outline-none"
    />
    {unit && <span className="w-3 text-[10px] text-slate-500">{unit}</span>}
  </label>
);

export const Segmented = <T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) => (
  <div className="flex overflow-hidden rounded-md border border-white/10">
    {options.map(([v, label]) => (
      <button
        key={v}
        type="button"
        onClick={() => onChange(v)}
        className={`flex-1 px-2 py-1 text-[11px] ${value === v ? 'bg-cyan-500/20 text-cyan-100' : 'text-slate-400 hover:bg-white/5'}`}
      >
        {label}
      </button>
    ))}
  </div>
);

export const StatusDot: React.FC<{ status: 'supported' | 'partial' | 'unsupported' | 'pass' | 'fail' | 'not-run' }> = ({ status }) => {
  const color = status === 'supported' || status === 'pass' ? 'bg-emerald-400' : status === 'partial' ? 'bg-amber-400' : status === 'not-run' ? 'bg-slate-500' : 'bg-rose-400';
  return <span className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
};
