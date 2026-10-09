/**
 * First-run welcome. Runs once after the API key gate (server setting
 * `onboardingComplete`), and again from Settings → System on request.
 * Every step only writes real settings; skipping keeps the safe defaults.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Loader2, Sparkles, ShieldCheck, Brain, MonitorSmartphone, PartyPopper } from "lucide-react";
import { api, type AppSettings, type AppSettingsPatch, type ModelCatalogue } from "../lib/appApi";
import { listAllCharacters, type CharacterListing } from "../character/config/registry";
import type { ABxAGSettings } from "../lib/settingsStore";
import { PermissionRows, usePermissions } from "./SettingsPanel";

type Step = "welcome" | "character" | "ai" | "safety" | "presence" | "done";
const STEPS: Step[] = ["welcome", "character", "ai", "safety", "presence", "done"];

interface OnboardingProps {
  appSettings: AppSettings;
  onAppSettingsChange: (patch: AppSettingsPatch) => void;
  settings: ABxAGSettings;
  onChange: (patch: Partial<ABxAGSettings>) => void;
  onActiveCharacterChange: (id: string) => void;
  onFinish: () => void;
}

function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <span>
        <span className="block text-sm text-white">{label}</span>
        <span className="mt-0.5 block text-xs text-slate-400">{description}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-cyan-500" />
    </label>
  );
}

function CharacterStep({ active, onPick }: { active: string; onPick: (id: string) => void }) {
  const [characters, setCharacters] = useState<CharacterListing[] | null>(null);
  useEffect(() => {
    void listAllCharacters().then(setCharacters);
  }, []);
  if (!characters) return <Loader2 size={18} className="animate-spin text-slate-400" />;
  if (!characters.length) {
    return (
      <p className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm leading-relaxed text-slate-300">
        No character yet. After setup, press <b className="text-white">Import my character</b> and choose a model (.pmx/.pmd/.vrm/.glb/.gltf/.fbx/.obj, or a .zip / folder with one) that you're allowed to use. It stays on your PC.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
        {characters.map((c) => (
          <button key={c.id} type="button" onClick={() => onPick(c.id)} aria-pressed={active === c.id}
            className={`rounded-xl border px-3 py-3 text-left transition cursor-pointer ${active === c.id ? "border-cyan-400/60 bg-cyan-400/10" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.07]"}`}>
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-sm text-white">{c.displayName}</span>
              {active === c.id && <Check size={14} className="shrink-0 text-cyan-300" />}
            </span>
            <span className="mt-0.5 block text-[11px] text-slate-500">{c.source === "built-in" ? "Built in" : "Imported"}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-400">You can import your own PMX characters later in Character Studio. Imported models stay on this PC.</p>
    </div>
  );
}

function AiStep() {
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  useEffect(() => {
    void api.models().then(setCatalogue).catch(() => setCatalogue(null));
  }, []);
  const brain = catalogue?.selection.brain;
  const chatModels = catalogue?.models.filter((m) => !m.capabilities.embedding && !(m.capabilities.liveAudio && !m.capabilities.tools)) ?? [];
  const available = chatModels.filter((m) => m.availability === "available").length;
  const checkError = catalogue?.providers.find((p) => p.id === "gemini")?.verificationError;
  const summary = !catalogue ? "Checking your models…"
    : available ? `${available} Gemini model${available === 1 ? "" : "s"} confirmed for your key.`
    : checkError ? `Couldn't check your models yet (${checkError}). ABxAG will retry in the background.`
    : "Your models haven't been checked yet. ABxAG checks in the background.";
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
        <div className="text-sm text-white">Brain: {brain === "auto" || !brain ? "Auto (recommended)" : catalogue?.models.find((m) => m.id === brain)?.displayName ?? brain}</div>
        <div className="mt-0.5 text-xs text-slate-400">{summary}</div>
      </div>
      <p className="text-xs leading-relaxed text-slate-400">
        Auto picks a suitable Gemini model for each job and moves to another when one runs out of free quota.
        You can choose models yourself anytime from the brain icon at the top of the screen.
      </p>
      <p className="text-xs leading-relaxed text-amber-200/80">Free Gemini keys have small daily limits, so long PC tasks may pause until the quota resets.</p>
    </div>
  );
}

function SafetyStep() {
  const { view, set } = usePermissions();
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-slate-400">
        ABxAG can use your mouse, keyboard, apps and files. You decide what she does freely and what needs your OK. Installs, purchases, account changes and shutting down always ask.
      </p>
      <div className="max-h-64 divide-y divide-white/5 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.03]">
        {view ? <PermissionRows view={view} capabilities={["CONTROL_INPUT", "WRITE_FILE", "DELETE_FILE", "SEND_MESSAGE", "RUN_COMMAND", "SCREEN_CAPTURE"]} onSet={set} />
          : <div className="px-4 py-3"><Loader2 size={14} className="animate-spin text-slate-400" /></div>}
      </div>
    </div>
  );
}

export function Onboarding({ appSettings, onAppSettingsChange, settings, onChange, onActiveCharacterChange, onFinish }: OnboardingProps) {
  const [step, setStep] = useState<Step>("welcome");
  const index = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)]);
  const back = () => setStep(STEPS[Math.max(0, index - 1)]);

  const pickCharacter = (id: string) => {
    onAppSettingsChange({ character: { activeCharacterId: id } });
    onActiveCharacterChange(id);
  };

  const finish = () => {
    onAppSettingsChange({ onboardingComplete: true });
    onFinish();
  };

  const titles: Record<Step, { icon: typeof Sparkles; title: string; text: string }> = {
    welcome: { icon: Sparkles, title: "Hi, I'm ABxAG", text: "I'm a 3D companion who can talk with you, see your screen when you allow it, and do things on your PC for you. Let's set me up in a minute." },
    character: { icon: Sparkles, title: "Pick how I look", text: "Choose a character. You can change this anytime." },
    ai: { icon: Brain, title: "My brain", text: "I think with Google Gemini, using your own API key." },
    safety: { icon: ShieldCheck, title: "What I may do on your PC", text: "Allow: I just do it. Ask: I show you an approval window first. Block: never." },
    presence: { icon: MonitorSmartphone, title: "Being around", text: "How present should I be?" },
    done: { icon: PartyPopper, title: "All set", text: "Talk to me with the power button, or type below. Everything here can be changed in Settings." },
  };
  const { icon: Icon, title, text } = titles[step];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="w-full max-w-xl rounded-3xl border border-white/10 bg-[#07080d]/95 p-6 text-left shadow-2xl sm:p-8">
        <div className="mb-6 flex gap-1.5" aria-hidden>
          {STEPS.map((s, i) => <span key={s} className={`h-1 flex-1 rounded-full ${i <= index ? "bg-cyan-400" : "bg-white/10"}`} />)}
        </div>

        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.2 }}>
            <div className="flex items-start gap-3">
              <div className="rounded-xl border border-cyan-400/25 bg-cyan-400/10 p-2.5 text-cyan-300"><Icon size={20} /></div>
              <div>
                <h2 id="onboarding-title" className="font-display text-xl font-medium text-white">{title}</h2>
                <p className="mt-1 text-sm leading-relaxed text-slate-300">{text}</p>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {step === "character" && <CharacterStep active={appSettings.character.activeCharacterId} onPick={pickCharacter} />}
              {step === "ai" && <AiStep />}
              {step === "safety" && <SafetyStep />}
              {step === "presence" && (
                <>
                  <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <span>
                      <span className="block text-sm text-white">How chatty</span>
                      <span className="mt-0.5 block text-xs text-slate-400">Quiet only answers you. Lively comments and checks in more.</span>
                    </span>
                    <select aria-label="How chatty" value={appSettings.behavior.proactivity} onChange={(e) => onAppSettingsChange({ behavior: { proactivity: e.target.value as AppSettings["behavior"]["proactivity"] } })}
                      className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white outline-none cursor-pointer">
                      <option value="quiet">Quiet</option>
                      <option value="balanced">Balanced</option>
                      <option value="lively">Lively</option>
                    </select>
                  </div>
                  <Toggle label="Stand on my desktop" description="Shows me on your desktop or taskbar outside this window. You can drag me around." checked={appSettings.companion.enabled} onChange={(v) => onAppSettingsChange({ companion: { enabled: v } })} />
                  <Toggle label={`Wake word "${settings.wakePhrase}"`} description="Say it to wake me while this window is open." checked={settings.wakeWordEnabled} onChange={(v) => onChange({ wakeWordEnabled: v })} />
                  <Toggle label="Start with Windows" description="Launch quietly when you log in." checked={settings.autoStart}
                    onChange={(v) => {
                      onChange({ autoStart: v });
                      void fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoStart: v }) }).catch(() => {});
                    }} />
                </>
              )}
              {step === "done" && (
                <ul className="space-y-2 text-sm text-slate-300">
                  <li className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <b className="text-white">Stop me anytime</b> with <kbd className="rounded border border-white/15 bg-black/40 px-1.5 font-mono text-xs">{appSettings.autonomy.emergencyShortcut.replace(/\+/g, " + ")}</kbd>, or the red button while I'm working.
                  </li>
                  <li className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">Try: <i>"Open Notepad and write a shopping list"</i> or <i>"What's on my screen?"</i></li>
                </ul>
              )}
            </div>
          </motion.div>
        </AnimatePresence>

        <div className="mt-8 flex items-center justify-between">
          {index > 0 && step !== "done" ? (
            <button type="button" onClick={back} className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm text-slate-400 hover:text-white cursor-pointer"><ArrowLeft size={14} /> Back</button>
          ) : step === "welcome" ? (
            <button type="button" onClick={finish} className="rounded-xl px-3 py-2 text-sm text-slate-500 hover:text-slate-300 cursor-pointer">Skip setup</button>
          ) : <span />}
          {step === "done" ? (
            <button type="button" onClick={finish} className="flex items-center gap-1.5 rounded-xl border border-cyan-300/40 bg-cyan-400/20 px-5 py-2.5 text-sm font-medium text-cyan-50 hover:bg-cyan-400/30 cursor-pointer">Start <ArrowRight size={14} /></button>
          ) : (
            <button type="button" onClick={next} className="flex items-center gap-1.5 rounded-xl border border-cyan-300/40 bg-cyan-400/20 px-5 py-2.5 text-sm font-medium text-cyan-50 hover:bg-cyan-400/30 cursor-pointer">{step === "welcome" ? "Let's go" : "Next"} <ArrowRight size={14} /></button>
          )}
        </div>
      </div>
    </motion.div>
  );
}


