// One-click handoff: a Claude session writes down where its work stands, and a fresh session picks it
// up from there. blimpd types a request into the session (typing.ts) asking for a handoff file under
// notes/<date>/ and for its path as the only reply. It then follows the transcript: the first reply
// after the request reached Claude that names a Markdown file written since is the handoff. A new
// session of the same kind starts in the same folder with "Read <file> and do it" as its first
// message. The link lives in <socket dir>/handoffs.json, by the parent's zmx name, so the list can say
// "Handed off" on the parent and show where the child came from.

import { chmodSync, closeSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { HttpError } from "./files";
import { CLAUDE_KINDS, launchFor } from "./kinds";
import { cleanText } from "./prompt";
import { blimpDir, isSafeName, parseZmxList, startSession, zmxListAsync } from "./sessions";
import { Asking, findSession, typeInto } from "./typing";

export type HandoffState = "writing" | "started" | "failed";
// What the apps get, on the parent: the new session and the file once started, or why it failed.
export type HandoffView = { state: HandoffState; child?: string; file?: string; error?: string };
// A new session started from a handoff: asked for at `at`, started by `startedAt`.
export type Link = { child: string; at: number; startedAt: number };
// Kept on disk besides: when it was asked for, where to start the new session and as what kind, the
// transcript to follow from the offset it had when the request was typed, when the new session had
// started, and the sessions this parent's earlier handoffs started.
export type Handoff = HandoffView & { at: number; dir: string; kind: string; transcript: string; offset: number; startedAt?: number; earlier?: Link[] };
export type Handoffs = Record<string, Handoff>; // by the parent's zmx name

export const handoffsFile = () => join(blimpDir(), "handoffs.json");

const TIMEOUT = 20 * 60_000;
const KEEP = 7 * 86400_000;
const CHUNK = 4 << 20;

// The start of the request, also how its arrival is found in the transcript.
const MARK = "Write a handoff so a fresh session can continue this work";

const two = (n: number) => String(n).padStart(2, "0");

// The request, with today's date filled in (the server's day), so Claude doesn't have to look it up.
export const handoffText = (day: Date) =>
  `${MARK}: what the goal is, what's done, what's left, the key files and commands, and anything that went wrong. ` +
  `Save it as notes/${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}/HANDOFF-<short-slug>.md in this folder (make the folder if needed). ` +
  `Then reply with only the file's path.`;

export function readHandoffs(file = handoffsFile()): Handoffs {
  const out: Handoffs = {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    for (const [name, h] of Object.entries(v && typeof v === "object" ? v : {}))
      if (typeof (h as any)?.state === "string" && typeof (h as any).at === "number") out[name] = h as Handoff;
  } catch {}
  return out;
}

// Through a temp file and a rename, 600. Only links with a live parent or child, from the last 7 days.
// An empty live list is more likely a zmx list that failed than no sessions, so then none go for that.
export function saveHandoffs(all: Handoffs, live: string[], now = Date.now(), file = handoffsFile()) {
  const children = (h: Handoff) => [h.child, ...(h.earlier ?? []).map((l) => l.child)];
  const keep = Object.entries(all).filter(([p, h]) => now - h.at < KEEP && (!live.length || live.includes(p) || children(h).some((c) => !!c && live.includes(c))));
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// What the session list adds to a session: its own handoff (as a parent) and the session it came from,
// either or both. `created` is the session's (zmx's, in seconds): a parent was there when it asked, a
// child started between the request and the start returning. A later session given the same name is
// neither.
export function handoffLinks(all: Handoffs, name: string, created: number): { handoff?: HandoffView; parent?: string } {
  const t = created * 1000;
  const h = all[name] && t <= all[name].at ? all[name] : undefined;
  const isChild = (l: Partial<Link>) => l.child === name && l.startedAt !== undefined && t >= l.at! - 1000 && t <= l.startedAt + 1000;
  const parent = Object.keys(all).find((p) => [all[p], ...(all[p].earlier ?? [])].some(isChild));
  return {
    ...(h && { handoff: { state: h.state, ...(h.child && { child: h.child }), ...(h.file && { file: h.file }), ...(h.error && { error: h.error }) } }),
    ...(parent && { parent }),
  };
}

const mtimeOf = (p: string) => {
  try {
    const st = statSync(p);
    return st.isFile() ? st.mtimeMs : undefined;
  } catch {}
};

// The Markdown file a reply names that was written at `since` or after: absolute, or relative to one of
// dirs (the session's folder, then the one Claude was in). A file that was there before (a README
// Claude mentions on the way) isn't the handoff. A reply that is only a path, as Claude was asked to
// reply, can name any Markdown file; in a sentence, only a HANDOFF*.md is taken (asked for while Claude
// worked, the replies until it gets to it name the files it edits). There the last one named wins, and
// a path can have spaces: each is tried from every word or delimiter before it, shortest first.
export function namedFile(text: string, dirs: string[], since: number, mtime = mtimeOf): string | undefined {
  const found = (p: string) => {
    p = p.replace(/^file:\/\//, "");
    for (const d of isAbsolute(p) ? [""] : dirs) {
      const full = resolve(d, p);
      if ((mtime(full) ?? -Infinity) >= since) return full;
    }
  };
  const whole = text.trim().replace(/\.$/, "").replace(/^[`'"*]+|[`'"*]+$/g, "");
  const only = !whole.includes("\n") && /\.md$/i.test(whole) ? found(whole) : undefined;
  if (only) return only;
  for (const line of text.split("\n").reverse()) {
    for (const m of [...line.matchAll(/\.md(?![\w-])/gi)].reverse()) {
      const end = m.index! + 3;
      const starts = [0, ...[...line.slice(0, end).matchAll(/[\s`'"<>()[\]{}|*,;]/g)].map((d) => d.index! + 1)].reverse();
      if (!/^HANDOFF.*\.md$/i.test(basename(line.slice(starts[0], end)))) continue;
      for (const s of starts) {
        const f = found(line.slice(s, end));
        if (f) return f;
      }
    }
  }
}

// What a transcript line says for a handoff: the request reached Claude (typed in, or given to it as a
// queued message while it worked), or Claude replied with text (main thread only), and the folder it was in.
// Only something typed counts as the request, not a tool result that has its words (Claude reading this
// code, say).
export function replyEvent(line: string): { asked: true } | { reply: string; cwd?: string } | undefined {
  const mark = line.includes(MARK);
  if (!mark && !line.includes('"type":"assistant"')) return;
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
  const c = r?.message?.content;
  const typed =
    r?.type === "user" && !r.toolUseResult && (typeof c === "string" ? c : Array.isArray(c) && c.every((b: any) => b?.type === "text") ? c.map((b: any) => b.text).join("\n") : "");
  if (mark && ((typed && typed.includes(MARK)) || (r?.type === "attachment" && r.attachment?.type === "queued_command"))) return { asked: true };
  if (r?.type !== "assistant" || r.isSidechain || r.message?.model === "<synthetic>" || !Array.isArray(r.message?.content)) return;
  const text = r.message.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n");
  if (text.trim()) return { reply: text, ...(typeof r.cwd === "string" && { cwd: r.cwd }) };
}

// The complete lines added to a transcript since offset (at most about CHUNK bytes, unless one line is
// longer), and the offset after them. An unfinished last line is read next time.
function newLines(file: string, offset: number): { lines: string[]; offset: number } {
  const size = statSync(file).size;
  if (size <= offset) return { lines: [], offset: Math.min(offset, size) };
  const fd = openSync(file, "r");
  try {
    for (let len = Math.min(size - offset, CHUNK); ; len = Math.min(size - offset, len * 2)) {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, offset);
      const end = buf.lastIndexOf(10, n - 1);
      if (end < 0 && n === len && len < size - offset) continue; // a line longer than len
      if (end < 0) return { lines: [], offset };
      return { lines: buf.toString("utf8", 0, end).split("\n"), offset: offset + end + 1 };
    }
  } finally {
    closeSync(fd);
  }
}

type Deps = {
  now: () => number;
  live: () => Promise<string[]>; // zmx names
  start: (dir: string, kind: string, prompt: string) => Promise<string>;
};

// A new session, as POST /sessions starts one with a first message.
async function startChild(dir: string, kind: string, prompt: string): Promise<string> {
  const run = await launchFor(kind);
  run.args.push("--", cleanText(prompt));
  return startSession(dir, { kind, run });
}

const real: Deps = {
  now: Date.now,
  live: async () => parseZmxList(await zmxListAsync()).map((s) => s.name),
  start: startChild,
};

// How far each handoff being written has been followed: by parent, for the handoff `key` (its time and transcript).
const follows = new Map<string, { key: string; offset: number; asked: boolean }>();
let busy = false;

// Every second: each handoff still being written either found its file (the new session starts), timed
// out, or lost its session. Read again from the saved offset after a restart.
export async function handoffTick(deps: Deps = real, file = handoffsFile()) {
  if (busy) return;
  busy = true;
  try {
    const all = readHandoffs(file);
    const writing = Object.entries(all).filter(([, h]) => h.state === "writing");
    for (const p of follows.keys()) if (all[p]?.state !== "writing") follows.delete(p);
    if (!writing.length) return;
    const live = await deps.live();
    const save = (p: string, h: Handoff) => {
      const now = readHandoffs(file);
      now[p] = h;
      saveHandoffs(now, live, deps.now(), file);
      follows.delete(p);
    };
    for (const [p, h] of writing) {
      if (deps.now() - h.at > TIMEOUT) {
        save(p, { ...h, state: "failed", error: "No handoff file came back" });
        continue;
      }
      if (live.length && !live.includes(p)) {
        save(p, { ...h, state: "failed", error: "The session ended" });
        continue;
      }
      const key = `${h.at}\0${h.transcript}`;
      let f = follows.get(p);
      if (!f || f.key !== key) follows.set(p, (f = { key, offset: h.offset, asked: false }));
      let found: string | undefined;
      try {
        for (let read = newLines(h.transcript, f.offset); read.lines.length && !found; read = newLines(h.transcript, f.offset)) {
          f.offset = read.offset;
          for (const line of read.lines) {
            const e = replyEvent(line);
            if (e && "asked" in e) f.asked = true;
            else if (e && f.asked) found = namedFile(e.reply, [h.dir, ...(e.cwd ? [e.cwd] : [])], h.at - 2000);
            if (found) break;
          }
        }
      } catch {
        continue; // the transcript can't be read just now
      }
      if (!found) continue;
      const rel = relative(h.dir, found);
      const shown = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : found;
      try {
        const child = await deps.start(h.dir, h.kind, `Read ${shown} and do it`);
        save(p, { ...h, state: "started", child, file: found, startedAt: deps.now() });
      } catch (e) {
        save(p, { ...h, state: "failed", file: found, error: (e as Error).message || String(e) });
      }
    }
  } catch {
  } finally {
    busy = false;
  }
}

export function startHandoffs(every = 1000) {
  setInterval(() => void handoffTick(), every);
}

// POST /sessions/<name>/handoff: types the request into a Claude session and records the handoff as
// being written. 409 while Claude asks something, or while a handoff is already being written.
const asking = new Set<string>();
export async function askHandoff(name: string, file = handoffsFile()): Promise<HandoffView> {
  const s = isSafeName(name) ? await findSession(name) : undefined;
  if (!s) throw new HttpError(404, `no session named ${name}`);
  if (!CLAUDE_KINDS.includes(s.kind)) throw new HttpError(400, "Only a Claude Code session can hand off.");
  if (!s.transcript) throw new HttpError(409, "Claude hasn't started a conversation here yet.");
  if (asking.has(name) || readHandoffs(file)[name]?.state === "writing") throw new HttpError(409, "A handoff is already being written.");
  if (s.state === "waiting") throw new HttpError(409, new Asking().message);
  asking.add(name);
  try {
    const at = Date.now();
    // Before typing, so a quick reply isn't missed.
    const offset = statSync(s.transcript).size;
    try {
      await typeInto(name, handoffText(new Date(at)), { enter: true });
    } catch (e) {
      if (e instanceof Asking) throw new HttpError(409, e.message);
      if ((e as Error).message === "the session ended") throw new HttpError(404, `no session named ${name}`);
      throw e;
    }
    const live = await real.live();
    // Read and written with no await between, so the tick's own writes aren't lost.
    const all = readHandoffs(file);
    // The sessions this one's earlier handoffs started stay linked to it.
    const old = all[name] && s.created * 1000 <= all[name].at ? all[name] : undefined;
    const earlier = [...(old?.earlier ?? []), ...(old?.child && old.startedAt ? [{ child: old.child, at: old.at, startedAt: old.startedAt }] : [])];
    all[name] = { state: "writing", at, dir: s.dir, kind: s.kind, transcript: s.transcript, offset, ...(earlier.length && { earlier }) };
    saveHandoffs(all, live, at, file);
    return { state: "writing" };
  } finally {
    asking.delete(name);
  }
}
