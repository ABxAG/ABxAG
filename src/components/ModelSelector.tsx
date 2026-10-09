/**
 * Model selector — which AI model ABxAG uses for each job.
 *
 * Brain: conversation, planning and screen understanding ("Auto" lets the
 * router pick by task and quota). Voice: the realtime Gemini Live session.
 * Background: memory consolidation and summaries. Availability comes from the
 * backend registry; keys are never shown here.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Brain, Check, ChevronDown, Eye, Loader2, RefreshCw, Wrench, Zap, Mic, Cloud, HardDrive } from "lucide-react";
import { api, AVAILABILITY_LABEL, type ModelCatalogue, type ModelSelection, type ModelView } from "../lib/appApi";

type Role = "brain" | "live" | "background";

const ROLE_INFO: Record<Role, { label: string; hint: string; icon: typeof Brain }> = {
  brain: { label: "Brain", hint: "Conversation, planning and screen understanding", icon: Brain },
  live: { label: "Voice", hint: "Realtime voice conversation", icon: Mic },
  background: { label: "Background", hint: "Memory and summaries, runs quietly", icon: Zap },
};

const AVAILABILITY_TONE: Record<ModelView["availability"], string> = {
  available: "text-emerald-300 border-emerald-400/25 bg-emerald-400/10",
  unverified: "text-slate-300 border-white/10 bg-white/5",
  unavailable: "text-rose-300 border-rose-400/25 bg-rose-400/10",
  not_configured: "text-amber-300 border-amber-400/25 bg-amber-400/10",
  disabled: "text-slate-500 border-white/5 bg-white/[0.02]",
};

function modelsFor(role: Role, models: ModelView[]): ModelView[] {
  if (role === "live") return models.filter((m) => m.capabilities.liveAudio);
  return models.filter((m) => !m.capabilities.embedding && !(m.capabilities.liveAudio && !m.capabilities.tools));
}

export function useModelCatalogue(open: boolean) {
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setCatalogue(await api.models());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load models.");
    }
  }, []);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  return { catalogue, setCatalogue, error, reload: load };
}

const ModelOption: React.FC<{ model: ModelView; selected: boolean; onSelect: () => void }> = ({ model, selected, onSelect }) => {
  const unusable = model.availability === "disabled" || model.availability === "not_configured" || model.availability === "unavailable";
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={model.availability === "disabled"}
      className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition cursor-pointer disabled:cursor-not-allowed ${
        selected ? "border-cyan-400/50 bg-cyan-400/10" : "border-white/5 bg-white/[0.03] hover:bg-white/[0.07]"
      } ${unusable ? "opacity-60" : ""}`}
    >
      <span className="mt-0.5 w-3.5 shrink-0 text-cyan-300">{selected && <Check size={14} />}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-white">{model.displayName}</span>
          {model.locality === "local" ? <HardDrive size={10} className="shrink-0 text-slate-400" aria-label="Runs locally" /> : <Cloud size={10} className="shrink-0 text-slate-500" aria-label="Cloud" />}
          {model.capabilities.vision && <Eye size={10} className="shrink-0 text-slate-400" aria-label="Can see images" />}
          {model.capabilities.tools && <Wrench size={10} className="shrink-0 text-slate-400" aria-label="Can use tools" />}
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-slate-400">{model.providerName} · {model.tier}{model.description ? ` · ${model.description}` : ""}</span>
      </span>
      <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[8px] font-mono uppercase ${AVAILABILITY_TONE[model.availability]}`}>
        {AVAILABILITY_LABEL[model.availability]}
      </span>
    </button>
  );
};

/** Full selector body: used inside the header popover and the Settings page. */
export function ModelSelectorPanel({ catalogue, onChanged, onOpenKeys }: { catalogue: ModelCatalogue; onChanged: (catalogue: ModelCatalogue) => void; onOpenKeys?: () => void }) {
  const [role, setRole] = useState<Role>("brain");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const selection = catalogue.selection;
  const options = modelsFor(role, catalogue.models);
  const current = selection[role];

  const select = async (patch: Partial<ModelSelection>) => {
    setBusy("select");
    setMessage(null);
    try {
      const next = await api.selectModels(patch);
      onChanged({ ...catalogue, selection: next });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Could not change the model." });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    const id = current === "auto" ? null : current;
    if (!id) return;
    setBusy("test");
    setMessage(null);
    try {
      const result = await api.testModel(id);
      const ok = result.ok !== false && !result.error;
      setMessage({ ok, text: ok ? `Works${typeof result.latencyMs === "number" ? ` · ${result.latencyMs} ms` : ""}.` : String(result.error) });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Test failed." });
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    setMessage(null);
    try {
      const fresh = await api.refreshModels();
      onChanged({ ...catalogue, ...fresh });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Could not check availability." });
    } finally {
      setBusy(null);
    }
  };

  const missingKeys = catalogue.providers.filter((p) => p.enabled && !p.configured && p.locality !== "local");
  const checkErrors = catalogue.providers.filter((p) => p.enabled && p.configured && p.verificationError);

  return (
    <div className="space-y-3 text-left">
      <div className="grid grid-cols-3 gap-1.5" role="tablist" aria-label="Model role">
        {(Object.keys(ROLE_INFO) as Role[]).map((r) => {
          const Icon = ROLE_INFO[r].icon;
          const id = selection[r];
          const name = id === "auto" ? "Auto" : catalogue.models.find((m) => m.id === id)?.displayName ?? id;
          return (
            <button key={r} type="button" role="tab" aria-selected={role === r} onClick={() => setRole(r)}
              className={`rounded-xl border px-2 py-1.5 text-left transition cursor-pointer ${role === r ? "border-cyan-400/50 bg-cyan-400/10" : "border-white/5 bg-white/[0.03] hover:bg-white/[0.07]"}`}>
              <span className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest text-slate-400"><Icon size={10} /> {ROLE_INFO[r].label}</span>
              <span className="mt-0.5 block truncate text-[11px] text-white">{name}</span>
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-slate-400">{ROLE_INFO[role].hint}</p>

      <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
        {role !== "live" && (
          <button type="button" onClick={() => void select({ [role]: "auto" })}
            className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition cursor-pointer ${current === "auto" ? "border-cyan-400/50 bg-cyan-400/10" : "border-white/5 bg-white/[0.03] hover:bg-white/[0.07]"}`}>
            <span className="mt-0.5 w-3.5 shrink-0 text-cyan-300">{current === "auto" && <Check size={14} />}</span>
            <span>
              <span className="block text-xs font-medium text-white">Auto (recommended)</span>
              <span className="block text-[10px] text-slate-400">Picks a model per task and moves on when one runs out of quota</span>
            </span>
          </button>
        )}
        {options.map((model) => (
          <ModelOption key={model.id} model={model} selected={current === model.id} onSelect={() => void select({ [role]: model.id })} />
        ))}
        {options.length === 0 && <p className="text-[11px] text-slate-500">No models for this role yet.</p>}
      </div>

      <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2">
        <span>
          <span className="block text-[11px] text-white">Switch automatically if a model fails</span>
          <span className="block text-[10px] text-slate-400">Uses the next suitable model instead of stopping</span>
        </span>
        <input type="checkbox" checked={selection.fallbackAllowed} onChange={(e) => void select({ fallbackAllowed: e.target.checked })} className="accent-cyan-500" />
      </label>

      {checkErrors.map((p) => (
        <p key={p.id} className="text-[10px] text-slate-400">Couldn't check {p.displayName} models: {p.verificationError} Models still work; use "Check availability" to retry.</p>
      ))}

      {missingKeys.length > 0 && (
        <p className="text-[10px] text-amber-300/80">
          {missingKeys.map((p) => p.displayName).join(", ")} {missingKeys.length === 1 ? "has" : "have"} no API key.
          {onOpenKeys && <button type="button" onClick={onOpenKeys} className="ml-1 underline cursor-pointer">Add a key</button>}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void test()} disabled={busy !== null || current === "auto"}
          className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[10px] font-mono uppercase text-slate-200 hover:bg-white/10 disabled:opacity-40 cursor-pointer"
          title={current === "auto" ? "Pick a specific model to test it" : "Send a tiny test request"}>
          {busy === "test" ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />} Test
        </button>
        <button type="button" onClick={() => void refresh()} disabled={busy !== null}
          className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[10px] font-mono uppercase text-slate-200 hover:bg-white/10 disabled:opacity-40 cursor-pointer">
          {busy === "refresh" ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Check availability
        </button>
        {busy === "select" && <Loader2 size={12} className="animate-spin text-slate-400" />}
      </div>
      {message && <p className={`text-[11px] ${message.ok ? "text-emerald-300" : "text-rose-300"}`}>{message.text}</p>}
    </div>
  );
}

/** Header chip that shows the current brain model and opens the selector. */
export function ModelChip({ selection, onOpenKeys }: { selection: ModelSelection | null; onOpenKeys: () => void }) {
  const [open, setOpen] = useState(false);
  // Loaded once for the chip label, and refreshed every time the popover opens.
  const { catalogue, setCatalogue, error, reload } = useModelCatalogue(true);
  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);
  const ref = useRef<HTMLDivElement>(null);

  // Live selection changes (voice command, another window) update the chip.
  useEffect(() => {
    if (selection && catalogue) setCatalogue({ ...catalogue, selection });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const brainId = (catalogue?.selection ?? selection)?.brain;
  const brainName = brainId === "auto" || !brainId ? "Auto" : catalogue?.models.find((m) => m.id === brainId)?.displayName ?? brainId;

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog"
        className={`flex items-center gap-1.5 text-xs font-mono tracking-widest transition cursor-pointer ${open ? "text-cyan-400 opacity-100" : "opacity-25 hover:opacity-100 text-white"}`}
        title="Choose which AI model ABxAG uses">
        <Brain size={14} />
        <span className="hidden max-w-[9rem] truncate sm:inline uppercase">{brainName}</span>
        <ChevronDown size={11} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            role="dialog" aria-label="AI models"
            className="absolute right-0 top-8 z-50 w-[22rem] rounded-2xl border border-white/10 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-2xl">
            <div className="mb-3 text-[10px] font-mono uppercase tracking-widest text-slate-400">AI models</div>
            {catalogue ? (
              <ModelSelectorPanel catalogue={catalogue} onChanged={setCatalogue} onOpenKeys={() => { setOpen(false); onOpenKeys(); }} />
            ) : error ? (
              <p className="text-[11px] text-rose-300">{error}</p>
            ) : (
              <Loader2 size={16} className="animate-spin text-slate-400" />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

