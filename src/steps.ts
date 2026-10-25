// The followed turn's steps (docs/superpowers/specs/2026-10-26-phone-live-activity-design.md, "Steps"), read from its
// transcript as activity.ts reads jobs (Claude Code's internal format, so checked against captured real lines in
// test/steps.test.ts): TaskCreate adds a step (its id is only in the result: toolUseResult.task), TaskUpdate changes
// one's status or words (its input: taskId, status, subject, activeForm; status "deleted" takes it out), and older
// versions' TodoWrite gives the whole list each time. A TaskCreate once every step is completed starts a new list.
// Only the main thread counts: a subagent's list is its own. Read once, then only the lines added since.

import { closeSync, openSync, readSync, statSync } from "node:fs";

export type StepStatus = "pending" | "in_progress" | "completed";
type Step = { id: string; subject: string; status: StepStatus; active?: string };
export type StepEvent =
  | { type: "create"; at: number; id: string; subject: string }
  | { type: "update"; at: number; id: string; status?: StepStatus | "deleted"; subject?: string; active?: string }
  | { type: "todos"; at: number; steps: Step[] };
// at: when the list last changed (ms).
export type StepScan = { offset: number; skipping?: boolean; steps: Step[]; at: number };
// What the panel shows: done of total, and the step in progress in Claude's words (its activeForm, else its subject).
export type Steps = { done: number; total: number; current?: string };

export const newStepScan = (): StepScan => ({ offset: 0, steps: [], at: 0 });

const MAX_STEPS = 100;
const STATUSES: string[] = ["pending", "in_progress", "completed"];
const isStatus = (v: unknown): v is StepStatus => typeof v === "string" && STATUSES.includes(v);
const time = (r: any) => Date.parse(r?.timestamp) || 0;
const cut = (s: string, n: number) => Array.from(s).slice(0, n).join("");

// What a parsed line says.
export function recordSteps(r: any): StepEvent[] {
  if (!r || typeof r !== "object" || r.isSidechain === true) return [];
  const at = time(r);
  const task = r.type === "user" ? r.toolUseResult?.task : undefined;
  if (task && typeof task.id === "string" && typeof task.subject === "string") return [{ type: "create", at, id: task.id, subject: task.subject }];
  if (r.type !== "assistant" || !Array.isArray(r.message?.content)) return [];
  const out: StepEvent[] = [];
  for (const b of r.message.content) {
    const i = b?.type === "tool_use" ? b.input : undefined;
    if (!i || typeof i !== "object") continue;
    if (b.name === "TaskUpdate" && typeof i.taskId === "string")
      out.push({
        type: "update",
        at,
        id: i.taskId,
        ...((isStatus(i.status) || i.status === "deleted") && { status: i.status }),
        ...(typeof i.subject === "string" && { subject: i.subject }),
        ...(typeof i.activeForm === "string" && { active: i.activeForm }),
      });
    if (b.name === "TodoWrite" && Array.isArray(i.todos))
      out.push({
        type: "todos",
        at,
        steps: i.todos
          .filter((t: any) => typeof t?.content === "string" && isStatus(t?.status))
          .map((t: any, n: number) => ({ id: String(n), subject: t.content, status: t.status, ...(typeof t.activeForm === "string" && { active: t.activeForm }) })),
      });
  }
  return out;
}

// Most lines say nothing here (api-request lines are most of a transcript), so a quick look first.
export function lineSteps(line: string): StepEvent[] {
  if (line.startsWith('{"type":"api-request')) return [];
  if (!line.includes('"toolUseResult":{"task":{') && !line.includes('"name":"TaskUpdate"') && !line.includes('"name":"TodoWrite"')) return [];
  try {
    return recordSteps(JSON.parse(line));
  } catch {
    return [];
  }
}

export function foldSteps(s: StepScan, events: StepEvent[]) {
  for (const e of events) {
    if (e.type === "create") {
      if (s.steps.every((x) => x.status === "completed")) s.steps = [];
      s.steps = [...s.steps.filter((x) => x.id !== e.id), { id: e.id, subject: e.subject, status: "pending" as const }].slice(-MAX_STEPS);
    } else if (e.type === "update") {
      const x = s.steps.find((y) => y.id === e.id);
      if (!x) continue;
      if (e.status === "deleted") s.steps = s.steps.filter((y) => y !== x);
      else {
        if (e.status) x.status = e.status;
        if (e.subject !== undefined) x.subject = e.subject;
        if (e.active !== undefined) x.active = e.active;
      }
    } else s.steps = e.steps.slice(0, MAX_STEPS);
    s.at = e.at;
  }
}

// None: no task list (or an empty one).
export function shownSteps(s: StepScan): Steps | undefined {
  if (!s.steps.length) return;
  const now = s.steps.find((x) => x.status === "in_progress");
  const current = now && (now.active || now.subject).replace(/\s+/g, " ").trim();
  return { done: s.steps.filter((x) => x.status === "completed").length, total: s.steps.length, ...(current && { current: cut(current, 80) }) };
}

// As transcriptActivity (activity.ts) reads: a chunk at a time, a line that fills a whole chunk skipped, an unfinished
// last line left for next time. Only the followed session's transcript is read, so a few scans are kept.
const scans = new Map<string, StepScan>();
const CHUNK = 16 << 20;

export function transcriptSteps(file: string, chunk = CHUNK): { steps?: Steps; at: number } | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return;
  }
  try {
    const size = statSync(file).size;
    let s = scans.get(file);
    if (!s || size < s.offset) {
      if (scans.size >= 10) scans.clear();
      scans.set(file, (s = newStepScan())); // new, or rewritten shorter
    }
    while (s.offset < size) {
      const buf = Buffer.alloc(Math.min(chunk, size - s.offset));
      const n = readSync(fd, buf, 0, buf.length, s.offset);
      if (n === 0) break;
      let start = 0;
      if (s.skipping) {
        const nl = buf.subarray(0, n).indexOf(10);
        if (nl < 0) {
          s.offset += n;
          continue;
        }
        start = nl + 1;
        s.skipping = false;
      }
      const end = buf.lastIndexOf(10, n - 1);
      if (end < start) {
        if (start > 0) s.offset += start;
        else if (s.offset + n < size) {
          s.skipping = true;
          s.offset += n;
        } else break; // the last line is still being written
        continue;
      }
      for (const line of buf.toString("utf8", start, end).split("\n")) foldSteps(s, lineSteps(line));
      s.offset += end + 1;
    }
    return { steps: shownSteps(s), at: s.at };
  } finally {
    closeSync(fd);
  }
}
