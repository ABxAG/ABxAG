/**
 * Typed access to the Electron self-updater bridge (`window.abxag.updates`,
 * exposed by electron/preload.cjs) with a graceful web fallback.
 *
 * Inside Electron every action runs in the main process (GitHub Releases
 * check, background download, installer launch). In a plain browser tab
 * (`npm run dev`) only read-only info is available: the version list is
 * fetched straight from the GitHub API and installs degrade to external
 * download links.
 */

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateRelease {
  version: string;
  name: string;
  notes: string;
  publishedAt: string | null;
  prerelease: boolean;
  setupAsset: UpdateAsset | null;
  portableAsset: UpdateAsset | null;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "update-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  releases: UpdateRelease[];
  latestNewer: string | null;
  progress: number;
  downloadedVersion: string | null;
  downloadedFile: string | null;
  error: string | null;
  lastCheckedAt: string | null;
  /** False for dev runs and the portable exe (silent /S needs the installed build). */
  canSilentInstall?: boolean;
}

export interface UpdatesBridge {
  getState: () => Promise<UpdateState>;
  check: () => Promise<UpdateState>;
  download: (version: string) => Promise<UpdateState>;
  /** silent=true runs the NSIS installer with /S (no wizard clicks). */
  install: (silent?: boolean) => Promise<UpdateState>;
  setAuto: (enabled: boolean) => Promise<UpdateState>;
  openUrl: (url: string) => Promise<boolean>;
  onEvent: (callback: (state: UpdateState) => void) => () => void;
}

function getBridge(): UpdatesBridge | null {
  try {
    const w = window as unknown as { abxag?: { updates?: UpdatesBridge } };
    return w.abxag?.updates ?? null;
  } catch {
    return null;
  }
}

export function isDesktopWithUpdates(): boolean {
  return getBridge() !== null;
}

export function useUpdatesBridge(): UpdatesBridge | null {
  return getBridge();
}

/** Web fallback: read-only release list. Tries the GitHub API first, then our
 *  own mirrored feed (api.github.com is unreachable from some networks). */
export async function fetchReleasesWeb(): Promise<UpdateRelease[]> {
  const errors: string[] = [];
  for (const url of [
    "https://api.github.com/ABxAG/ABxAG/releases?per_page=20",
    "https://abxag.absup.dev/releases.json",
  ]) {
    try {
      const res = await fetch(url, {
        headers: url.includes("api.github.com") ? { Accept: "application/vnd.github+json" } : undefined,
      });
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      return parseWebReleases(await res.json());
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error(errors.join(" · ") || "Could not load releases.");
}

function parseWebReleases(json: unknown): UpdateRelease[] {
  return ((Array.isArray(json) ? json : []) as Array<any>)
    .filter((r) => !r.draft)
    .map((r) => {
      const assets = Array.isArray(r.assets) ? r.assets : [];
      const setup = assets.find((a: any) => /-Setup-.*\.exe$/i.test(a.name || ""));
      const portable = assets.find((a: any) => /-Portable-.*\.exe$/i.test(a.name || ""));
      return {
        version: String(r.tag_name || "").replace(/^[vV]/, ""),
        name: String(r.name || r.tag_name || ""),
        notes: String(r.body || "").slice(0, 4000),
        publishedAt: r.published_at || null,
        prerelease: Boolean(r.prerelease),
        setupAsset: setup ? { name: setup.name, url: setup.browser_download_url, size: setup.size || 0 } : null,
        portableAsset: portable ? { name: portable.name, url: portable.browser_download_url, size: portable.size || 0 } : null,
      } as UpdateRelease;
    });
}

export const ABOUT_LINKS = {
  website: "https://abxag.absup.dev",
  mirror: "https://abxag.pages.dev",
  source: "https://github.com/ABxAG/ABxAG",
  releases: "https://github.com/ABxAG/ABxAG/releases",
} as const;
