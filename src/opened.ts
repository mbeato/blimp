// Folders you opened as projects from the phone's folder browser, so one stays in the recent folders before Claude
// has run there. <socket dir>/opened.json: { "dirs": [{ "dir": "/Users/me/new-app", "at": 1729850000000 }] },
// newest first, at most 30. Opening a hidden one shows it again (server.ts).

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "./sessions";

export type Opened = { dir: string; at: number };

export const openedFile = () => join(blimpDir(), "opened.json");

// Missing or unreadable: none. Entries that aren't a folder and a time are dropped.
export function readOpened(file = openedFile()): Opened[] {
  try {
    const dirs = JSON.parse(readFileSync(file, "utf8"))?.dirs;
    if (Array.isArray(dirs))
      return dirs
        .filter((d) => typeof d?.dir === "string" && d.dir !== "" && typeof d.at === "number")
        .map((d) => ({ dir: d.dir, at: d.at }));
  } catch {}
  return [];
}

// Records dir as opened at `at`, first in the list (once); returns the list now.
export function addOpened(dir: string, at = Date.now(), file = openedFile()): Opened[] {
  const dirs = [{ dir, at }, ...readOpened(file).filter((d) => d.dir !== dir)].slice(0, 30);
  writeFileSync(file + ".tmp", JSON.stringify({ dirs }), { mode: 0o600 });
  // mode only applies to a new file: a .tmp left from before keeps its own.
  chmodSync(file + ".tmp", 0o600);
  renameSync(file + ".tmp", file);
  return dirs;
}
