/**
 * Add the upcoming release to the fallback feed with its notes and assets.
 *
 * The website and the in-app updater read website/releases.json when
 * api.github.com is unreachable, so the entry must exist before the release is
 * published; the asset sizes are corrected afterwards by
 * scripts/sync-release-feed-assets.cjs.
 *
 *   node scripts/add-release-feed.cjs v1.1.22 "## ABxAG v1.1.22 ..."
 */
const fs = require("node:fs");

const [tag, notes] = process.argv.slice(2);
if (!tag || !notes) {
  console.error('usage: node scripts/add-release-feed.cjs v1.1.22 "## notes"');
  process.exit(1);
}

const path = "website/releases.json";
const feed = JSON.parse(fs.readFileSync(path, "utf8"));
const version = tag.replace(/^v/, "");

const assets = [
  `ABxAG-Setup-${version}.exe`,
  `ABxAG-Portable-${version}.exe`,
  `ABxAG-Setup-${version}.exe.blockmap`,
  "latest.yml",
].map((name) => ({
  name,
  size: 0, // filled in by sync-release-feed-assets.cjs after publishing
  url: `https://github.com/ABxAG/ABxAG/releases/download/${tag}/${name}`,
}));

const entry = {
  tag,
  date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  title: null,
  notes,
  assets,
};

const at = feed.findIndex((r) => r.tag === tag);
if (at >= 0) feed[at] = entry;
else feed.unshift(entry);

fs.writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
console.log(`${at >= 0 ? "updated" : "added"} ${tag}; feed top ${feed[0].tag}, ${feed.length} entries`);