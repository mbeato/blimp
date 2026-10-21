// Return cards ("where was I?"): when you come back to a Claude session after time away, the apps ask
// GET /sessions/<name>/recap and show what it's for, what's done and what's still open. A small, fast
// Claude model (haiku, on your own Claude sign-in, as for names) writes it from the conversation's
// requests and replies. One is kept per conversation until Claude replies again. Recaps live in
// <socket dir>/recaps.json; the names' switch (`{"names": false}` in config.json) turns them off too.

import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChatMessage, type ChatScan, newScan, readAppended } from "./chat";
import { HttpError } from "./files";
import { CLAUDE_KINDS } from "./kinds";
import { askClaude, clip, namesOn } from "./names";
import { blimpDir, claudeDir, type Session, transcriptPath } from "./sessions";

// What the apps get. at: when it was written (ms).
export type Recap = { goal: string; done: string[]; open: string[]; at: number };
// replies: how many replies the conversation had then; one more and it's written again.
export type Stored = Recap & { replies: number };
export type Recaps = Record<string, Stored>; // by Claude's sessionId

export const recapsFile = () => join(blimpDir(), "recaps.json");

export function readRecaps(file = recapsFile()): Recaps {
  const out: Recaps = {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    for (const [id, r] of Object.entries(v && typeof v === "object" ? v : {}))
      if (typeof (r as any)?.goal === "string" && Array.isArray((r as any).done) && Array.isArray((r as any).open) && typeof (r as any).at === "number")
        out[id] = r as Stored;
  } catch {}
  return out;
}

const KEEP = 200;

// Through a temp file and a rename, so it's never half written; 600; only the 200 newest kept.
export function saveRecap(id: string, r: Stored, file = recapsFile()) {
  const all = readRecaps(file);
  all[id] = r;
  const keep = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, KEEP);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// What a conversation has said so far, kept up to date as it grows: names.ts's Summary, plus the
// last 6 replies (what was done is mostly in those).
export type Brief = { scan: ChatScan; prompts: number; replies: number; first?: string; last: string[]; said: string[] };
export const newBrief = (): Brief => ({ scan: newScan(""), prompts: 0, replies: 0, last: [], said: [] });

export function addToBrief(b: Brief, m: ChatMessage) {
  if (m.role === "user") {
    b.prompts++;
    b.first ??= m.text;
    b.last = [...b.last, m.text].slice(-3);
  } else if (m.role === "assistant") {
    b.replies++;
    b.said = [...b.said, m.text].slice(-6);
  }
}

// Read in chunks with a turn of the event loop between them, like names.ts follow.
async function follow(file: string, b: Brief) {
  for (;;) {
    if (statSync(file).size < b.scan.offset) Object.assign(b, newBrief()); // rewritten shorter
    const from = b.scan.offset;
    for (const m of readAppended(file, b.scan, 4 << 20)) addToBrief(b, m);
    if (b.scan.offset === from) return;
    await Bun.sleep(0);
  }
}

// What the model reads: each piece cut to ~300 characters, no tool calls or output.
export function recapPrompt(p: { title?: string; first?: string; last: string[]; said: string[]; prompts: number; replies: number }): string {
  const lines = [
    "The user is coming back to this Claude Code session after time away. Tell them where it stands.",
    "Answer in exactly this format, one item per line, nothing else:",
    "GOAL | what the session is for, in one line",
    "DONE | something finished (at most 4 DONE lines, the most important first)",
    "OPEN | something still to do or to decide (at most 4 OPEN lines; none if nothing is left)",
    "Each line at most 120 characters, in plain words: no markdown.",
    "",
  ];
  if (p.title) lines.push(`Session: ${clip(p.title)}`);
  lines.push(`${p.prompts} requests and ${p.replies} replies so far.`);
  // With 3 prompts or fewer, the first is one of the latest.
  if (p.first && p.prompts > p.last.length) lines.push(`First request: ${clip(p.first)}`);
  if (p.last.length) lines.push("Latest requests, oldest first:", ...p.last.map((t) => `- ${clip(t)}`));
  if (p.said.length) lines.push("Claude's latest replies, oldest first:", ...p.said.map((t) => `- ${clip(t)}`));
  return lines.join("\n") + "\n";
}

