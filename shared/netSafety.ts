/**
 * Outbound URL safety. Server-side fetches (web.fetch, downloads, the legacy
 * proxy) may only reach public http(s) hosts: no loopback, private ranges,
 * link-local/metadata addresses or URLs carrying credentials.
 */
import dns from "node:dns/promises";
import net from "node:net";

export async function assertSafeExternalUrl(value: string): Promise<URL> {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (parsed.username || parsed.password) throw new Error("URLs with embedded credentials are not allowed.");
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Local network addresses are not allowed.");
  }
  const addresses = net.isIP(hostname)
    ? [hostname]
    : (await dns.lookup(hostname, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("Private, loopback, or link-local destinations are not allowed.");
  }
  return parsed;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped || (net.isIP(normalized) === 4 ? normalized : null);
  if (!ipv4) return false;
  const [a, b] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

/** Follow redirects manually so every hop is re-validated. */
export async function safeFetch(url: string, init: RequestInit & { maxRedirects?: number } = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= (init.maxRedirects ?? 5); hop += 1) {
    await assertSafeExternalUrl(current);
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      current = new URL(response.headers.get("location")!, current).toString();
      await response.body?.cancel().catch(() => {});
      continue;
    }
    Object.defineProperty(response, "finalUrl", { value: current });
    return response;
  }
  throw new Error("Too many redirects.");
}
