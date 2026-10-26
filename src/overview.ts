// The assistant's look commands (docs/superpowers/specs/2026-10-26-assistant-design.md, section 2), plain text for
// Claude to read. blimpd overview: every project but the hidden ones and the assistant's own folder, its running
// sessions with their state by the inbox's rules (widget.ts), what a waiting one asks with its options numbered as
// blimpd answer takes them, and its unread past conversations with their ids. It asks the running blimpd, whose
// title scans are already warm. blimpd read: a running session's or a past conversation's latest messages, read
// here from the transcript.

import { homedir } from "node:os";
import { assistantDir } from "./assistant";
import { type ChatMessage, newScan, readLast } from "./chat";
import { getJson } from "./client";
import { firstCwd } from "./folders";
import type { ShownNote } from "./notes";
import type { Prompt } from "./prompt";
import { claudeDir, listSessionsLite, realDir, type Session, transcriptPath, zmxListAsync } from "./sessions";
import { type WidgetState, widgetState } from "./widget";

export type Past = { sessionId: string; title: string; updatedAt: number; unread: boolean; note?: ShownNote };
export type OverviewInput = { sessions: Session[]; folders: string[]; earlier: Map<string, Past[]>; hidden: Set<string>; skip: string; home: string; now: number };

const WORDS: Record<WidgetState, string> = { needs: "needs you", new: "new reply", working: "working" };
const PAST_MAX = 5; // unread past conversations per project
const EARLIER_FOLDERS = 10; // the most recent projects whose past conversations are looked at

export function ago(ms: number, now: number): string {
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / (24 * 60))}d ago`;
}

const numbered = (list: string[]) => list.map((o, i) => `${i + 1}. ${o}`).join("  ");

// What a waiting session asks, in one line. Only what blimpd answer can pick gets options without a note.
export function asks(p: Prompt): string {
  if (p.kind === "permission") return `${p.tool}: ${p.summary} | options: ${numbered(p.options)}`;
  if (p.kind === "trust") return `whether to trust the folder ${p.folder} | options: ${numbered(p.options)}`;
  if (p.kind === "question") {
    const q = p.questions[0];
    if (!q) return "a question (answer it in the app)";
    const app = p.questions.length > 1 || q.multiSelect || !p.answerable;
    return `${q.question} | options: ${numbered(q.options.map((o) => o.label))}${app ? " (answer it in the app: it has several parts or choices)" : ""}`;
  }
  return "something only the terminal shows (answer it in the app)";
}

const where = (dir: string, home: string) => (dir === home ? "~" : dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir);

function sessionLine(s: Session, now: number): string {
  const state = widgetState(s);
  const word = state ? WORDS[state] : s.kind === "shell" ? "shell" : s.state === "done" ? "idle" : s.state;
  let line = `${s.name}  "${s.title}"${s.label ? ` (${s.label})` : ""}  ${word}, ${ago(s.stateSince ?? s.updatedAt ?? s.created * 1000, now)}`;
  if (s.note) line += ` | note: ${s.note.text}`;
  if (s.state === "waiting" && s.prompt) line += `\n    asks: ${asks(s.prompt)}`;
  return line;
}

const pastLine = (c: Past, now: number) => `earlier ${c.sessionId}  "${c.title}"  unread, ${ago(c.updatedAt, now)}${c.note ? ` | note: ${c.note.text}` : ""}`;

// Projects in the order of folders (newest first), then any other folder a session runs in.
export function overviewText(o: OverviewInput): string {
  const shown = (dir: string) => dir !== o.skip && !o.hidden.has(dir);
  const live = o.sessions.filter((s) => shown(s.dir) && s.kind !== "run");
  const open = new Set(live.map((s) => s.sessionId));
  const blocks: string[] = [];
  for (const dir of new Set([...o.folders, ...live.map((s) => s.dir)])) {
    if (!shown(dir)) continue;
    const rows = live.filter((s) => s.dir === dir).map((s) => sessionLine(s, o.now));
    const past = (o.earlier.get(dir) ?? []).filter((c) => c.unread && !open.has(c.sessionId)).slice(0, PAST_MAX).map((c) => pastLine(c, o.now));
    if (rows.length || past.length) blocks.push([where(dir, o.home), ...[...rows, ...past].map((r) => "  " + r)].join("\n"));
  }
  return blocks.length ? blocks.join("\n\n") : "Nothing is running, and nothing is unread.";
}

const CLIP = 2000;
const clip = (s: string) => {
  const chars = Array.from(s);
  return chars.length > CLIP ? chars.slice(0, CLIP).join("") + " … (cut)" : s;
};

export function messagesText(list: ChatMessage[]): string {
  return list
    .map((m) => {
      if (m.role === "user") return `you: ${clip(m.text)}`;
      if (m.role === "assistant") return `claude: ${clip(m.text)}`;
      if (m.role === "tool") return `tool: ${m.summary}${m.error ? " (failed)" : ""}`;
      if (m.role === "shell") return `! ${m.input}`;
      return "(the conversation was compacted here)";
    })
    .join("\n\n");
}

export async function runOverview(): Promise<number> {
  try {
    const [sessions, folders, hidden] = await Promise.all([
      getJson<Session[]>("/sessions"),
      getJson<{ dir: string }[]>("/folders/recent"),
      getJson<string[]>("/folders/hidden"),
    ]);
    const recent = folders.map((f) => f.dir);
    const dirs = [...new Set([...recent.slice(0, EARLIER_FOLDERS), ...sessions.map((s) => s.dir)])];
    const earlier = new Map(await Promise.all(dirs.map(async (d) => [d, await getJson<Past[]>(`/conversations?dir=${encodeURIComponent(d)}`)] as const)));
    console.log(overviewText({ sessions, folders: recent, earlier, hidden: new Set(hidden), skip: realDir(assistantDir()), home: realDir(homedir()), now: Date.now() }));
    return 0;
  } catch (e) {
    console.error(`blimpd overview: ${(e as Error).message}`);
    return 1;
  }
}

export async function runRead(args: string[]): Promise<number> {
  const fail = (m: string) => (console.error(`blimpd read: ${m}`), 1);
  const [target, flag, count, ...rest] = args;
  const n = flag === undefined ? 20 : Number(count);
  if (!target || (flag !== undefined && flag !== "--last") || rest.length || !Number.isInteger(n) || n < 1 || n > 200)
    return fail("usage: blimpd read <session or conversation id> [--last N] (N from 1 to 200)");
  let file: string | undefined;
  let dir = "";
  if (/^[0-9a-f-]{36}$/.test(target)) {
    file = transcriptPath(claudeDir(), target);
    if (!file) return fail(`no conversation ${target}`);
    dir = firstCwd(file) ?? "";
  } else {
    const s = listSessionsLite(claudeDir(), await zmxListAsync()).find((x) => x.name === target);
    if (!s) return fail(`no session named ${target}`);
    if (!s.transcript) return fail(`${target} has no Claude conversation to read`);
    file = s.transcript;
    dir = s.dir;
  }
  const list = await readLast(file, newScan(dir), n);
  console.log(list.length ? messagesText(list) : "(no messages yet)");
  return 0;
}
