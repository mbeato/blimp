// The status line step (docs/superpowers/specs/2026-11-19-usage-design.md, "Limits"). Claude Code hands
// its limit numbers only to the status line command, so `blimpd statusline` stands in front of the user's
// own: it saves the numbers, then runs the user's command with the same stdin and prints what that prints.
// Whatever goes wrong in blimp's part, the user's command still runs. `blimpd install-statusline` keeps
// the statusLine object that was in settings.json in <usage dir>/statusline.json, and uninstall puts it back.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { accountsDir, readState, write } from "../accounts/store";
import { shellQuote, writeSettings } from "../hooks";
import { claudeDir } from "../sessions";
import { usageDir } from "./db";
import type { Limits } from "./summary";

export const limitsDir = (usage = usageDir()) => join(usage, "limits");
const keptFile = (usage: string) => join(usage, "statusline.json");
const settingsFile = () => join(claudeDir(), "settings.json");

// Ours: any blimpd's status line (an older install, another path), or this exact command whatever the binary is called.
const isOurs = (s: any, command?: string) =>
  typeof s?.command === "string" && (s.command === command || s.command.includes("blimpd' statusline") || s.command.includes("blimpd statusline"));

function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mode only applies to a new folder
}

// By account id (the file name). A file that can't be read is skipped.
export function readLimits(usage = usageDir()): Record<string, Limits> {
  const out: Record<string, Limits> = {};
  let names: string[];
  try {
    names = readdirSync(limitsDir(usage)).filter((n) => n.endsWith(".json"));
  } catch {
    return out;
  }
  for (const name of names)
    try {
      const l = JSON.parse(readFileSync(join(limitsDir(usage), name), "utf8"));
      if (l && typeof l === "object" && !Array.isArray(l) && typeof l.at === "number") out[name.slice(0, -5)] = l;
    } catch {}
  return out;
}

// input: what Claude Code gives the status line. Returns whether it saved.
export function saveLimits(input: unknown, o: { usage?: string; accounts?: string; now?: number } = {}): boolean {
  const r = (input as any)?.rate_limits;
  if (!r || typeof r !== "object") return false;
  const win = (w: any) => (typeof w?.used_percentage === "number" && typeof w?.resets_at === "number" ? { used: w.used_percentage, resetsAt: w.resets_at * 1000 } : undefined);
  const fiveHour = win(r.five_hour);
  const sevenDay = win(r.seven_day);
  if (!fiveHour && !sevenDay) return false;
  const state = readState(o.accounts ?? accountsDir());
  // After a swap, a session that hasn't replied since still carries the old account's numbers.
  const transcript = (input as any).transcript_path;
  if (typeof state.switchedAt === "number" && typeof transcript === "string") {
    let written = -Infinity;
    try {
      written = statSync(transcript).mtimeMs;
    } catch {}
    if (written < state.switchedAt) return false;
  }
  // Logins are saved but blimp can't tell which is in place: the numbers are nobody's.
  if (!state.active && state.order.length) return false;
  // No accounts state (switching never on, or a Mac): "one", which GET /usage/now names from .claude.json.
  const usage = o.usage ?? usageDir();
  privateDir(usage);
  privateDir(limitsDir(usage));
  write(join(limitsDir(usage), `${state.active ?? "one"}.json`), JSON.stringify({ at: o.now ?? Date.now(), ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }) }));
  return true;
}

// false: already in place. Unreadable JSON throws, as installHooks does: better to stop than overwrite someone's settings.
export function installStatusline(blimpdPath: string, settingsPath = settingsFile(), usage = usageDir()): boolean {
  const exists = existsSync(settingsPath);
  const settings = exists ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  const command = `${shellQuote(blimpdPath)} statusline`;
  if (isOurs(settings.statusLine, command)) return false;
  const old = settings.statusLine ?? null;
  privateDir(usage);
  write(keptFile(usage), JSON.stringify({ statusLine: old }));
  // Other keys of the user's (padding) stay.
  settings.statusLine = { ...(old ?? {}), type: "command", command };
  const backup = settingsPath + ".blimp-backup";
  if (exists && !existsSync(backup)) copyFileSync(settingsPath, backup);
  writeSettings(settingsPath, settings);
  return true;
}

// false: blimp's wasn't in place. The kept object goes back, or statusLine goes when there was none.
export function uninstallStatusline(settingsPath = settingsFile(), usage = usageDir()): boolean {
  if (!existsSync(settingsPath)) return false;
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (!isOurs(settings.statusLine)) return false;
  let kept: unknown = null;
  try {
    kept = JSON.parse(readFileSync(keptFile(usage), "utf8"))?.statusLine ?? null;
  } catch {}
  if (kept) settings.statusLine = kept;
  else delete settings.statusLine;
  writeSettings(settingsPath, settings);
  rmSync(keptFile(usage), { force: true });
  return true;
}

export function statuslineInstalled(settingsPath = settingsFile()): boolean {
  try {
    return isOurs(JSON.parse(readFileSync(settingsPath, "utf8"))?.statusLine);
  } catch {
    return false;
  }
}

// What Claude Code runs as its status line. Returns the user's command's exit code, or 0 with none.
export async function runStatusline(): Promise<number> {
  const text = await Bun.stdin.text();
  try {
    saveLimits(JSON.parse(text));
  } catch {}
  let command: unknown;
  try {
    command = JSON.parse(readFileSync(keptFile(usageDir()), "utf8"))?.statusLine?.command;
  } catch {}
  // Never ours: it would run itself for ever.
  if (typeof command !== "string" || !command || isOurs({ command })) return 0;
  return await Bun.spawn(["sh", "-c", command], { stdin: new Blob([text]), stdout: "inherit", stderr: "inherit" }).exited;
}
