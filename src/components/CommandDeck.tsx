import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Power,
  Monitor,
  Eye,
  EyeOff,
  MousePointer2,
  Palette,
  Settings as SettingsIcon,
  Brain,
  Sparkles,
  ChevronUp,
  TerminalSquare,
} from "lucide-react";
import type { LiveState } from "../lib/audio";
import {
  ACCENT_THEMES,
  SHORTCUTS,
  accentGlow,
  formatLogLine,
  type LogNotice,
} from "../lib/cyberpunk";

export interface CommandDeckProps {
  connection: LiveState;
  sharing: boolean;
  visionOn: boolean;
  cursorOn: boolean;
  theme: string;
  notices: LogNotice[];
  onToggleConnection: () => void;
  onShare: () => void;
  onUnshare: () => void;
  onVision: (v: boolean) => void;
  onCursor: (v: boolean) => void;
  onTheme: (id: string) => void;
  onOpenSettings: () => void;
  onOpenMemory: () => void;
  onOpenStudio: () => void;
}

const STATE_META: Record<LiveState, { label: string; dot: string }> = {
  disconnected: { label: "OFFLINE", dot: "bg-slate-500" },
  connecting: { label: "LINKING", dot: "bg-amber-400 animate-pulse" },
  listening: { label: "LISTENING", dot: "bg-emerald-400 animate-pulse" },
  speaking: { label: "SPEAKING", dot: "bg-cyan-400 animate-pulse" },
};

/**
 * CommandDeck — collapsible floating cyberpunk control panel.
 * Collapsed to a glowing orb by default: zero interference with the
 * existing UI (and with the Ctrl+K command palette). All actions delegate
 * to the host's existing handlers.
 */
export function CommandDeck(props: CommandDeckProps) {
  const [open, setOpen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const meta = STATE_META[props.connection] ?? STATE_META.disconnected;
  const glow = accentGlow(props.theme);
  const connected = props.connection === "listening" || props.connection === "speaking";
  const tail = props.notices.slice(-4).reverse();

  const actionBtn =
    "flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-[10px] font-mono text-slate-200 transition hover:bg-white/10 hover:text-white cursor-pointer disabled:opacity-40";

  return (
    <div className="absolute bottom-6 left-6 md:bottom-10 md:left-10 z-50 flex flex-col items-start gap-2">
      <AnimatePresence>
        {open && (
          <motion.div
            key="deck"
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            className="w-64 overflow-hidden rounded-2xl border border-cyan-400/20 bg-slate-950/80 shadow-[0_18px_60px_rgba(0,0,0,0.65)] backdrop-blur-2xl"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
              <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
              <span className="font-mono text-[10px] font-bold tracking-[0.25em] text-slate-200">
                CMD.DECK // {meta.label}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1.5 p-2.5">
              <button className={actionBtn} onClick={props.onToggleConnection} title="Connect / disconnect voice">
                <Power size={11} className={connected ? "text-emerald-300" : "text-slate-400"} />
                {connected ? "Disconnect" : "Connect"}
              </button>
              <button
                className={actionBtn}
                onClick={() => (props.sharing ? props.onUnshare() : props.onShare())}
                title="Toggle screen sharing"
              >
                <Monitor size={11} className={props.sharing ? "text-cyan-300" : "text-slate-400"} />
                {props.sharing ? "Unshare" : "Share"}
              </button>
              <button className={actionBtn} onClick={() => props.onVision(!props.visionOn)} title="Toggle screen vision">
                {props.visionOn ? <Eye size={11} className="text-cyan-300" /> : <EyeOff size={11} className="text-slate-400" />}
                Vision {props.visionOn ? "on" : "off"}
              </button>
              <button className={actionBtn} onClick={() => props.onCursor(!props.cursorOn)} title="Virtual AI cursor kill-switch">
                <MousePointer2 size={11} className={props.cursorOn ? "text-emerald-300" : "text-rose-400"} />
                Cursor {props.cursorOn ? "on" : "off"}
              </button>
              <button className={actionBtn} onClick={props.onOpenSettings} title="Open settings">
                <SettingsIcon size={11} /> Settings
              </button>
              <button className={actionBtn} onClick={props.onOpenMemory} title="Open memory">
                <Brain size={11} /> Memory
              </button>
              <button className={`${actionBtn} col-span-2`} onClick={props.onOpenStudio} title="Open character studio">
                <Sparkles size={11} /> Character studio
              </button>
            </div>

            <div className="flex items-center gap-2 border-t border-white/5 px-3 py-2">
              <Palette size={11} className="shrink-0 text-slate-400" />
              <div className="flex items-center gap-1.5">
                {ACCENT_THEMES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => props.onTheme(t.id)}
                    title={t.label}
                    aria-label={`Theme ${t.label}`}
                    className={`h-4 w-4 rounded-full transition hover:scale-125 cursor-pointer ${
                      props.theme === t.id ? "ring-2 ring-white/70 ring-offset-1 ring-offset-slate-950" : "opacity-60 hover:opacity-100"
                    }`}
                    style={{ backgroundColor: t.glow, boxShadow: `0 0 10px ${t.glow}` }}
                  />
                ))}
              </div>
            </div>

            <button
              className="flex w-full items-center gap-1.5 border-t border-white/5 px-3 py-2 font-mono text-[10px] text-slate-400 transition hover:text-white cursor-pointer"
              onClick={() => setShowLog((v) => !v)}
            >
              <TerminalSquare size={11} /> SYS.LOG
              <ChevronUp size={11} className={`ml-auto transition-transform ${showLog ? "" : "rotate-180"}`} />
            </button>
            <AnimatePresence initial={false}>
              {showLog && (
                <motion.div
                  key="log"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden border-t border-white/5"
                >
                  <div className="max-h-24 space-y-1 overflow-y-auto px-3 py-2 font-mono text-[9px] leading-relaxed text-slate-400">
                    {tail.length === 0 && <div className="text-slate-600">// no events yet</div>}
                    {tail.map((n, i) => (
                      <div key={`${n.at}-${i}`} className="break-words">
                        {formatLogLine(n)}
                      </div>
                    ))}
                  </div>
                  <div className="space-y-0.5 border-t border-white/5 px-3 py-2 font-mono text-[9px] text-slate-500">
                    {SHORTCUTS.map((s) => (
                      <div key={s.keys} className="flex justify-between gap-2">
                        <span className="text-slate-300">{s.keys}</span>
                        <span className="text-right">{s.action}</span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        onClick={() => setOpen((v) => !v)}
        title={open ? "Collapse command deck" : "Open command deck"}
        aria-expanded={open}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.94 }}
        className="cyber-orb flex h-12 w-12 items-center justify-center rounded-full border backdrop-blur-xl cursor-pointer"
        style={{ borderColor: `${glow}66`, boxShadow: `0 0 24px ${glow}55, inset 0 0 12px ${glow}33`, background: "#05050ccc" }}
      >
        <span
          className="block h-3.5 w-3.5 rounded-full"
          style={{ backgroundColor: glow, boxShadow: `0 0 14px ${glow}` }}
        />
      </motion.button>
    </div>
  );
}
