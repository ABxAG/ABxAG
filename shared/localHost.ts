/**
 * The machine-local names ABxAG answers to.
 *
 * `abxag.local` is the friendly alias for the loopback server: it is the name
 * in the address bar, in browser tabs and in anything else that wants to point
 * at ABxAG without hard-coding a port-less IP. It has to be treated as a
 * loopback name everywhere the old `localhost` / `127.0.0.1` checks live, or
 * the server answers 403 to its own alias.
 *
 * Security note: these predicates gate the entire API and the live WebSocket,
 * because they are what stands between a web page and ABxAG's memory, screen
 * and desktop. They therefore match whole hostnames only - a substring or
 * suffix match would let `abxag.local.attacker.example` through, and
 * `.local` being an mDNS name makes suffix tricks easy to write by accident.
 */

/** The friendly name, without scheme or port. */
export const LOCAL_HOSTNAME = "abxag.local";

/** Every hostname that identifies this machine's loopback interface. */
export const LOCAL_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]", "::1", LOCAL_HOSTNAME];

/**
 * Split a `Host` header into its hostname, lower-cased and without brackets
 * around an IPv6 literal. A missing or unparseable value yields "".
 */
export function hostnameFromHostHeader(value: string | undefined | null): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  // A Host header may carry a port, and an IPv6 literal wraps itself in
  // brackets (`[::1]:47130`). The port has to come off first, otherwise the
  // bracket stripper has to guess where the host ends.
  return raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
}

/**
 * Whether a `Host` header points at this machine. Compares against the full
 * list, never a suffix, so a lookalike domain cannot pass.
 */
export function isLocalHostHeader(value: string | undefined | null): boolean {
  const hostname = hostnameFromHostHeader(value);
  return hostname !== "" && LOCAL_HOSTNAMES.includes(hostname);
}

/**
 * Whether an `Origin` header (or a bare origin string) is one of ours.
 * `null` is accepted by the caller, not here: it is an opaque origin from a
 * sandboxed frame, not evidence of locality.
 */
export function isLocalOrigin(value: string | undefined | null): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return true; // absent Origin: not a cross-origin request
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOCAL_HOSTNAMES.includes(hostnameFromHostHeader(url.host));
}

/** The base URL a client should use, for messages and diagnostics. */
export function localBaseUrl(port: number): string {
  return `http://${LOCAL_HOSTNAME}:${port}`;
}