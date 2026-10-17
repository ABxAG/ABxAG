/**
 * Fill the fallback release feed's asset sizes from the real GitHub release.
 *
 * The download page and the updater's GitHub-free path both read
 * website/releases.json; a size of 0 there shows the user a bogus "0 B"
 * download. Run after publishing a release.
 *
 *   node scripts/sync-release-feed-assets.cjs v1.1.21
 */
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const tag = process.argv[2];
if (!tag) {
  console.error("usage: node scripts/sync-release-feed-assets.cjs v1.1.21");
  process.exit(1);
}

const raw = execFileSync("gh", ["api", `repos/ABxAG/ABxAG/releases/tags/${tag}`], { encoding: "utf8" });
const release = JSON.parse(raw);
const real = new Map(release.assets.map((a) => [a.name, a.size]));

const path = "website/releases.json";
const feed = JSON.parse(fs.readFileSync(path, "utf8"));
const entry = feed.find((r) => r.tag === tag);
if (!entry) {
  console.error(`FAIL: ${tag} is missing from the feed (top is ${feed[0].tag})`);
  process.exit(1);
}

// Add anything published but absent, then correct every recorded size.
let changed = 0;
for (const asset of release.assets) {
  const known = (entry.assets || []).find((a) => a.name === asset.name);
  if (!known) {
    entry.assets = entry.assets || [];
    entry.assets.push({
      name: asset.name,
      size: asset.size,
      url: `https://github.com/ABxAG/ABxAG/releases/download/${tag}/${asset.name}`,
    });
    changed++;
    console.log(`added:   ${asset.name} (${asset.size})`);
  } else if (known.size !== asset.size) {
    console.log(`resized: ${asset.name} ${known.size} -> ${asset.size}`);
    known.size = asset.size;
    changed++;
  }
}

// Drop feed entries for assets that are no longer published.
const published = new Set(release.assets.map((a) => a.name));
const stale = (entry.assets || []).filter((a) => !published.has(a.name));
if (stale.length) {
  entry.assets = entry.assets.filter((a) => published.has(a.name));
  for (const s of stale) {
    console.log(`removed: ${s.name} (not on the release)`);
    changed++;
  }
}

if (!changed) {
  console.log(`feed already matches ${tag}`);
  process.exit(0);
}

fs.writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
console.log(`\n${changed} change(s) written; feed top ${feed[0].tag}, ${feed.length} entries`);