// What a Claude session is doing besides talking, read from its transcript (Claude Code's internal
// format, so every parser here is checked against captured real lines in test/activity.test.ts):
//   jobs     background work Claude started: Bash commands run (or moved) in the background, Monitors,
//            async agents and workflows. Each ends with a <task-notification>, or a TaskStop, or with
//            the Claude process that started it.
//   context  how full Claude's context window is: the latest reply's input tokens.
//   git      the folder of the latest line (it follows a `cd` into a worktree), and the branch checked
//            out there, read from git's own files: a line's gitBranch is the start folder's branch.
//   files    the files Claude edited, newest first. Kept on the server, not sent to clients.
// Like transcriptTitles (sessions.ts), each transcript is read once, then only the lines added since:
// the session list is rebuilt every second and transcripts run to 100 MB, most of it api-request lines.

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type JobKind = "bash" | "monitor" | "agent" | "workflow";
export type JobStatus = "running" | "done" | "failed" | "stopped";
// startedAt and endedAt in ms; clients work out how long it's run. lastLine: a running bash job's or
// Monitor's last output line, read at most every 10 s.
export type Job = { id: string; kind: JobKind; label: string; startedAt: number; status: JobStatus; outputFile?: string; endedAt?: number; exit?: number; lastLine?: string };
export type EditedFile = { path: string; at: number };
export type Git = { cwd: string; branch?: string };

// What one transcript line says.
export type ActivityEvent =
  | { type: "call"; id: string; name: string; label?: string } // a Bash or Monitor call: its result names the job
  | { type: "start"; at: number; id: string; kind: JobKind; call?: string; label?: string; outputFile?: string }
  // status running: an agent waiting on background work of its own, so not done after all.
  | { type: "end"; at: number; ids: string[]; status: JobStatus; summary: string; result?: string; exit?: number; outputFile?: string }
  | { type: "stop"; at: number; id: string }
  | { type: "usage"; at: number; used: number; model?: string }
  | { type: "compact"; at: number; used?: number }
  | { type: "where"; cwd: string }
  | { type: "edit"; at: number; path: string };

// seen: the notifications already counted (status, summary, result), so a copy of one changes nothing.
type JobRecord = Job & { seen?: string[] };
// calls: tool_use id -> label, for the newest Bash/Monitor calls. tasks: the folder the jobs' output
// files are in, as Claude named it. file: the transcript, for when Claude hasn't named that folder yet.
export type Activity = {
  offset: number;
  skipping?: boolean;
  file?: string;
  calls: Map<string, string>;
  jobs: Map<string, JobRecord>;
  context?: { used: number; model?: string };
  cwd?: string;
  files: EditedFile[];
  tasks?: string;
};

export const newActivity = (): Activity => ({ offset: 0, calls: new Map(), jobs: new Map(), files: [] });

