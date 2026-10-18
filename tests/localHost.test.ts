/**
 * Loopback name checks (shared/localHost.ts).
 *
 * These predicates are the only thing between a web page and ABxAG's memory,
 * screen and desktop: the API middleware and the live WebSocket upgrade both
 * refuse anything that is not this machine. They now accept the friendly
 * `abxag` name and the `abxag.local` alias, which widens the allowlist — so the
 * tests below are as much about what must still be refused as about what must
 * work.
 *
 * A short, dot-less name is worth being careful with: `abxag` is only two
 * characters away from other text, and a substring or suffix match would let an
 * attacker-controlled domain in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_HOSTNAME,
  LOCAL_HOSTNAME_ALIAS,
  LOCAL_HOSTNAMES,
  LOCAL_PORT,
  hostnameFromHostHeader,
  isLocalHostHeader,
  isLocalOrigin,
  localBaseUrl,
} from "../shared/localHost";

test("the local domain is abxag on 369 and says so in one place", () => {
  assert.equal(LOCAL_HOSTNAME, "abxag");
  assert.equal(LOCAL_PORT, 369);
  assert.ok(LOCAL_HOSTNAMES.includes(LOCAL_HOSTNAME));
  assert.ok(LOCAL_HOSTNAMES.includes(LOCAL_HOSTNAME_ALIAS), "the earlier alias still resolves");
  assert.ok(LOCAL_HOSTNAMES.includes("localhost"));
  assert.ok(LOCAL_HOSTNAMES.includes("127.0.0.1"));
  assert.equal(localBaseUrl(), "http://abxag:369", "the address a human types, with no argument");
  assert.equal(localBaseUrl(47130), "http://abxag:47130", "and follows a chosen port");
});

test("a Host header is accepted with or without a port, in any case", () => {
  for (const host of [
    "abxag",
    "abxag:369",
    "ABxAG:369",
    "abxag.local",
    "abxag.local:369",
    "localhost",
    "localhost:3000",
    "127.0.0.1:369",
    "[::1]:369",
  ]) {
    assert.equal(isLocalHostHeader(host), true, host);
  }
});

test("a lookalike hostname is refused - matching is exact, never a suffix", () => {
  for (const host of [
    "abxag.attacker.example",
    "notabxag",
    "abxag.example.com",
    "evil-abxag",
    "myabxag",
    "abxag.evil.example",
    "abxag.local.attacker.example",
    "example.com",
  ]) {
    assert.equal(isLocalHostHeader(host), false, host);
  }
});

test("a missing or malformed Host header is not local", () => {
  assert.equal(isLocalHostHeader(""), false);
  assert.equal(isLocalHostHeader(undefined), false);
  assert.equal(isLocalHostHeader(null), false);
  assert.equal(isLocalHostHeader("   "), false);
});

test("hostnameFromHostHeader strips the port and IPv6 brackets", () => {
  assert.equal(hostnameFromHostHeader("abxag:369"), "abxag");
  assert.equal(hostnameFromHostHeader("ABXAG"), "abxag");
  assert.equal(hostnameFromHostHeader("abxag.local:369"), "abxag.local");
  assert.equal(hostnameFromHostHeader("[::1]:369"), "::1");
  assert.equal(hostnameFromHostHeader("localhost"), "localhost");
  assert.equal(hostnameFromHostHeader(undefined), "");
});

test("an Origin is accepted for our names and refused for everything else", () => {
  for (const origin of [
    "http://abxag:369",
    "http://abxag.local:369",
    "http://localhost:3000",
    "https://127.0.0.1",
    "http://[::1]:369",
  ]) {
    assert.equal(isLocalOrigin(origin), true, origin);
  }
  for (const origin of [
    "https://evil.example",
    "http://abxag.evil.example",
    "http://notabxag",
    "file:///C:/temp/page.html",
    "chrome-extension://abcdef",
    "not a url at all",
  ]) {
    assert.equal(isLocalOrigin(origin), false, origin);
  }
});

test("an absent Origin counts as local; the caller handles the opaque 'null'", () => {
  // A same-origin fetch from the app sends no Origin at all.
  assert.equal(isLocalOrigin(""), true);
  assert.equal(isLocalOrigin(undefined), true);
  // "null" is opaque (a sandboxed frame), which is why server.ts accepts it
  // explicitly rather than through this predicate.
  assert.equal(isLocalOrigin("null"), false);
});