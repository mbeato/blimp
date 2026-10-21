// The Run bar over the top of a Claude session's terminal: the commands in Claude's latest reply (blimpd's
// runnable), each with a Run button, and once one has run, its exit code and "Send result to Claude".
// Pure, so the rules are unit tested; components/RunBar.tsx draws it.

import type { Session } from "./api";
import { isClaude } from "./sessions";

// A command, and its newest run for this session (blimpd's run sessions name the session they're for)
// since this reply began: one from an older reply with the same command would show an old result.
export type RunItem = { command: string; run?: Session };

const SHOWN = 3;

// What the bar shows for s, or null for none. hidden: the bars closed with ×, by key: a session's
// bar for one reply's commands, so the next reply with other commands shows again.
export function runBar(s: Session, sessions: Session[], hidden: string[]): { key: string; shown: RunItem[]; more: RunItem[] } | null {
  if (!isClaude(s) || !s.runnable?.length) return null;
  const key = [s.name, ...s.runnable].join("\0");
  if (hidden.includes(key)) return null;
  const items = s.runnable.map((command) => {
    const runs = sessions.filter((x) => x.run?.parent === s.name && x.run.command === command && x.run.startedAt >= (s.runnableAt ?? 0));
    const run = runs.sort((a, b) => b.run!.startedAt - a.run!.startedAt)[0];
    return { command, ...(run && { run }) };
  });
  return { key, shown: items.slice(0, SHOWN), more: items.slice(SHOWN) };
}

// A command on one line, for a button: its lines joined with ⏎.
export const oneLine = (command: string) =>
  command
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ⏎ ");
