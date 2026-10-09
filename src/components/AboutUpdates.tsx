/**
 * About → identity links + self updater UI.
 *
 * Desktop (Electron): full flow through the main-process updater
 * (check / background download / install any version).
 * Browser (`npm run dev`): read-only — links + release list with external
 * download links, since only the installed app can replace itself.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Globe, RefreshCw, Download, History, ExternalLink, Check,
  AlertTriangle, Loader2, ChevronDown,
} from "lucide-react";
import type { AppSettings, AppSettingsPatch } from "../lib/appApi";
import {
  ABOUT_LINKS,
  fetchReleasesWeb,
  isDesktopWithUpdates,
  useUpdatesBridge,
  type UpdateRelease,
  type UpdateState,
} from "../lib/updatesBridge";

declare const __APP_VERSION__: string;

const IDLE_STATE: UpdateState = {
  status: "idle",
  currentVersion: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "",
  releases: [],
  latestNewer: null,
  progress: 0,
  downloadedVersion: null,
  downloadedFile: null,
  error: null,
  lastCheckedAt: null,
};

function LinkRow({ label, url, badge }: { label: string; url: string; badge?: string }) {
  const bridge = useUpdatesBridge();
  const open = () => {
    if (bridge) void bridge.openUrl(url);
    else window.open(url, "_blank", "noopener");
  };
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-xs text-slate-100">{label}</div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{url.replace(/^https?:\/\//, "")}</div>
      </div>
      <button type="button" onClick={open}
        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-white/10 cursor-pointer">
        {badge ? badge : <>Open <ExternalLink size={12} /></>}
      </button>
    </div>
  );
}

function StatusDot({ status }: { status: UpdateState["status"] }) {
  const color =
    status === "up-to-date" ? "bg-emerald-400"
    : status === "error" ? "bg-rose-400"
    : status === "checking" || status === "downloading" ? "bg-amber-300 animate-pulse"
    : status === "downloaded" || status === "update-available" ? "bg-cyan-300"
    : "bg-white/20";
  return <span className={`block h-2.5 w-2.5 rounded-full ${color}`} />;
}

function statusText(state: UpdateState): string {
  switch (state.status) {
    case "idle": return "Never checked in this session.";
    case "checking": return "Checking GitHub releases…";
    case "up-to-date": return state.lastCheckedAt ? `You're on the latest version (checked ${new Date(state.lastCheckedAt).toLocaleTimeString()}).` : "You're on the latest version.";
    case "update-available": return `v${state.latestNewer} is available.`;
    case "downloading": return `Downloading v${state.latestNewer ?? ""}… ${Math.round(state.progress * 100)}%`;
    case "downloaded": return `v${state.downloadedVersion} downloaded — ready to install. The app restarts.`;
    case "installing": return "Handing off to the installer…";
    case "error": return state.error ?? "Something went wrong.";
  }
}

export function AboutUpdates({ app, onPatch }: { app: AppSettings | null; onPatch: (patch: AppSettingsPatch) => void }) {
  const bridge = useUpdatesBridge();
  const desktop = isDesktopWithUpdates();
  const [state, setState] = useState<UpdateState>(IDLE_STATE);
  const [webReleases, setWebReleases] = useState<UpdateRelease[] | null>(null);
  const [webError, setWebError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Live state from the main process.
  useEffect(() => {
    if (!bridge) return;
    let off: (() => void) | undefined;
    void bridge.getState().then(setState).catch(() => undefined);
    off = bridge.onEvent(setState);
    return () => off?.();
  }, [bridge]);

  // Keep the main-process auto timer in sync with the persisted mode.
  useEffect(() => {
    if (!bridge || !app) return;
    void bridge.setAuto(app.updates.mode === "auto").catch(() => undefined);
  }, [bridge, app?.updates.mode]);

  // Web fallback: load the release list directly.
  useEffect(() => {
    if (desktop) return;
    let cancelled = false;
    fetchReleasesWeb()
      .then((r) => { if (!cancelled) setWebReleases(r); })
      .catch((e) => { if (!cancelled) setWebError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [desktop]);

  const run = useCallback(async (fn: () => Promise<UpdateState>) => {
    if (!bridge || busy) return;
    setBusy(true);
    try {
      setState(await fn());
    } catch (e) {
      setState((s) => ({ ...s, status: "error", error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [bridge, busy]);

  const mode = app?.updates.mode ?? "auto";
  const releases = desktop ? state.releases : (webReleases ?? []);
  const current = desktop ? state.currentVersion : (typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "");
  const latest = desktop ? state.releases.find((r) => r.version === state.latestNewer) ?? null : null;

  const installVersion = (version: string) => {
    if (!bridge) return;
    if (state.downloadedVersion === version) {
      void run(() => bridge.install());
    } else {
      setConfirmSwitch(null);
      void run(() => bridge.download(version));
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div>
          <h4 className="font-mono text-[10px] uppercase tracking-widest text-slate-400">ABxAG</h4>
        </div>
        <div className="divide-y divide-white/5 rounded-xl border border-white/10 bg-white/[0.03]">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="text-xs text-slate-100">Version</div>
            <span className="font-mono text-[11px] text-slate-300">{typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : current}</span>
          </div>
          <LinkRow label="Website" url={ABOUT_LINKS.website} />
          <LinkRow label="Mirror" url={ABOUT_LINKS.mirror} />
          <LinkRow label="Source code" url={ABOUT_LINKS.source} />
          <LinkRow label="All releases" url={ABOUT_LINKS.releases} />
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="text-xs text-slate-100">AI</div>
            <span className="text-[11px] text-slate-300">Google Gemini, with your own key</span>
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="text-xs text-slate-100">PC control</div>
            <span className="text-[11px] text-slate-300">Local desktop agent, permission-checked</span>
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <div>
          <h4 className="font-mono text-[10px] uppercase tracking-widest text-slate-400">Updates</h4>
          <p className="mt-0.5 text-[11px] text-slate-500">Auto downloads new versions in the background · Manual only checks when you ask.</p>
        </div>
        <div className="divide-y divide-white/5 rounded-xl border border-white/10 bg-white/[0.03]">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-xs text-slate-100">Update mode</div>
              <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{desktop ? "Applies to this installed app." : "Installs only work in the downloaded app — here it's read-only."}</div>
            </div>
            <div role="radiogroup" aria-label="Update mode" className="flex shrink-0 rounded-lg border border-white/10 bg-black/30 p-0.5">
              {(["auto", "manual"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={!app}
                  onClick={() => onPatch({ updates: { mode: m } })}
                  className={`rounded-md px-2.5 py-1 text-[11px] capitalize transition cursor-pointer disabled:opacity-50 ${mode === m ? "bg-cyan-500/20 text-cyan-100" : "text-slate-400 hover:text-white"}`}>
                  {m === "auto" ? "Auto" : "Manual"}
                </button>
              ))}
            </div>
          </div>

          {desktop ? (
            <>
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <StatusDot status={state.status} />
                  <div className="min-w-0 text-[11px] leading-snug text-slate-300">{statusText(state)}</div>
                </div>
                <button type="button" disabled={busy || state.status === "checking" || state.status === "downloading"}
                  onClick={() => run(() => bridge!.check())}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-white/10 disabled:opacity-50 cursor-pointer">
                  {state.status === "checking" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Check
                </button>
              </div>

              {state.status === "downloading" && (
                <div className="px-4 py-3">
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${Math.round(state.progress * 100)}%` }} />
                  </div>
                </div>
              )}

              {state.status === "error" && state.error && (
                <div className="flex items-start gap-2 px-4 py-3 text-[11px] text-rose-300">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>{state.error}</span>
                </div>
              )}

              {latest && state.status !== "downloaded" && (
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-100">v{latest.version} {latest.prerelease && <span className="ml-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-200">preview</span>}</div>
                    {latest.notes && <div className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{latest.notes.split("\n")[0]}</div>}
                  </div>
                  <button type="button" disabled={busy || !latest.setupAsset}
                    onClick={() => installVersion(latest.version)}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-cyan-500/20 px-3 py-1.5 text-[11px] font-medium text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-50 cursor-pointer">
                    <Download size={12} /> Update
                  </button>
                </div>
              )}

              {state.status === "downloaded" && state.downloadedVersion && (
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2 text-[11px] text-emerald-300">
                    <Check size={13} className="shrink-0" />
                    <span>v{state.downloadedVersion} ready — installing restarts the app.</span>
                  </div>
                  <button type="button" disabled={busy}
                    onClick={() => run(() => bridge!.install())}
                    className="shrink-0 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[11px] font-medium text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-50 cursor-pointer">
                    Install now
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="px-4 py-3 text-[11px] leading-relaxed text-slate-400">
              {webError ? `Could not load releases (${webError}).` : webReleases === null ? "Loading releases…" : "Open this panel in the installed app to update or switch versions."}
            </div>
          )}

          <div className="px-4 py-2">
            <button type="button" onClick={() => setShowAll((v) => !v)}
              className="flex w-full items-center justify-between py-1.5 text-[11px] text-slate-300 hover:text-white cursor-pointer">
              <span className="flex items-center gap-1.5"><History size={12} /> {desktop ? "Switch version (old or new)" : "All versions"}</span>
              <ChevronDown size={13} className={`transition-transform ${showAll ? "rotate-180" : ""}`} />
            </button>
            {showAll && (
              <div className="space-y-1.5 pb-2 pt-1">
                {releases.length === 0 && <div className="text-[11px] text-slate-500">No releases loaded yet — press Check first.</div>}
                {releases.map((r) => {
                  const isCurrent = r.version === current || `v${r.version}` === current;
                  const downloaded = desktop && state.downloadedVersion === r.version;
                  return (
                    <div key={r.version} className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-[11px] text-slate-200">
                          <span className="font-mono">v{r.version}</span>
                          {r.prerelease && <span className="rounded bg-amber-400/15 px-1.5 py-px text-[10px] text-amber-200">preview</span>}
                          {isCurrent && <span className="rounded bg-emerald-400/15 px-1.5 py-px text-[10px] text-emerald-200">current</span>}
                        </div>
                        {r.publishedAt && <div className="text-[10px] text-slate-500">{new Date(r.publishedAt).toLocaleDateString()}</div>}
                      </div>
                      {!isCurrent && desktop && r.setupAsset && (
                        confirmSwitch === r.version ? (
                          <span className="flex shrink-0 items-center gap-1.5">
                            <button type="button" onClick={() => installVersion(r.version)} disabled={busy}
                              className="rounded-md bg-amber-500/20 px-2.5 py-1 text-[11px] font-medium text-amber-100 hover:bg-amber-500/30 disabled:opacity-50 cursor-pointer">
                              {downloaded ? "Install" : "Confirm download"}
                            </button>
                            <button type="button" onClick={() => setConfirmSwitch(null)}
                              className="rounded-md px-2 py-1 text-[11px] text-slate-400 hover:text-white cursor-pointer">Cancel</button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setConfirmSwitch(r.version)}
                            className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/10 cursor-pointer">
                            Switch
                          </button>
                        )
                      )}
                      {!isCurrent && !desktop && r.setupAsset && (
                        <a href={r.setupAsset.url} target="_blank" rel="noopener"
                          className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-white/10">
                          Download <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                  );
                })}
                {desktop && <div className="text-[10px] leading-relaxed text-slate-500">Switching installs that version over this copy and restarts the app. Your characters, memories and settings are kept.</div>}
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[11px] leading-relaxed text-slate-400">
        <Globe size={13} className="mt-0.5 shrink-0" />
        <span>Homepage <span className="font-mono text-slate-300">abxag.absup.dev</span> · mirror <span className="font-mono text-slate-300">abxag.pages.dev</span> — same site, two addresses.</span>
      </div>
    </div>
  );
}