const KEEP_DONE = 30 * 60_000; // a finished job is shown this long, so the apps can say it finished
const MAX_JOBS = 100;
const MAX_CALLS = 50;
const MAX_FILES = 200;
const MAX_SEEN = 20;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");
const label = (s: string) => cut(redact(s.replace(/\s+/g, " ").trim()), 120);
const time = (r: any) => Date.parse(r?.timestamp) || 0;
const tag = (text: string, name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

// What looks like a secret in a label or an output line, taken out: the session list goes to every app.
// NAME=value where the name says key/token/secret/password, --token value, Bearer/Basic credentials,
// a password in a URL, and the shapes of common API keys.
const SECRETS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 …"],
  [/(:\/\/[^\s:@\/]+):[^\s@\/]+@/g, "$1:…@"],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, "…"],
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Za-z0-9_]*)(\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2…"],
  [/(?<!\S)(--?[A-Za-z-]*(?:token|password|secret|api-key)[A-Za-z-]*)([= ])(?!-)("[^"]*"|'[^']*'|\S+)/gi, "$1$2…"],
];
export const redact = (s: string) => SECRETS.reduce((t, [re, to]) => t.replace(re, to), s);

// Only a job's own output file, in a tasks folder: the path comes from text in the transcript.
const outputOf = (path: string | undefined, id: string) =>
  path && path.startsWith("/") && basename(path) === `${id}.output` && basename(dirname(path)) === "tasks" ? path : undefined;

// A <task-notification> that says a job ended (other Monitor events have no status: the Monitor goes on).
// One can name several jobs; Claude Code adds a pseudo id ("__orphan_summary__:shell") that isn't one.
// An agent that stopped while background work of its own runs says "completed", but "is waiting on its
// own background work": it goes on when that work reports, and notifies again.
const STATUS: Record<string, Exclude<JobStatus, "running">> = { completed: "done", failed: "failed", killed: "stopped", stopped: "stopped" };
function ending(text: string, at: number): ActivityEvent[] {
  if (!text.trimStart().startsWith("<task-notification>")) return [];
  // A Monitor that timed out says so in an event, not a status.
  const expired = /^\[Monitor expired\b/.test(tag(text, "event")?.trim() ?? "");
  const status = expired ? "stopped" : STATUS[tag(text, "status") ?? ""];
  const ids = [...text.matchAll(/<task-id>([A-Za-z0-9_-]+)<\/task-id>/g)].map((m) => m[1]);
  if (!status || !ids.length) return [];
  const summary = expired ? "expired" : (tag(text, "summary") ?? "").trim();
  const result = cut((tag(text, "result") ?? "").trim(), 200);
  const waiting = status === "done" && /\bis waiting on its own background work\b/.test(summary);
  // The last one: a command's own description may say "exit 3" too.
  const exit = [...summary.matchAll(/\bexit(?: code)? (-?\d+)/g)].at(-1)?.[1];
  const outputFile = ids.length === 1 ? outputOf(tag(text, "output-file")?.trim(), ids[0]) : undefined;
  return [{ type: "end", at, ids, status: waiting ? "running" : status, summary, ...(result && { result }), ...(exit !== undefined && !waiting && { exit: Number(exit) }), ...(outputFile && { outputFile }) }];
}

// A tool result that started background work. Which kind it is shows in its toolUseResult.
function started(r: any, block: any): ActivityEvent | undefined {
  const u = r.toolUseResult;
  if (!u || typeof u !== "object") return;
  const at = time(r);
  const call = str(block?.tool_use_id) || undefined;
  const text = typeof block?.content === "string" ? block.content : Array.isArray(block?.content) ? block.content.map((b: any) => str(b?.text)).join("\n") : "";
  if (typeof u.backgroundTaskId === "string") {
    const id = u.backgroundTaskId;
    const outputFile = outputOf(text.match(/Output is being written to: (\S+?\.output)\b/)?.[1], id);
    return { type: "start", at, id, kind: "bash", call, ...(outputFile && { outputFile }) };
  }
  if (u.status === "async_launched" && typeof u.agentId === "string") {
    const outputFile = outputOf(str(u.outputFile), u.agentId);
    return { type: "start", at, id: u.agentId, kind: "agent", call, label: str(u.description), ...(outputFile && { outputFile }) };
  }
  if (u.status === "async_launched" && typeof u.taskId === "string" && (u.taskType === "local_workflow" || u.taskId.startsWith("w")))
    return { type: "start", at, id: u.taskId, kind: "workflow", call, label: str(u.summary) || str(u.workflowName) };
  if (typeof u.taskId === "string" && ("timeoutMs" in u || "persistent" in u)) return { type: "start", at, id: u.taskId, kind: "monitor", call };
}

const EDITS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

// What a parsed line says. Only the main thread counts: a subagent's work is its own.
export function recordEvents(r: any): ActivityEvent[] {
  if (!r || typeof r !== "object" || r.isSidechain === true) return [];
  const at = time(r);
  if (r.type === "queue-operation") return r.operation === "enqueue" ? ending(str(r.content), at) : [];
  if (r.type === "attachment") return r.attachment?.type === "queued_command" ? ending(str(r.attachment.prompt), at) : [];
  const out: ActivityEvent[] = [];
  const where = (): ActivityEvent[] => (typeof r.cwd === "string" && r.cwd ? [{ type: "where", cwd: r.cwd }] : []);
  if (r.type === "system") return r.subtype === "compact_boundary" ? [...where(), { type: "compact", at, ...(typeof r.compactMetadata?.postTokens === "number" && { used: r.compactMetadata.postTokens }) }] : [];
  const c = r.message?.content;
  if (r.type === "assistant") {
    const u = r.message?.usage;
    if (u && typeof u === "object" && r.message?.model !== "<synthetic>") {
      const used = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
      out.push({ type: "usage", at, used, ...(typeof r.message.model === "string" && { model: r.message.model }) });
    }
    out.push(...where());
    for (const b of Array.isArray(c) ? c : []) {
      if (b?.type !== "tool_use" || typeof b.id !== "string") continue;
      const input = b.input ?? {};
      if (b.name === "Bash" || b.name === "Monitor") out.push({ type: "call", id: b.id, name: b.name, label: label(str(input.description) || str(input.command)) });
      else if (b.name === "TaskStop" && typeof input.task_id === "string") out.push({ type: "stop", at, id: input.task_id });
      else if (EDITS.includes(b.name)) {
        const path = str(input.file_path) || str(input.notebook_path);
        if (path) out.push({ type: "edit", at, path });
      }
    }
    return out;
  }
  if (r.type === "user") {
    out.push(...where());
    if (typeof c === "string") out.push(...ending(c, at));
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== "tool_result") continue;
        const e = started(r, b);
        if (e) out.push(e);
      }
    }
    return out;
  }
  return [];
}

