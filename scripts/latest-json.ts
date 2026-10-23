// latest.json for the Mac app's updater (tauri.conf.json > plugins.updater): the version, the
// signed update bundle's address on this release, and its signature. Apple chips only: an Intel Mac finds
// no update for it here (there's no "darwin-universal" either, which it would take), not one it can't run.
//   bun scripts/latest-json.ts <tag> <path to blimp.app.tar.gz.sig>
import { readFileSync } from "node:fs";

const [tag, sigPath] = process.argv.slice(2);
if (!tag || !sigPath || !/^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(tag)) {
  console.error("usage: bun scripts/latest-json.ts vX.Y.Z <blimp.app.tar.gz.sig>");
  process.exit(2);
}
const signature = readFileSync(sigPath, "utf8").trim();
const url = `https://github.com/mbeato/blimp/releases/download/${tag}/blimp.app.tar.gz`;
const platform = { signature, url };
console.log(
  JSON.stringify(
    {
      version: tag.slice(1),
      notes: `blimp ${tag}: https://github.com/mbeato/blimp/releases/tag/${tag}`,
      pub_date: new Date().toISOString(),
      platforms: { "darwin-aarch64": platform },
    },
    null,
    2,
  ),
);
