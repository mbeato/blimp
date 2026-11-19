// Whose account a Claude reply was on (docs/superpowers/specs/2026-11-19-usage-design.md, "Counting",
// Whose account). A transcript doesn't say, so blimp's own accounts log does: the account in use at
// the reply's time. An `unknown` line means nobody until the next line that names one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountsDir } from "../accounts/store";

export type Timeline = { at: number; id: string }[]; // oldest first; id "" means nobody

// log.1.jsonl holds the older lines (switcher.ts accountsLog). Undefined: neither file is there.
export function readTimeline(accounts = accountsDir()): Timeline | undefined {
  const t: Timeline = [];
  let found = false;
  for (const name of ["log.1.jsonl", "log.jsonl"]) {
    let text: string;
    try {
      text = readFileSync(join(accounts, name), "utf8");
    } catch {
      continue;
    }
    found = true;
    for (const line of text.split("\n")) {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof j?.at !== "number") continue;
      const id = j.event === "switch" ? j.to : ["login", "adopted", "renewal"].includes(j.event) ? j.account : j.event === "unknown" ? "" : undefined;
      if (typeof id === "string") t.push({ at: j.at, id });
    }
  }
  if (!found) return;
  return t.sort((a, b) => a.at - b.at);
}

// "" before the first line. Binary search: a first scan asks this for each of 200,000 replies.
export function accountAt(t: Timeline, ms: number): string {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid].at <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo ? t[lo - 1].id : "";
}
