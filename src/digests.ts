// A paragraph on each project, for the phone's inbox (docs/DESIGN.md, "Digests"): where the work in its
// Claude sessions stands, written by a small, fast Claude model (haiku, on your own Claude sign-in, as for
// names and notes) from their titles, states and notes. A session it mentions is a link: "[a few words](n)",
// n its number in `sessions`. Digests live in <socket dir>/digests.json; the names' switch
// (`{"names": false}` in config.json) turns them off too.

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CLAUDE_KINDS } from "./kinds";
import { askClaude, clip, follow, namesOn, newSummary, type Summary } from "./names";
import type { ShownNote } from "./notes";
import { blimpDir, claudeDir, listSessions, type Session, transcriptPath, zmxListAsync } from "./sessions";

// sessions: the names its links point at, link n at sessions[n - 1]. key: what it was written from (digestKey).
export type Digest = { text: string; sessions: string[]; at: number; key: string };
export type Digests = Record<string, Digest>; // by folder
// What the apps get.
export type ShownDigest = Omit<Digest, "key">;

// What the model reads about a session. last: its latest request (what a working one is on).
export type DigestSession = { name: string; title: string; state: Session["state"]; note?: ShownNote; last?: string };

export const digestsFile = () => join(blimpDir(), "digests.json");

export function readDigests(file = digestsFile()): Digests {
  const out: Digests = {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    for (const [dir, d] of Object.entries(v && typeof v === "object" ? v : {}))
      if (typeof (d as any)?.text === "string" && Array.isArray((d as any).sessions) && typeof (d as any).at === "number") out[dir] = d as Digest;
  } catch {}
  return out;
}

// The paragraphs of these folders (the ones with sessions running), for the events socket: none while names are off.
export function shownDigests(dirs: string[], on = () => namesOn(), file = digestsFile()): Record<string, ShownDigest> {
  if (!on()) return {};
  const all = readDigests(file);
  const out: Record<string, ShownDigest> = {};
  for (const dir of dirs) if (all[dir]) out[dir] = { text: all[dir].text, sessions: all[dir].sessions, at: all[dir].at };
  return out;
}

const KEEP = 200;

// Through a temp file and a rename, so it's never half written; 600; only the 200 newest kept.
export function saveDigest(dir: string, d: Digest, file = digestsFile()) {
  const all = readDigests(file);
  all[dir] = d;
  const keep = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, KEEP);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const MIN = 60_000;
const STILL = 15_000;

// A new paragraph is wanted when a session starts or ends, changes state or gets a new note.
export const digestKey = (list: DigestSession[]) =>
  list
    .map((s) => `${s.name}:${s.state}:${s.note?.at ?? 0}`)
    .sort()
    .join("\n");

// Whether to write one now: the sessions changed since the last paragraph and have stayed as they are for
// 15 s (a turn that ends often starts the next), and a failed try was 10 minutes ago or more.
export function wantsDigest(key: string, had: Digest | undefined, since: number, now: number, failedAt?: number): boolean {
  if (had?.key === key || now - since < STILL) return false;
  return failedAt === undefined || now - failedAt >= 10 * MIN;
}

function stands(s: DigestSession): string {
  const n = s.note?.text;
  if (s.state === "waiting") return `waiting on the user${n ? `: ${n}` : ""}`;
  if (s.state === "working") return `working now${s.last ? `; the latest request: ${clip(s.last, 200)}` : ""}`;
  if (s.note?.status === "question") return `asking the user: ${n}`;
  if (s.note?.status === "progress") return `stopped part way: ${n}`;
  return n ? `finished: ${n}` : "idle";
}

export function digestPrompt(project: string, list: DigestSession[]): string {
  return [
    `Tell the user where the work in their project ${project} stands, for a phone screen they glance at.`,
    "Write one short paragraph: 2 to 4 plain sentences, at most 80 words, no lists or headings.",
    "First what needs the user, then work still going on, then what's finished.",
    'Mention each session at most once, as a link: a few of your words in square brackets, then its number in parentheses, as in "[the login fix](2) is done".',
    "Nothing else.",
    "",
    "Sessions:",
    ...list.map((s, i) => `${i + 1}. "${clip(s.title, 100)}": ${stands(s)}`),
    "",
  ].join("\n");
}

