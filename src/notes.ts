// A note on each Claude session's last turn, for a project's inbox (docs/DESIGN.md, "Notes"): when a turn
// ends, a small, fast Claude model (haiku, on your own Claude sign-in, as for names) says whether it's done,
// still in progress or asking you something, in a few words. Notes live in <socket dir>/notes.json; the
// names' switch (`{"names": false}` in config.json) turns them off too.

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_KINDS } from "./kinds";
import { askClaude, clip, follow, namesOn, newSummary, type Summary } from "./names";
import { blimpDir, claudeDir, listSessionsLite, type Session, transcriptPath, zmxListAsync } from "./sessions";

export type NoteStatus = "done" | "progress" | "question";
// turn: "<prompts>/<replies>" of the transcript when it was written, so the next turn gets a new one.
export type Note = { status: NoteStatus; text: string; at: number; turn: string };
export type Notes = Record<string, Note>; // by Claude's sessionId
// What the apps get.
export type ShownNote = Omit<Note, "turn">;

export const notesFile = () => join(blimpDir(), "notes.json");

export function readNotes(file = notesFile()): Notes {
  const out: Notes = {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    for (const [id, n] of Object.entries(v && typeof v === "object" ? v : {}))
      if (typeof (n as any)?.text === "string" && typeof (n as any).at === "number") out[id] = n as Note;
  } catch {}
  return out;
}

// The notes the session list and the Earlier lists carry: none while names are off.
export const shownNotes = (): Notes => (namesOn() ? readNotes() : {});
export const shownNote = (n: Note | undefined): ShownNote | undefined => n && { status: n.status, text: n.text, at: n.at };

const KEEP = 500;

// Through a temp file and a rename, so it's never half written; 600; only the 500 newest kept.
export function saveNote(id: string, n: Note, file = notesFile()) {
  const all = readNotes(file);
  all[id] = n;
  const keep = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, KEEP);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const MIN = 60_000;

export const turnOf = (sum: { prompts: number; replies: number }) => `${sum.prompts}/${sum.replies}`;

// Whether to ask for a note now: a Claude session whose turn is over, with a prompt or a reply the last
// note didn't have. A session whose last try failed waits 10 minutes.
export function wantsNote(
  s: Pick<Session, "kind" | "state">,
  sum: { prompts: number; replies: number },
  had: Note | undefined,
  now: number,
  failedAt?: number,
): boolean {
  if (!CLAUDE_KINDS.includes(s.kind) || (s.state !== "done" && s.state !== "waiting")) return false;
  if (sum.prompts < 1 || sum.replies < 1) return false;
  if (failedAt !== undefined && now - failedAt < 10 * MIN) return false;
  return had?.turn !== turnOf(sum);
}

// What the model reads: each piece cut to ~300 characters, no tool calls or output.
export function notingPrompt(p: { title?: string; last: string[]; reply?: string }): string {
  const lines = [
    "Say where this Claude Code session stands after its latest turn, for a list the user skims.",
    "Answer with one line: a status, then at most 8 words.",
    "DONE | when Claude did what was asked and waits for the next request.",
    "PROGRESS | when the work isn't finished: Claude stopped part way, or says what it does next.",
    "QUESTION | when Claude asks the user something or waits for a decision.",
    'The words say what was done, what is going on, or what is asked, as in "DONE | v0.2.16 released, phone build uploaded".',
    "Nothing else.",
    "",
  ];
  if (p.title) lines.push(`Session: ${clip(p.title)}`);
  if (p.last.length) lines.push("Latest requests, oldest first:", ...p.last.map((t) => `- ${clip(t)}`));
  if (p.reply) lines.push(`Claude's latest reply: ${clip(p.reply)}`);
  return lines.join("\n") + "\n";
}

// The model's answer as a note, or undefined if it isn't one: one line, a status, then at most 80
// characters without trailing punctuation (a question mark stays). It's shown as plain text.
export function checkNote(out: string): { status: NoteStatus; text: string } | undefined {
  const m = out.trim().match(/^(DONE|PROGRESS|QUESTION)\s*\|\s*(.*)$/i);
  if (!m || out.trim().includes("\n")) return;
  const text = m[2].replace(/[.,;:!…]+$/, "").trim();
  if (!text || text.length > 80 || /[\x00-\x1f\x7f]/.test(text)) return;
  return { status: m[1].toLowerCase() as NoteStatus, text };
}

type Deps = {
  sessions: () => Promise<Pick<Session, "kind" | "state" | "sessionId" | "title">[]>;
  transcript: (sessionId: string) => string | undefined;
  file: string;
  on: () => boolean;
};
const live: Deps = {
  sessions: async () => listSessionsLite(claudeDir(), await zmxListAsync()),
  transcript: (id) => transcriptPath(claudeDir(), id),
  get file() {
    return notesFile();
  },
  on: () => namesOn(),
};

// The noting loop: every 5 s, at most one call at a time and 120 an hour.
const summaries = new Map<string, Summary>(); // by transcript file
const failed = new Map<string, number>(); // sessionId -> when its last try failed
const calls: number[] = [];
let busy = false;

export async function noteTick(ask = askClaude, now = Date.now, deps: Deps = live): Promise<void> {
  if (busy || !deps.on()) return;
  busy = true;
  try {
    const notes = readNotes(deps.file);
    const seen = new Set<string>();
    for (const s of await deps.sessions()) {
      if (!s.sessionId || !CLAUDE_KINDS.includes(s.kind)) continue;
      const file = deps.transcript(s.sessionId);
      if (!file) continue;
      seen.add(file);
      let sum = summaries.get(file);
      if (!sum) summaries.set(file, (sum = newSummary()));
      try {
        await follow(file, sum);
      } catch {
        continue;
      }
      if (!wantsNote(s, sum, notes[s.sessionId], now(), failed.get(s.sessionId))) continue;
      const t = now();
      while (calls.length && t - calls[0] >= 60 * MIN) calls.shift();
      if (calls.length >= 120) return;
      calls.push(t);
      const turn = turnOf(sum);
      const note = checkNote((await ask(notingPrompt({ title: s.title, ...sum }))) ?? "");
      if (note) {
        saveNote(s.sessionId, { ...note, at: now(), turn }, deps.file);
        failed.delete(s.sessionId);
      } else failed.set(s.sessionId, now());
      return; // one call per tick
    }
    for (const f of summaries.keys()) if (!seen.has(f)) summaries.delete(f);
  } catch {
  } finally {
    busy = false;
  }
}

export function startNotes(every = 5000) {
  setInterval(() => void noteTick(), every);
}