// What a raw line says. A cheap substring check first: most lines (api-request copies of the whole
// conversation) say nothing here, and those copies contain every substring below, so after JSON.parse
// recordEvents still checks each line's own type.
export function lineEvents(line: string): ActivityEvent[] {
  if (line.startsWith('{"type":"api-request')) return [];
  const interesting =
    line.includes('"type":"assistant"') || line.includes("<task-notification>") || line.includes('"compact_boundary"') ||
    (line.includes('"toolUseResult"') && (line.includes('"backgroundTaskId"') || line.includes('"async_launched"') || line.includes('"taskId"')));
  if (!interesting) return [];
  try {
    return recordEvents(JSON.parse(line));
  } catch {
    return [];
  }
}

export function fold(a: Activity, events: ActivityEvent[]) {
  for (const e of events) {
    if (e.type === "call") {
      a.calls.set(e.id, e.label ?? "");
      if (a.calls.size > MAX_CALLS) a.calls.delete(a.calls.keys().next().value!);
    } else if (e.type === "start") {
      const name = e.label || (e.call && a.calls.get(e.call)) || e.kind;
      if (e.call) a.calls.delete(e.call);
      a.jobs.set(e.id, { id: e.id, kind: e.kind, label: label(name), startedAt: e.at, status: "running", ...(e.outputFile && { outputFile: e.outputFile }) });
      if (e.outputFile) a.tasks = dirname(e.outputFile);
      prune(a, e.at);
    } else if (e.type === "end") {
      // The same notification comes as a queue entry and again as a user line or attachment, minutes
      // later if Claude was busy, after newer ones: the first one says when it ended. A new one for the
      // same id (an agent waiting on its own work, or sent another message) replaces it.
      const key = `${e.status}\0${e.summary}\0${e.result ?? ""}`;
      for (const id of e.ids) {
        const j = a.jobs.get(id);
        if (!j || j.seen?.includes(key)) continue;
        j.seen = [...(j.seen ?? []), key].slice(-MAX_SEEN);
        j.status = e.status;
        if (e.status === "running") delete j.endedAt;
        else j.endedAt = e.at;
        if (e.exit !== undefined) j.exit = e.exit;
        else delete j.exit;
        if (e.outputFile) j.outputFile = e.outputFile;
      }
    } else if (e.type === "stop") {
      const j = a.jobs.get(e.id);
      if (j?.status === "running") Object.assign(j, { status: "stopped", endedAt: e.at });
    } else if (e.type === "usage") a.context = { used: e.used, model: e.model ?? a.context?.model };
    else if (e.type === "compact") a.context = { used: e.used ?? 0, model: a.context?.model };
    else if (e.type === "where") a.cwd = e.cwd;
    else if (e.type === "edit" && e.path.startsWith("/")) {
      a.files = [{ path: e.path, at: e.at }, ...a.files.filter((f) => f.path !== e.path)].slice(0, MAX_FILES);
    }
  }
}