// The model's answer as a paragraph, or undefined if it isn't one: one paragraph (a single line break is a
// space), at most 600 characters, no control characters, and every link "[words](n)" with n one of the sessions.
// Square brackets and "](" appear only in links. It's shown as text with those links.
export function checkDigest(out: string, n: number): string | undefined {
  const t = out.trim();
  if (!t || /\n\s*\n/.test(t) || /^\s*([-*•]|\d+\.)\s/m.test(t)) return;
  const text = t.replace(/\s*\n\s*/g, " ");
  if (text.length > 600 || /[\x00-\x1f\x7f]/.test(text)) return;
  const LINK = /\[([^\[\]]+)\]\((\d+)\)/g;
  for (const m of text.matchAll(LINK)) if (+m[2] < 1 || +m[2] > n) return;
  if (/[\[\]]/.test(text.replace(LINK, "$1"))) return;
  return text;
}

type Running = Pick<Session, "name" | "dir" | "kind" | "state" | "sessionId" | "title" | "note">;
type Deps = {
  sessions: () => Promise<Running[]>;
  transcript: (sessionId: string) => string | undefined;
  file: string;
  on: () => boolean;
};
const live: Deps = {
  sessions: async () => listSessions(claudeDir(), await zmxListAsync()),
  transcript: (id) => transcriptPath(claudeDir(), id),
  get file() {
    return digestsFile();
  },
  on: () => namesOn(),
};

// The loop: every 5 s, at most one call at a time and 60 an hour.
const summaries = new Map<string, Summary>(); // by transcript file, for each session's latest request
const changed = new Map<string, { key: string; since: number }>(); // folder -> its sessions' key, and since when
const failed = new Map<string, number>(); // folder -> when its last try failed
const calls: number[] = [];
let busy = false;

export async function digestTick(ask = askClaude, now = Date.now, deps: Deps = live): Promise<void> {
  if (busy || !deps.on()) return;
  busy = true;
  try {
    const byDir = new Map<string, DigestSession[]>();
    const seen = new Set<string>();
    for (const s of await deps.sessions()) {
      if (!s.sessionId || !CLAUDE_KINDS.includes(s.kind)) continue;
      let last: string | undefined;
      const file = deps.transcript(s.sessionId);
      if (file) {
        seen.add(file);
        let sum = summaries.get(file);
        if (!sum) summaries.set(file, (sum = newSummary()));
        try {
          await follow(file, sum);
          last = sum.last.at(-1);
        } catch {}
      }
      const list = byDir.get(s.dir) ?? [];
      list.push({ name: s.name, title: s.title, state: s.state, ...(s.note && { note: s.note }), ...(last && { last }) });
      byDir.set(s.dir, list);
    }
    for (const f of summaries.keys()) if (!seen.has(f)) summaries.delete(f);
    for (const d of changed.keys()) if (!byDir.has(d)) changed.delete(d);

    const digests = readDigests(deps.file);
    const t = now();
    for (const [dir, list] of byDir) {
      list.sort((a, b) => a.name.localeCompare(b.name));
      const key = digestKey(list);
      if (changed.get(dir)?.key !== key) changed.set(dir, { key, since: t });
      if (!wantsDigest(key, digests[dir], changed.get(dir)!.since, t, failed.get(dir))) continue;
      while (calls.length && t - calls[0] >= 60 * MIN) calls.shift();
      if (calls.length >= 60) return;
      calls.push(t);
      const text = checkDigest((await ask(digestPrompt(basename(dir) || dir, list))) ?? "", list.length);
      if (text) {
        saveDigest(dir, { text, sessions: list.map((s) => s.name), at: now(), key }, deps.file);
        failed.delete(dir);
      } else failed.set(dir, now());
      return; // one call per tick
    }
  } catch {
  } finally {
    busy = false;
  }
}

export function startDigests(every = 5000) {
  setInterval(() => void digestTick(), every);
}