// The model's answer as a card, or undefined if it isn't one: one GOAL line, then DONE and OPEN lines
// (the first 4 of each kept), nothing else; each at most 140 characters once markdown marks are off.
// It's shown as plain text.
export function checkRecap(out: string): Omit<Recap, "at"> | undefined {
  let goal: string | undefined;
  const done: string[] = [];
  const open: string[] = [];
  for (const l of out.split("\n").map((l) => l.trim())) {
    if (!l) continue;
    const m = l.match(/^(GOAL|DONE|OPEN)\s*\|\s*(.*)$/i);
    if (!m) return;
    const text = m[2].replace(/\*\*|__|`/g, "").replace(/^[-•]\s+/, "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 140 || /[\x00-\x1f\x7f]/.test(text)) return;
    const kind = m[1].toUpperCase();
    if (kind === "GOAL") {
      if (goal !== undefined) return;
      goal = text;
    } else (kind === "DONE" ? done : open).push(text);
  }
  return goal === undefined ? undefined : { goal, done: done.slice(0, 4), open: open.slice(0, 4) };
}

type Deps = {
  ask: (prompt: string) => Promise<string | undefined>;
  now: () => number;
  on: () => boolean;
  file: string;
  transcript: (sessionId: string) => string | undefined;
};
const live: Deps = {
  ask: (p) => askClaude(p),
  now: () => Date.now(),
  on: () => namesOn(),
  get file() {
    return recapsFile();
  },
  transcript: (id) => transcriptPath(claudeDir(), id),
};

const MIN = 60_000;
const PER_HOUR = 30;

// The recap of a session: the saved one while Claude hasn't replied since, else a new one (at most
// 30 calls an hour; two asks at once share one). min: refused (404) with fewer prompts than that, as
// the apps ask on their own only for a session with some history. Throws HttpError.
export function recapper(deps: Deps = live) {
  const briefs = new Map<string, Brief>(); // by transcript file, the 50 last asked about
  const asking = new Map<string, Promise<Recap>>(); // by sessionId
  const calls: number[] = [];

  async function write(id: string, b: Brief, title?: string): Promise<Recap> {
    const t = deps.now();
    while (calls.length && t - calls[0] >= 60 * MIN) calls.shift();
    if (calls.length >= PER_HOUR) throw new HttpError(429, "Too many recaps this hour");
    calls.push(t);
    const replies = b.replies;
    const card = checkRecap((await deps.ask(recapPrompt({ title, ...b }))) ?? "");
    if (!card) throw new HttpError(502, "Couldn't write a recap");
    const r: Recap = { ...card, at: deps.now() };
    saveRecap(id, { ...r, replies }, deps.file);
    return r;
  }

  return async (s: Pick<Session, "kind" | "sessionId" | "title">, min = 0): Promise<Recap> => {
    if (!deps.on()) throw new HttpError(404, "Recaps are off");
    const file = s.sessionId && CLAUDE_KINDS.includes(s.kind) ? deps.transcript(s.sessionId) : undefined;
    if (!s.sessionId || !file) throw new HttpError(404, "No conversation to recap");
    const id = s.sessionId;
    let b = briefs.get(file);
    if (!b) b = newBrief();
    briefs.delete(file);
    briefs.set(file, b);
    for (const f of briefs.keys()) if (briefs.size > 50) briefs.delete(f);
    await follow(file, b);
    if (b.prompts < Math.max(min, 1) || b.replies < 1) throw new HttpError(404, "Not enough to recap yet");
    const had = readRecaps(deps.file)[id];
    if (had?.replies === b.replies) return { goal: had.goal, done: had.done, open: had.open, at: had.at };
    let p = asking.get(id);
    if (!p) {
      asking.set(id, (p = write(id, b, s.title)));
      p.finally(() => asking.delete(id)).catch(() => {});
    }
    return p;
  };
}

export const recap = recapper();