// Jobs that ended long before the newest line are dropped, and the oldest finished ones past MAX_JOBS.
function prune(a: Activity, at: number) {
  for (const [id, j] of a.jobs) if (j.status !== "running" && (j.endedAt ?? 0) < at - KEEP_DONE) a.jobs.delete(id);
  for (const [id, j] of a.jobs) if (a.jobs.size > MAX_JOBS && j.status !== "running") a.jobs.delete(id);
}

// The context window of a model. Transcripts don't record it. GLM runs with CLAUDE_CODE_MAX_CONTEXT_TOKENS
// (kinds.ts); Claude 5 and later have 1M (Claude Code's own status line agrees), Claude 3 and 4 200k unless
// the id says [1m]. Unknown: 1M, so a new model doesn't show as fuller than it is.
export function contextLimit(model?: string, kind?: string): number {
  const m = (model ?? "").toLowerCase();
  if (kind === "claude-glm" || m.startsWith("glm")) return 1048576;
  if (m.includes("[1m]")) return 1_000_000;
  const n = m.match(/^claude-(?:(?:opus|sonnet|haiku|fable)-)?(\d+)/)?.[1];
  if (n && Number(n) < 5) return 200_000;
  return 1_000_000;
}

// The last non-empty line of some output, as a terminal shows it: colors out, and of a line a \r
// rewrote (a progress bar) only its last state.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export function lastLine(text: string): string | undefined {
  const lines = text.replace(ANSI, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const parts = lines[i].split("\r").filter((p) => p.trim());
    const l = (parts.at(-1) ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
    if (l) return cut(redact(l), 160);
  }
}

// An output file's last line, from its last 4 KB. The read happens in the background, at most every
// 10 s per file: a bash job's last line changes all the time, and a change resends the session list.
const tails = new Map<string, { read: number; line?: string }>();
export function outputTail(path: string, now = Date.now()): string | undefined {
  const t = tails.get(path);
  if (!t || now - t.read >= 10_000) {
    const next = { read: now, line: t?.line };
    tails.set(path, next);
    readTail(path).then((line) => tails.get(path) === next && (next.line = line), () => {});
  }
  return tails.get(path)!.line;
}

async function readTail(path: string): Promise<string | undefined> {
  const f = await open(path, "r");
  try {
    const size = (await f.stat()).size;
    const n = Math.min(4096, size);
    const buf = Buffer.alloc(n);
    await f.read(buf, 0, n, size - n);
    return lastLine(buf.toString("utf8"));
  } catch {
    return;
  } finally {
    await f.close();
  }
}

// Claude Code's own folder for a session's output files, when no job has named it yet: the transcript's
// project folder and session id under /tmp/claude-<uid> (on a Mac /tmp is /private/tmp, the same place).
const guessTasks = (file: string) => join("/tmp", `claude-${process.getuid!()}`, basename(dirname(file)), basename(file, ".jsonl"), "tasks");

// The jobs to show: running ones, and finished ones for 30 minutes. A Monitor's result doesn't name its
// output file; it's in the same folder as the other jobs'.
export function shownJobs(a: Activity, now = Date.now()): Job[] {
  if (a.jobs.size > MAX_JOBS / 2) prune(a, now);
  const tasks = a.tasks ?? (a.file && guessTasks(a.file));
  const out: Job[] = [];
  for (const { seen, ...j } of a.jobs.values()) {
    if (j.status !== "running" && (j.endedAt ?? 0) < now - KEEP_DONE) continue;
    if (!j.outputFile && j.kind === "monitor" && tasks) j.outputFile = join(tasks, `${j.id}.output`);
    if (j.status === "running" && (j.kind === "bash" || j.kind === "monitor") && j.outputFile) {
      const line = outputTail(j.outputFile, now);
      if (line) j.lastLine = line;
    }
    out.push(j);
  }
  return out.sort((x, y) => x.startedAt - y.startedAt);
}

