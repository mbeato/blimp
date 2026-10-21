// One-click handoff and the context meter, for the session list. blimpd does the handoff (its
// handoff.ts): Claude writes where the work stands to a file, and a new session starts reading it.
// Here: what a row says while that happens, when the new session is ready to show, and how full a
// session's context window is.

import type { Session } from "./api";

// 950, 620k, 1M, 1.5M.
export function tokens(n: number): string {
  if (n >= 999_500) return `${Number((n / 1e6).toFixed(1))}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// A thin bar along the row's bottom edge, once the context window is half full; red from 80%, when
// it's time to hand off. width: percent of the row (at most 100).
export function contextMeter(c: Session["context"]): { width: number; high: boolean; label: string } | undefined {
  if (!c || !(c.limit > 0)) return;
  const used = c.used / c.limit;
  if (used < 0.5) return;
  const percent = Math.round(used * 100);
  return { width: Math.min(100, percent), high: used >= 0.8, label: `Context ${percent}% (${tokens(c.used)} of ${tokens(c.limit)} tokens)` };
}

// What the row says instead of its state: "Writing handoff…" while Claude writes it, "Handed off" once
// the new session started and this one is idle. A question for you still says so.
export function handoffWords(s: Session): string | undefined {
  if (!s.handoff || s.state === "waiting") return;
  if (s.handoff.state === "writing") return "Writing handoff…";
  if (s.handoff.state === "started" && s.state !== "working") return "Handed off";
}

// Handoffs asked for in this window, by parent: whether it has been seen being written yet (until
// then, a result in the list is an older handoff's). Returns the ones that just started (to show the
// new session) or failed (to say why), and stops watching them, and any whose session ended.
export function handoffNews(watching: Map<string, boolean>, sessions: Session[]): { parent: string; child?: string; error?: string }[] {
  const out: { parent: string; child?: string; error?: string }[] = [];
  for (const [parent, written] of watching) {
    const h = sessions.find((s) => s.name === parent)?.handoff;
    if (!sessions.some((s) => s.name === parent)) watching.delete(parent);
    else if (h?.state === "writing") watching.set(parent, true);
    else if (written && h?.state === "started" && h.child) out.push({ parent, child: h.child });
    else if (written && h?.state === "failed") out.push({ parent, error: h.error ?? "The handoff failed" });
  }
  for (const n of out) watching.delete(n.parent);
  return out;
}
