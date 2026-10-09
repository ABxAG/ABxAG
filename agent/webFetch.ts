/**
 * Structured, read-only web page fetch for research without driving the UI.
 * The returned text is untrusted content: it is shown to the planner inside
 * an untrusted block and can never authorize an action.
 */
import { safeFetch } from "../shared/netSafety";

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title: string;
  headings: string[];
  text: string;
  links: Array<{ text: string; href: string }>;
  downloadLinks: Array<{ text: string; href: string }>;
}

const DOWNLOAD_EXT = /\.(exe|msi|msix|zip|7z|dmg|pkg|tar\.(gz|xz)|deb|rpm|appimage|pdf|iso)(\?|#|$)/i;

export async function fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage> {
  const response = await safeFetch(url, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const type = response.headers.get("content-type") || "";
  if (!/html|text/i.test(type)) throw new Error(`Not a web page (${type || "unknown type"}).`);
  const html = (await response.text()).slice(0, 2_000_000);
  const finalUrl = (response as Response & { finalUrl?: string }).finalUrl || url;
  return parseHtml(html, finalUrl, url);
}

export function parseHtml(html: string, finalUrl: string, requestedUrl = finalUrl): FetchedPage {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const title = decode(stripped.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim().slice(0, 200);
  const headings = [...stripped.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((match) => clean(match[2])).filter((text) => text.length > 2 && text.length < 160).slice(0, 25);
  const links: FetchedPage["links"] = [];
  for (const match of stripped.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = clean(match[2]).slice(0, 120);
    let href: string;
    try {
      href = new URL(decode(match[1]), finalUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(href)) continue;
    links.push({ text, href });
    if (links.length >= 400) break;
  }
  const body = clean(stripped.replace(/<(br|p|div|li|tr|h\d)\b[^>]*>/gi, "\n$&"))
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 12_000);
  return {
    url: requestedUrl,
    finalUrl,
    title,
    headings,
    text: body,
    links: dedupe(links).slice(0, 80),
    downloadLinks: dedupe(links.filter((link) => DOWNLOAD_EXT.test(link.href) || /download/i.test(link.text))).slice(0, 30),
  };
}

function clean(value: string): string {
  return decode(value.replace(/<[^>]+>/g, " ")).replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").trim();
}

function decode(value: string): string {
  return value
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function dedupe<T extends { href: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.href) ? false : (seen.add(item.href), true)));
}