// One Activity per transcript, read on from where it was. The same reading loop as transcriptTitles:
// a chunk at a time however long a line is; a line that fills a whole chunk (a huge tool output, a
// pasted image) is skipped, since nothing read here is that long. An unfinished last line waits.
const scans = new Map<string, Activity>();
const CHUNK = 16 << 20;

export function transcriptActivity(file: string, chunk = CHUNK): Activity | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return;
  }
  try {
    const size = statSync(file).size;
    let a = scans.get(file);
    if (!a || size < a.offset) scans.set(file, (a = { ...newActivity(), file })); // new, or rewritten shorter
    while (a.offset < size) {
      const buf = Buffer.alloc(Math.min(chunk, size - a.offset));
      const n = readSync(fd, buf, 0, buf.length, a.offset);
      if (n === 0) break;
      let start = 0;
      if (a.skipping) {
        const nl = buf.subarray(0, n).indexOf(10);
        if (nl < 0) {
          a.offset += n;
          continue;
        }
        start = nl + 1;
        a.skipping = false;
      }
      const end = buf.lastIndexOf(10, n - 1);
      if (end < start) {
        if (start > 0) a.offset += start;
        else if (a.offset + n < size) {
          a.skipping = true;
          a.offset += n;
        } else break; // the last line is still being written
        continue;
      }
      for (const line of buf.toString("utf8", start, end).split("\n")) fold(a, lineEvents(line));
      a.offset += end + 1;
    }
    return a;
  } finally {
    closeSync(fd);
  }
}

// The branch checked out in a folder: its repo's HEAD (a worktree's .git file names its own folder in the
// repo's .git). Detached, not a repo, or gone: none. Read at most every 10 s per folder.
const heads = new Map<string, { read: number; branch?: string }>();
export function branchOf(cwd: string, now = Date.now()): string | undefined {
  const h = heads.get(cwd);
  if (h && now - h.read < 10_000) return h.branch;
  const branch = readBranch(cwd);
  if (heads.size > 500) heads.clear();
  heads.set(cwd, { read: now, branch });
  return branch;
}

function readBranch(cwd: string): string | undefined {
  try {
    if (!statSync(cwd).isDirectory()) return;
  } catch {
    return;
  }
  for (let d = cwd; ; d = dirname(d)) {
    const dotgit = join(d, ".git");
    let isDir: boolean;
    try {
      isDir = statSync(dotgit).isDirectory();
    } catch {
      if (dirname(d) === d) return;
      continue;
    }
    try {
      const gitdir = isDir ? dotgit : resolve(d, readFileSync(dotgit, "utf8").match(/^gitdir: (.+)$/m)?.[1]?.trim() ?? "");
      return readFileSync(join(gitdir, "HEAD"), "utf8").match(/^ref: refs\/heads\/(.+)$/m)?.[1]?.trim();
    } catch {
      return;
    }
  }
}

// The files a session's Claude edited (absolute, newest first, at most 200), for the server only.
export const editedFiles = (file: string): EditedFile[] => transcriptActivity(file)?.files ?? [];

// What the session list shows of a transcript (sessions.ts): only what there is. processStart: when the
// Claude process now on it started (ms). Background work dies with the process that started it, and a
// process that exits writes nothing to say so, so what still runs from before a resume has stopped.
export function sessionActivity(file: string, kind: string, now = Date.now(), processStart?: number): { jobs?: Job[]; context?: { used: number; limit: number }; git?: Git } {
  const a = transcriptActivity(file);
  if (!a) return {};
  if (processStart) for (const j of a.jobs.values()) if (j.status === "running" && j.startedAt < processStart) Object.assign(j, { status: "stopped", endedAt: processStart });
  const jobs = shownJobs(a, now);
  const branch = a.cwd && branchOf(a.cwd, now);
  return {
    ...(jobs.length && { jobs }),
    ...(a.context && { context: { used: a.context.used, limit: contextLimit(a.context.model, kind) } }),
    ...(a.cwd && { git: { cwd: a.cwd, ...(branch && { branch }) } }),
  };
}
