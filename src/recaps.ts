// Return cards ("where was I?"): when you come back to a Claude session after time away, the apps ask
// GET /sessions/<name>/recap and show what it's for, what's done, what Claude is in the middle of, what's
// stuck and on what, and what's next. A small, fast
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

// The card: done is finished, doing is what Claude is in the middle of, stuck is what's blocked (each
// saying on what), next is what's left after that.
export type Card = { goal: string; done: string[]; doing: string[]; stuck: string[]; next: string[] };
// What the apps get. open: doing, stuck and next in one, for the apps from 0.3.0, which show only done
// and open. at: when it was written (ms).
export type Recap = Card & { open: string[]; at: number };
// replies: how many replies the conversation had then; one more and it's written again.
export type Stored = Card & { at: number; replies: number };
export type Recaps = Record<string, Stored>; // by Claude's sessionId

export const recapsFile = () => join(blimpDir(), "recaps.json");

const LISTS = ["done", "doing", "stuck", "next"] as const;

// One kept by a blimpd from before doing, stuck and next ({ goal, done, open }) is left out: its open
// mixed all three, so it's written again the next time it's asked for.
export function readRecaps(file = recapsFile()): Recaps {
  const out: Recaps = {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    for (const [id, r] of Object.entries(v && typeof v === "object" ? v : {}))
      if (typeof (r as any)?.goal === "string" && LISTS.every((k) => Array.isArray((r as any)[k])) && typeof (r as any).at === "number")
        out[id] = r as Stored;
  } catch {}
  return out;
}

const toRecap = (c: Card, at: number): Recap => ({ goal: c.goal, done: c.done, doing: c.doing, stuck: c.stuck, next: c.next, open: [...c.doing, ...c.stuck, ...c.next], at });

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
    "DOING | something Claude is in the middle of (at most 3 DOING lines)",
    'STUCK | something blocked, saying on what, as "Waiting on you: approve the deploy" or "Tests fail in auth.test.ts" (at most 3 STUCK lines)',
    "NEXT | something left to do after that (at most 3 NEXT lines)",
    // Without this, haiku files a question Claude asked as DOING ("Waiting on your answer ..."), so the
    // card puts what needs you under In progress.
    'If Claude asked the user something or waits for their go-ahead, that is STUCK ("Waiting on you: ..."), never DOING; DOING is only work Claude is still running.',
    "Leave out a kind with nothing in it: never write a line saying there is nothing. Each line at most 100 characters, in plain words: no markdown.",
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

// An item that only says there's nothing ("Nothing left to do", "None", "No blockers"), which haiku
// still writes at times; it would show a heading over nothing. One that goes on to say what ("Nothing
// renders in Safari", "None of the tests pass") is an item.
const NOTHING = /^(?:none|n\/a|nothing|no (?:blockers?|more work|further work|work left|next steps?))(?:[\s\W]*$|(?:\s+(?:is|currently))?\s+(?:left|more|else|running|pending|blocked|stuck|in progress|to do|right now|yet|for now|at the moment)\b)/i;

// The model's answer as a card, or undefined if it isn't one: one GOAL line, then DONE, DOING, STUCK and
// NEXT lines (the first 4 done and 3 of the others kept), nothing else. An item that only says there's
// nothing is skipped. A line over 140 characters once markdown marks are off is
// cut at a word, with "…" (haiku often goes past the 100 it's asked for). It's shown as plain text.
export function checkRecap(out: string): Card | undefined {
  let goal: string | undefined;
  const lists: Record<(typeof LISTS)[number], string[]> = { done: [], doing: [], stuck: [], next: [] };
  for (const l of out.split("\n").map((l) => l.trim())) {
    if (!l) continue;
    const m = l.match(/^(GOAL|DONE|DOING|STUCK|NEXT)\s*\|\s*(.*)$/i);
    if (!m) return;
    let text = m[2].replace(/\*\*|__|`/g, "").replace(/^[-•]\s+/, "").replace(/\s+/g, " ").trim();
    if (!text || /[\x00-\x1f\x7f]/.test(text)) return;
    if (text.length > 140) {
      const at = text.lastIndexOf(" ", 139);
      text = text.slice(0, at > 0 ? at : /[\ud800-\udbff]/.test(text[138]) ? 138 : 139).trimEnd() + "…";
    }
    const kind = m[1].toLowerCase();
    if (kind === "goal") {
      if (goal !== undefined) return;
      goal = text;
    } else if (!NOTHING.test(text)) lists[kind as keyof typeof lists].push(text);
  }
  const { done, doing, stuck, next } = lists;
  return goal === undefined ? undefined : { goal, done: done.slice(0, 4), doing: doing.slice(0, 3), stuck: stuck.slice(0, 3), next: next.slice(0, 3) };
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
    const at = deps.now();
    saveRecap(id, { ...card, at, replies }, deps.file);
    return toRecap(card, at);
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
    if (had?.replies === b.replies) return toRecap(had, had.at);
    let p = asking.get(id);
    if (!p) {
      asking.set(id, (p = write(id, b, s.title)));
      p.finally(() => asking.delete(id)).catch(() => {});
    }
    return p;
  };
}

export const recap = recapper();
