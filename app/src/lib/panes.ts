// The terminal's splits: sessions side by side, left to right, one of them focused. Pure, so the
// rules for clicking, dropping and closing are unit tested.

export type Panes = { panes: string[]; focus: number };
export type Side = "left" | "right";

const at = (panes: string[], focus: number): Panes => ({ panes, focus: Math.max(0, Math.min(focus, panes.length - 1)) });

// A click in the session list: focus the split already showing it, else show it in the focused one.
export function show(p: Panes, name: string): Panes {
  const i = p.panes.indexOf(name);
  if (i >= 0) return at(p.panes, i);
  if (!p.panes.length) return at([name], 0);
  return at(p.panes.map((n, j) => (j === p.focus ? name : n)), p.focus);
}

// A session dropped on one side of split `target`: a new split there, focused. A session that is
// already shown moves, so no session is ever on screen twice.
export function dropAt(p: Panes, name: string, target: number, side: Side): Panes {
  if (!p.panes.length) return at([name], 0);
  const from = p.panes.indexOf(name);
  const rest = p.panes.filter((n) => n !== name);
  let i = target + (side === "right" ? 1 : 0);
  if (from >= 0 && from < i) i--;
  const panes = [...rest.slice(0, i), name, ...rest.slice(i)];
  if (panes.every((n, j) => n === p.panes[j])) return p;
  return at(panes, i);
}

// Closing split i (the session keeps running). The focus stays on the session it was on.
export function removePane(p: Panes, i: number): Panes {
  const panes = p.panes.filter((_, j) => j !== i);
  return at(panes, p.focus > i ? p.focus - 1 : p.focus);
}

// Drops the splits whose session has ended.
export function prune(p: Panes, alive: (name: string) => boolean): Panes {
  if (p.panes.every(alive)) return p;
  const focused = p.panes[p.focus];
  const panes = p.panes.filter(alive);
  const f = panes.indexOf(focused);
  return at(panes, f >= 0 ? f : p.focus);
}

// Where a drop at x (0..1 across the terminal) lands: which split, and which half of it.
export function dropTarget(shares: number[], x: number): { at: number; side: Side } {
  let left = 0;
  for (let i = 0; i < shares.length; i++) {
    const right = left + shares[i];
    if (x < right || i === shares.length - 1) return { at: i, side: x < left + shares[i] / 2 ? "left" : "right" };
    left = right;
  }
  return { at: 0, side: "left" };
}

export const equalShares = (n: number) => Array.from({ length: n }, () => 1 / n);

// Drags the line between split i and i+1 to x (0..1). Only those two change size; neither goes
// under min.
export function moveDivider(shares: number[], i: number, x: number, min: number): number[] {
  const start = shares.slice(0, i).reduce((a, b) => a + b, 0);
  const pair = shares[i] + shares[i + 1];
  const a = Math.max(min, Math.min(pair - min, x - start));
  return shares.map((s, j) => (j === i ? a : j === i + 1 ? pair - a : s));
}
