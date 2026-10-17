/**
 * Check that the fallback release feed agrees with the real GitHub release.
 *
 * The website and the in-app updater both read website/releases.json when
 * api.github.com is blocked, so a stale entry (wrong size, missing version)
 * there is what the user actually sees. Run after publishing a release.
 */
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const feed = JSON.parse(fs.readFileSync("website/releases.json", "utf8"));
const tag = process.argv[2];
if (!tag) {
  console.error("usage: node scripts/check-release-feed.cjs v1.1.21");
  process.exit(1);
}

let release = null;
try {
  const raw = execFileSync("gh", ["api", `repos/ABxAG/ABxAG/releases/tags/${tag}`], { encoding: "utf8" });
  release = JSON.parse(raw);
} catch {
  console.error(`no GitHub release for ${tag} - publish it first`);
  process.exit(1);
}

const entry = feed.find((r) => r.tag === tag);
if (!entry) {
  console.error(`FAIL: ${tag} is missing from the feed (feed top is ${feed[0].tag})`);
  process.exit(1);
}

let bad = 0;
console.log(`feed top: ${feed[0].tag} | entries: ${feed.length}`);

const real = new Map(release.assets.map((a) => [a.name, a.size]));
const listed = new Map((entry.assets || []).map((a) => [a.name, a.size]));
console.log(`\n${tag} assets:`);

for (const [name, size] of real) {
  const have = listed.get(name);
  if (have === undefined) {
    console.log(`  MISSING from feed: ${name}`);
    bad++;
  } else if (have !== size) {
    console.log(`  WRONG size: ${name} feed=${have} github=${size} (delta ${size - have})`);
    bad++;
  } else {
    console.log(`  ok: ${name} (${size} bytes)`);
  }
}
for (const name of listed.keys()) {
  if (!real.has(name)) {
    console.log(`  STALE in feed: ${name}`);
    bad++;
  }
}

if (!entry.notes || entry.notes.trim().length < 40) {
  console.log("  notes are missing or too short to render");
  bad++;
}

console.log(bad === 0 ? `\nPASS - feed matches ${tag}` : `\nFAIL - ${bad} mismatch(es)`);
process.exit(bad === 0 ? 0 : 1);