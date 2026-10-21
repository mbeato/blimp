// Background work Claude started (blimpd sends it as Session.jobs): what a session's row says about it,
// the words in its jobs popover, and a Mac notification when a job finishes. Max wants to know a
// build finished even while he looks at its session, so unlike a wait this is announced when the
// session is on screen too; only not while this window has focus and its jobs popover is open.

import type { Job, Session } from "./api";
import type { NotifyFn } from "./waiting";
import { tildify } from "./sessions";

// A finished job is mentioned this long (blimpd keeps them as long).
const RECENT = 30 * 60_000;

export const KIND_WORD: Record<Job["kind"], string> = { bash: "Command", monitor: "Monitor", agent: "Agent", workflow: "Workflow" };

// The row's words: how many jobs run, else "job done" for 30 minutes after one finished. A stopped one
// isn't news (Claude or a restart stopped it), so it's left out.
export function jobsWords(jobs: Job[] | undefined, now = Date.now()): string {
  const n = jobs?.filter((j) => j.status === "running").length ?? 0;
  if (n) return n === 1 ? "1 job" : `${n} jobs`;
  return jobs?.some((j) => (j.status === "done" || j.status === "failed") && now - (j.endedAt ?? 0) < RECENT) ? "job done" : "";
}

// How long something has run: "<1m", "12m", "1h 5m", "2d".
export function duration(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const ended = (j: Job) => (j.exit !== undefined ? `${j.status} · exit ${j.exit}` : j.status);

// A job's line in the popover: how long it has run, or how it ended.
export const jobState = (j: Job, now = Date.now()) => (j.status === "running" ? duration(now - j.startedAt) : ended(j));

// The notification for a job that finished.
export function jobNotice(j: Job, s: Session, home: string): { title: string; body: string } {
  const what = j.label || KIND_WORD[j.kind];
  const title = j.status === "failed" ? `${what} failed${j.exit !== undefined ? `, exit ${j.exit}` : ""}` : `${what} finished`;
  return { title, body: `${s.title} · ${tildify(s.dir, home)}` };
}

// The session ("<server key>/<session name>") whose jobs popover this window has open, while it's open.
export const jobsOpen: { current: string | null } = { current: null };

// Remembers each server's job states and notifies when one goes from running to done or failed. Like
// WaitWatcher, the first list from a server only records them. id.session is the job's own key, not the
// session's: claim_notice (Rust) skips sessions on screen in a focused window, and a job isn't one.
// id.wait has when it ended, so each window announces it once, and an agent that ends again does again.
// quiet(session): this window has focus and that session's jobs popover open.
export class JobWatcher {
  private last = new Map<string, Map<string, Job["status"]>>();

  constructor(
    private notify: NotifyFn,
    private quiet: (session: string) => boolean,
  ) {}

  update(server: string, home: string, sessions: Session[]) {
    const prev = this.last.get(server);
    this.last.set(server, new Map(sessions.flatMap((s) => (s.jobs ?? []).map((j) => [`${s.name}/${j.id}`, j.status] as const))));
    if (!prev) return;
    for (const s of sessions) {
      const session = `${server}/${s.name}`;
      for (const j of s.jobs ?? []) {
        if ((j.status !== "done" && j.status !== "failed") || prev.get(`${s.name}/${j.id}`) !== "running") continue;
        if (this.quiet(session)) continue;
        const n = jobNotice(j, s, home);
        this.notify(n.title, n.body, { session: `${session}/${j.id}`, wait: `${session}/${j.id}/${j.endedAt ?? ""}` });
      }
    }
  }
}
