// blimp's own names for Claude sessions (docs/DESIGN.md, "Names"). Claude writes its ai-title once,
// from the first message, so a title says how a session started. Now and then a small, fast Claude
// model (haiku, on your own Claude sign-in) reads a session and names it in 2 to 4 words, and names it
// again as the work moves on. Names live in <socket dir>/names.json; `{"names": false}` in
// <socket dir>/config.json turns all of it off.

import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatMessage, type ChatScan, newScan, readAppended } from "./chat";
import { CLAUDE_KINDS } from "./kinds";
import { blimpDir, claudeDir, listSessionsLite, loginShell, type Session, transcriptPath, transcriptTitles, zmxListAsync } from "./sessions";

export type Name = { name: string; at: number; prompts: number }; // at: ms; prompts: user prompts then
export type Names = Record<string, Name>; // by Claude's sessionId

export const namesFile = () => join(blimpDir(), "names.json");
export const configFile = () => join(blimpDir(), "config.json");

function readJson(file: string): any {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// <socket dir>/config.json: blimpd's settings. Missing or not a JSON object: all defaults.
export const readConfig = (file = configFile()): { names?: unknown; assistant?: unknown } => readJson(file);
export const namesOn = (file = configFile()) => readConfig(file).names !== false;

// Changes some settings and keeps the rest: through a temp file and a rename, 600.
export function saveConfig(patch: Record<string, unknown>, file = configFile()) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify({ ...readJson(file), ...patch }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function readNames(file = namesFile()): Names {
  const out: Names = {};
  for (const [id, n] of Object.entries(readJson(file)))
    if (typeof (n as any)?.name === "string" && typeof (n as any).at === "number") out[id] = n as Name;
  return out;
}

// The names the session list and the Earlier lists show: none while names are off.
export const shownNames = (): Names => (namesOn() ? readNames() : {});

const KEEP = 500;

// Through a temp file and a rename, so it's never half written; 600; only the 500 newest kept.
export function saveName(id: string, n: Name, file = namesFile()) {
  const all = readNames(file);
  all[id] = n;
  const keep = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, KEEP);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// What a transcript has said so far, kept up to date as it grows (chat.ts reads it).
export type Summary = { scan: ChatScan; prompts: number; replies: number; first?: string; last: string[]; reply?: string; replyId?: string };
export const newSummary = (): Summary => ({ scan: newScan(""), prompts: 0, replies: 0, last: [] });

export function addMessage(s: Summary, m: ChatMessage) {
  if (m.role === "user") {
    s.prompts++;
    s.first ??= m.text;
    s.last = [...s.last, m.text].slice(-3);
  } else if (m.role === "assistant") {
    s.replies++;
    s.reply = m.text;
    s.replyId = m.id;
  }
}

// Read in chunks with a turn of the event loop between them, like chat.ts readLast. each sees every new message
// before it's added.
export async function follow(file: string, s: Summary, each?: (m: ChatMessage) => void) {
  for (;;) {
    if (statSync(file).size < s.scan.offset) Object.assign(s, newSummary()); // rewritten shorter
    const from = s.scan.offset;
    for (const m of readAppended(file, s.scan, 4 << 20)) {
      each?.(m);
      addMessage(s, m);
    }
    if (s.scan.offset === from) return;
    await Bun.sleep(0);
  }
}

const MIN = 60_000;

// Whether to ask for a name now. Only a Claude session that has had a prompt and a reply and isn't
// mid-turn, and not one you named yourself (/rename wins anyway). A first name at once; a new one
// after 3 more prompts and 20 minutes. A session whose last try failed waits 10 minutes.
export function wantsName(
  s: Pick<Session, "kind" | "state">,
  sum: { prompts: number; replies: number },
  had: Name | undefined,
  now: number,
  opts: { custom?: string; failedAt?: number } = {},
): boolean {
  if (!CLAUDE_KINDS.includes(s.kind) || (s.state !== "done" && s.state !== "waiting")) return false;
  if (opts.custom || sum.prompts < 1 || sum.replies < 1) return false;
  if (opts.failedAt !== undefined && now - opts.failedAt < 10 * MIN) return false;
  if (!had) return true;
  return sum.prompts - had.prompts >= 3 && now - had.at >= 20 * MIN;
}

export const clip = (s: string, n = 300) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, /[\ud800-\udbff]/.test(t[n - 1]) ? n - 1 : n) + "…" : t;
};

