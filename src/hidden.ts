// Projects you hid from the phone's project strip, so also from the recent folders the Mac offers: their
// folders, as the apps name them. <socket dir>/hidden.json: { "dirs": ["/Users/me/scratch"] }. Starting a
// session in one shows it again (server.ts).

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "./sessions";

export const hiddenFile = () => join(blimpDir(), "hidden.json");

// Missing or unreadable: nothing is hidden.
export function readHidden(file = hiddenFile()): string[] {
  try {
    const dirs = JSON.parse(readFileSync(file, "utf8"))?.dirs;
    if (Array.isArray(dirs)) return dirs.filter((d): d is string => typeof d === "string" && d !== "");
  } catch {}
  return [];
}

// Hides dir, or shows it again; returns the folders hidden now.
export function setHidden(dir: string, hidden: boolean, file = hiddenFile()): string[] {
  const now = readHidden(file);
  const dirs = hidden ? (now.includes(dir) ? now : [...now, dir]) : now.filter((d) => d !== dir);
  if (dirs.length !== now.length) {
    writeFileSync(file + ".tmp", JSON.stringify({ dirs }), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
  return dirs;
}
