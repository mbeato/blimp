// The assistant's job updates (docs/superpowers/specs/2026-10-26-assistant-design.md, section 3). When one of its jobs
// (jobs.ts) ends a turn after the assistant last acted on it, blimpd tells the assistant in one line: a wait at once,
// a finished turn once there's a note for it (notes.ts) or after 30 s without one. Lines wait 10 s from the first for
// others, then go as one message, typed into the assistant like `blimpd send`, never while it asks something. They
// are kept in memory only; the jobs file's `reported` keeps a restart from telling a turn twice. An update never makes
// or changes a job, and the assistant is never told about itself.

import { basename } from "node:path";
import { ASSISTANT, assistantOn } from "./assistant";
import { dropEnded, type Jobs, markReported, readJobs } from "./jobs";
import type { ShownNote } from "./notes";
import { asks } from "./overview";
import { claudeDir, listSessionsLite, type Session, zmxListAsync } from "./sessions";
import { Asking, typeInto } from "./typing";

export const NOTE_WAIT = 30_000;
export const BATCH = 10_000;

// A job's turn that ended at `end` (its stateSince), first seen at `noticed`.
export type Pending = { session: string; end: number; noticed: number };
export type Line = { session: string; end: number; text: string };

// note: the turn's own note, if there is one yet.
export function reportLine(s: Session, reason: string, note?: ShownNote): string {
  const waiting = s.state === "waiting";
  const status = waiting || note?.status === "question" ? "needs you" : note?.status === "progress" ? "still working" : "done";
  const words = waiting ? s.prompt && asks(s.prompt) : note?.text;
  return `[blimp job update] ${basename(s.dir)} · ${reason} (${s.name}): ${status}${words ? ` — ${words}` : ""}`;
}

// One look at the jobs' sessions: turns that ended since their job was acted on and last told become pending; pending
// ones become lines (a wait at once, else with that turn's note or after 30 s), or go if the job moved on or ended.
export function jobStep(jobs: Jobs, list: Session[], pending: Pending[], now: number): { pending: Pending[]; lines: Line[] } {
  const all = [...pending];
  for (const s of list) {
    const job = jobs[s.name];
    if (!job || s.name === ASSISTANT || (s.state !== "done" && s.state !== "waiting") || !s.stateSince) continue;
    if (s.stateSince > Math.max(job.at, job.reported ?? 0) && !all.some((p) => p.session === s.name && p.end === s.stateSince))
      all.push({ session: s.name, end: s.stateSince, noticed: now });
  }
  const next: Pending[] = [];
  const lines: Line[] = [];
  for (const p of all) {
    const s = list.find((x) => x.name === p.session);
    const job = jobs[p.session];
    if (!s || !job || p.session === ASSISTANT || s.stateSince !== p.end) continue;
    const note = s.note && s.note.at >= p.end ? s.note : undefined;
    if (s.state === "waiting" || note || now - p.noticed >= NOTE_WAIT) lines.push({ session: p.session, end: p.end, text: reportLine(s, job.reason, note) });
    else next.push(p);
  }
  return { pending: next, lines };
}

export type ReportDeps = {
  on: () => boolean;
  jobs: () => Jobs;
  sessions: () => Promise<Session[]>;
  reported: (name: string, end: number) => void;
  drop: (live: string[]) => void;
  // Into the assistant; throws Asking while it asks something.
  type: (text: string) => Promise<void>;
  now: () => number;
  log: (m: string) => void;
};

export class Reporter {
  private pending: Pending[] = [];
  private outbox: { text: string; at: number }[] = [];
  private busy = false;
  private failing = false;
  // When an update was last typed into the assistant: the push rule tells the user about the turn it begins.
  lastTyped?: number;

  constructor(private deps: ReportDeps) {}

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.deps.on()) {
        this.pending = [];
        this.outbox = [];
        return;
      }
      const jobs = this.deps.jobs();
      if (!Object.keys(jobs).length && !this.pending.length && !this.outbox.length) return;
      const now = this.deps.now();
      const list = await this.deps.sessions();
      this.deps.drop(list.map((s) => s.name));
      const step = jobStep(jobs, list, this.pending, now);
      this.pending = step.pending;
      for (const l of step.lines) {
        this.deps.reported(l.session, l.end);
        this.outbox.push({ text: l.text, at: now });
      }
      const assistant = list.find((s) => s.name === ASSISTANT);
      if (!this.outbox.length || now - this.outbox[0].at < BATCH || !assistant || assistant.state === "waiting") return;
      try {
        await this.deps.type(this.outbox.map((o) => o.text).join("\n"));
        this.outbox = [];
        this.failing = false;
        this.lastTyped = this.deps.now();
      } catch (e) {
        if (e instanceof Asking) return;
        if (!this.failing) this.deps.log(`assistant: couldn't type a job update into it (${(e as Error).message}); trying again`);
        this.failing = true;
      }
    } catch (e) {
      this.deps.log(`assistant: job updates: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}

const reporter = new Reporter({
  on: () => assistantOn(),
  jobs: () => readJobs(),
  sessions: async () => listSessionsLite(claudeDir(), await zmxListAsync()),
  reported: (name, end) => markReported(name, end),
  drop: (live) => dropEnded(live),
  type: (text) => typeInto(ASSISTANT, text, { enter: true }),
  now: Date.now,
  log: (m) => console.log(m),
});

export const lastReportTyped = () => reporter.lastTyped;

// Every 2 s; it reads nothing while the assistant is off or has no jobs.
export function startReports(every = 2000) {
  setInterval(() => void reporter.tick(), every);
}