// What the model reads: each piece cut to ~300 characters, no tool calls or output.
export function namingPrompt(p: { title?: string; first?: string; last: string[]; reply?: string; prompts: number }): string {
  const lines = [
    "Name this Claude Code session in 2 to 4 words, in Title Case, saying what it is working on now.",
    "Answer with the name only: no quotes, no trailing punctuation, nothing else.",
    "",
  ];
  if (p.title) lines.push(`Its title so far: ${clip(p.title)}`);
  // With 3 prompts or fewer, the first is one of the latest.
  if (p.first && p.prompts > p.last.length) lines.push(`First request: ${clip(p.first)}`);
  if (p.last.length) lines.push("Latest requests, oldest first:", ...p.last.map((t) => `- ${clip(t)}`));
  if (p.reply) lines.push(`Claude's latest reply: ${clip(p.reply)}`);
  return lines.join("\n") + "\n";
}

// The model's answer as a name, or undefined if it isn't one: one line, 1 to 6 words, at most 40
// characters once quotes and trailing punctuation are off. It's shown as plain text.
export function checkName(out: string): string | undefined {
  const t = out.trim();
  if (!t || t.includes("\n")) return;
  const name = t
    .replace(/^["'`“”‘’*_]+|["'`“”‘’*_]+$/g, "")
    .replace(/[.,;:!?…]+$/, "")
    .replace(/^["'`“”‘’*_]+|["'`“”‘’*_]+$/g, "")
    .trim();
  if (!name || name.length > 40 || /[\x00-\x1f\x7f]/.test(name)) return;
  const words = name.split(/\s+/).length;
  return words >= 1 && words <= 6 ? name : undefined;
}

// The model's arguments. The conversation goes on stdin, never here: `ps` shows arguments to anyone.
// No tools (an instruction in the conversation can't run anything), no MCPs, no hooks, nothing saved.
export const NAMING_ARGS = [
  "claude",
  "-p",
  "--model",
  "haiku",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--tools",
  "",
  "--max-turns",
  "1",
  "--settings",
  '{"disableAllHooks":true}',
];
const MARK = "blimp-name:\n"; // a login profile may print things first; only what follows is Claude's

// Runs the model through the login shell (as sessions run claude, so PATH finds it) in an empty
// private folder (no CLAUDE.md), without blimpd's CLAUDE* variables, which change how Claude
// behaves. Killed after 60 s. Its answer, or undefined.
export async function askClaude(prompt: string, timeout = 60_000): Promise<string | undefined> {
  const cwd = mkdtempSync(join(tmpdir(), "blimp-name-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && k !== "ZMX_SESSION"));
  try {
    const p = Bun.spawn([loginShell(), "-l", "-i", "-c", 'echo blimp-name:; exec claude "$@"', ...NAMING_ARGS], {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeout);
    try {
      p.stdin.write(prompt);
      await p.stdin.end();
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) return;
      const i = out.indexOf(MARK);
      return i < 0 ? undefined : out.slice(i + MARK.length);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// The naming loop: every 5 s, at most one call at a time and 30 an hour.
const summaries = new Map<string, Summary>(); // by transcript file
const failed = new Map<string, number>(); // sessionId -> when its last try failed
const calls: number[] = [];
let busy = false;

export async function nameTick(ask = askClaude, now = Date.now): Promise<void> {
  if (busy || !namesOn()) return;
  busy = true;
  try {
    const dir = claudeDir();
    const sessions = listSessionsLite(dir, await zmxListAsync());
    const names = readNames();
    const live = new Set<string>();
    for (const s of sessions) {
      if (!s.sessionId || !CLAUDE_KINDS.includes(s.kind)) continue;
      const file = transcriptPath(dir, s.sessionId);
      if (!file) continue;
      live.add(file);
      let sum = summaries.get(file);
      if (!sum) summaries.set(file, (sum = newSummary()));
      try {
        await follow(file, sum);
      } catch {
        continue;
      }
      const titles = transcriptTitles(file);
      if (!wantsName(s, sum, names[s.sessionId], now(), { custom: titles?.custom, failedAt: failed.get(s.sessionId) })) continue;
      const t = now();
      while (calls.length && t - calls[0] >= 60 * MIN) calls.shift();
      if (calls.length >= 30) return;
      calls.push(t);
      const prompts = sum.prompts;
      const name = checkName((await ask(namingPrompt({ title: titles?.custom ?? titles?.ai, ...sum }))) ?? "");
      if (name) {
        saveName(s.sessionId, { name, at: now(), prompts });
        failed.delete(s.sessionId);
      } else failed.set(s.sessionId, now());
      return; // one call per tick
    }
    for (const f of summaries.keys()) if (!live.has(f)) summaries.delete(f);
  } catch {
  } finally {
    busy = false;
  }
}

export function startNaming(every = 5000) {
  setInterval(() => void nameTick(), every);
}
