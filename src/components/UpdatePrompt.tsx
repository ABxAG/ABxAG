/**
 * Post-update reminder popup ("ছোট পপআপ").
 *
 * Whenever a NEWER version exists and the user hasn't been reminded about it
 * TODAY, a small card appears shortly after entering the app:
 *
 *   - [Update now] → downloads (or installs, if already downloaded)
 *   - [Later] → hides until tomorrow (tracked per version per day)
 *   - [x] same as Later
 *   - Auto-update switch → persists settings.updates.mode
 *
 * Two separate notices exist per version: "available" (a new version was
 * found) and "downloaded" (its installer finished downloading). Dismissing
 * the first does NOT suppress the second — so a background download that
 * finishes later still announces itself with an Install button.
 *
 * In auto mode a ready download installs itself after a short visible
 * countdown (cancellable via Later/Install now). Desktop (Electron) only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowUpCircle, Download, Loader2, X, Check } from "lucide-react";
import type { AppSettings, AppSettingsPatch } from "../lib/appApi";
import { isDesktopWithUpdates, useUpdatesBridge, type UpdateState } from "../lib/updatesBridge";

const AUTO_INSTALL_COUNTDOWN_SEC = 20;

function todayLocal(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

type NoticeKind = "available" | "downloaded";

function noticeOf(state: UpdateState): { kind: NoticeKind; version: string } | null {
  if (state.status === "downloaded" && state.downloadedVersion) {
    return { kind: "downloaded", version: state.downloadedVersion };
  }
  if ((state.status === "update-available" || state.status === "downloading") && state.latestNewer) {
    return { kind: "available", version: state.latestNewer };
  }
  return null;
}

export function UpdatePrompt({ app, onPatch }: { app: AppSettings | null; onPatch: (patch: AppSettingsPatch) => void }) {
  const bridge = useUpdatesBridge();
  const desktop = isDesktopWithUpdates();
  const [state, setState] = useState<UpdateState | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const installingRef = useRef(false);

  // Keep the main-process auto timer in sync from app entry (covers manual
  // mode immediately, not only when About is opened).
  useEffect(() => {
    if (!bridge || !app) return;
    void bridge.setAuto(app.updates.mode === "auto").catch(() => undefined);
  }, [bridge, app?.updates.mode]);

  useEffect(() => {
    if (!bridge) return;
    let off: (() => void) | undefined;
    void bridge.getState().then(setState).catch(() => undefined);
    off = bridge.onEvent(setState);
    return () => off?.();
  }, [bridge]);

  // Decide visibility whenever state or persisted prompt tracking changes.
  useEffect(() => {
    if (!desktop || !bridge || !state || !app) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const notice = noticeOf(state);
    if (!notice) {
      setVisible(false);
      return;
    }
    const alreadyPromptedToday =
      app.updates.lastPromptVersion === notice.version &&
      app.updates.lastPromptDate === todayLocal() &&
      app.updates.lastPromptKind === notice.kind;
    if (alreadyPromptedToday) {
      setVisible(false);
      return;
    }
    // Small delay so the popup lands after entering the app, not on top of boot.
    timer.current = setTimeout(() => setVisible(true), 4000);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [
    desktop, bridge,
    state?.status, state?.latestNewer, state?.downloadedVersion,
    app?.updates.lastPromptVersion, app?.updates.lastPromptDate, app?.updates.lastPromptKind,
  ]);

  const markPrompted = useCallback((version: string, kind: NoticeKind) => {
    onPatch({ updates: { lastPromptVersion: version, lastPromptDate: todayLocal(), lastPromptKind: kind } });
  }, [onPatch]);

  const dismiss = useCallback(() => {
    const notice = state ? noticeOf(state) : null;
    if (notice) markPrompted(notice.version, notice.kind);
    installingRef.current = false;
    setCountdown(null);
    setVisible(false);
  }, [state, markPrompted]);

  const updateNow = useCallback(async () => {
    if (!bridge || !state || busy) return;
    const notice = noticeOf(state);
    if (!notice) return;
    setBusy(true);
    try {
      if (state.downloadedVersion === notice.version) {
        markPrompted(notice.version, notice.kind);
        installingRef.current = true;
        setState(await bridge.install(false));
      } else {
        setState(await bridge.download(notice.version));
      }
    } catch (e) {
      setState((s) => (s ? { ...s, status: "error", error: e instanceof Error ? e.message : String(e) } : s));
    } finally {
      setBusy(false);
    }
  }, [bridge, state, busy, markPrompted]);

  // Auto mode: a ready download installs itself after a visible countdown.
  // Silent (/S, no wizard) when the installed build allows it; portable/dev
  // builds never auto-install — the popup stays with an Install button.
  // Dismissing (Later/x) cancels it and records today's downloaded-notice.
  const auto = app?.updates.mode === "auto";
  const allowSilent = state?.canSilentInstall !== false;
  useEffect(() => {
    if (!(visible && auto && allowSilent && state?.status === "downloaded" && state.downloadedVersion && bridge)) {
      setCountdown(null);
      return;
    }
    if (installingRef.current) return;
    setCountdown(AUTO_INSTALL_COUNTDOWN_SEC);
    const iv = setInterval(() => {
      setCountdown((c) => {
        if (c === null) return null;
        if (c <= 1) {
          clearInterval(iv);
          if (!installingRef.current) {
            installingRef.current = true;
            const v = state.downloadedVersion as string;
            markPrompted(v, "downloaded");
            void bridge.install(true).then(setState).catch((e) => {
              installingRef.current = false;
              setState((s) => (s ? { ...s, status: "error", error: e instanceof Error ? e.message : String(e) } : s));
            });
          }
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [visible, auto, allowSilent, state?.status, state?.downloadedVersion, bridge, markPrompted]);

  if (!desktop || !state) return null;
  const notice = noticeOf(state);
  const version = notice?.version ?? null;
  const latest = version ? state.releases.find((r) => r.version === version) ?? null : null;

  return (
    <AnimatePresence>
      {visible && version && notice && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ type: "spring", damping: 26, stiffness: 300 }}
          role="dialog" aria-label="Update available"
          className="absolute bottom-5 right-5 z-50 w-80 rounded-2xl border border-cyan-400/25 bg-[#0a0c14]/95 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.65)] backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-300">
                <ArrowUpCircle size={19} />
              </span>
              <div>
                <div className="text-[13px] font-semibold text-white">Update available — v{version}</div>
                <div className="text-[11px] text-slate-400">
                  {state.status === "downloaded"
                    ? countdown !== null
                      ? `Auto-installing in ${countdown}s…`
                      : "Downloaded and ready to install."
                    : "A newer ABxAG is ready."}
                </div>
              </div>
            </div>
            <button type="button" onClick={dismiss} aria-label="Remind me tomorrow"
              className="rounded-lg p-1 text-slate-500 hover:bg-white/10 hover:text-white cursor-pointer">
              <X size={14} />
            </button>
          </div>

          {latest?.notes && (
            <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{latest.notes.split("\n")[0]}</p>
          )}

          {state.status === "downloading" && (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${Math.round(state.progress * 100)}%` }} />
            </div>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button type="button" onClick={updateNow} disabled={busy || state.status === "downloading"}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-cyan-500/25 px-3 py-2 text-[12px] font-semibold text-cyan-50 hover:bg-cyan-500/35 disabled:opacity-60 cursor-pointer">
              {busy || state.status === "downloading"
                ? <><Loader2 size={13} className="animate-spin" /> {Math.round(state.progress * 100)}%</>
                : state.downloadedVersion === version
                  ? <><Check size={13} /> Install now</>
                  : <><Download size={13} /> Update now</>}
            </button>
            <button type="button" onClick={dismiss}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-slate-300 hover:bg-white/10 cursor-pointer">
              Later
            </button>
          </div>

          <button type="button"
            onClick={() => onPatch({ updates: { mode: auto ? "manual" : "auto" } })}
            className="mt-2.5 flex w-full items-center justify-between rounded-lg px-1 py-1 text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer">
            <span>Auto-update {auto ? "is on" : "is off"}</span>
            <span role="switch" aria-checked={auto} aria-label="Auto-update"
              className={`relative h-4.5 w-8 rounded-full p-0.5 transition-colors ${auto ? "bg-cyan-500" : "bg-white/15"}`}>
              <span className={`block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${auto ? "translate-x-3.5" : "translate-x-0"}`} />
            </span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
