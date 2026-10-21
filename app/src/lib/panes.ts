// The terminal's splits, as VS Code's terminal groups work: the group on screen (sessions side by
// side, left to right, one of them focused), and the split groups kept while another session is
// on screen. Each session is in at most one group. Pure, so the rules are unit tested.

// groups: split groups not on screen now, each of two or more sessions.
// order: the session list's order, once its rows have been dragged (names, top to bottom).
export type Panes = { panes: string[]; focus: number; groups: string[][]; order?: string[] };
export type Side = "left" | "right";

const clampFocus = (panes: string[], focus: number) => Math.max(0, Math.min(focus, panes.length - 1));
const at = (p: Panes, panes: string[], focus: number, groups = p.groups, order = p.order): Panes => ({ panes, focus: clampFocus(panes, focus), groups, ...(order && { order }) });

// Kept groups without these sessions; a group left with one session is no group.
const without = (groups: string[][], names: string[]) => groups.map((g) => g.filter((n) => !names.includes(n))).filter((g) => g.length > 1);

// A click in the session list. A session on screen gets the focus; one in a kept group brings its
// whole group back; any other shows on its own. The group on screen, if it's a split, is kept.
export function show(p: Panes, name: string): Panes {
  const i = p.panes.indexOf(name);
  if (i >= 0) return at(p, p.panes, i);
  const kept = p.panes.length > 1 ? [p.panes] : [];
  const g = p.groups.find((x) => x.includes(name));
  if (g) return at(p, g, g.indexOf(name), [...p.groups.filter((x) => x !== g), ...kept]);
  return at(p, [name], 0, [...p.groups, ...kept]);
}

// A session dropped on one side of split `target`: a new split there, focused. A session that is
// already shown moves, so no session is ever on screen twice; one from a kept group leaves it.
export function dropAt(p: Panes, name: string, target: number, side: Side): Panes {
  const groups = without(p.groups, [name]);
  if (!p.panes.length) return at(p, [name], 0, groups);
  const from = p.panes.indexOf(name);
  const rest = p.panes.filter((n) => n !== name);
  let i = target + (side === "right" ? 1 : 0);
  if (from >= 0 && from < i) i--;
  const panes = [...rest.slice(0, i), name, ...rest.slice(i)];
  if (panes.every((n, j) => n === p.panes[j]) && groups.length === p.groups.length) return p;
  return at(p, panes, i, groups);
}

// Closing split i (the session keeps running, on its own again). The focus stays on the session
// it was on.
export function removePane(p: Panes, i: number): Panes {
  const panes = p.panes.filter((_, j) => j !== i);
  return at(p, panes, p.focus > i ? p.focus - 1 : p.focus);
}

// Unsplit, from a session's right-click: its split's sessions are each on their own again. The
// split on screen leaves `name` there alone; a kept group just comes apart.
export function unsplit(p: Panes, name: string): Panes {
  if (p.panes.length > 1 && p.panes.includes(name)) return at(p, [name], 0);
  const g = p.groups.find((x) => x.includes(name));
  return g ? at(p, p.panes, p.focus, p.groups.filter((x) => x !== g)) : p;
}

// Sessions gone from this window (moved to another): out of the splits and the kept groups.
export function forget(p: Panes, names: string[]): Panes {
  if (!p.panes.some((n) => names.includes(n)) && !p.groups.some((g) => g.some((n) => names.includes(n)))) return p;
  const focused = p.panes[p.focus];
  const panes = p.panes.filter((n) => !names.includes(n));
  const f = panes.indexOf(focused);
  return at(p, panes, f >= 0 ? f : p.focus, without(p.groups, names));
}

// Drops ended sessions: from the splits on screen, the kept groups and the list's order.
export function prune(p: Panes, alive: (name: string) => boolean): Panes {
  if (p.panes.every(alive) && p.groups.every((g) => g.every(alive)) && (p.order ?? []).every(alive)) return p;
  const focused = p.panes[p.focus];
  const panes = p.panes.filter(alive);
  const f = panes.indexOf(focused);
  return at(p, panes, f >= 0 ? f : p.focus, p.groups.map((g) => g.filter(alive)).filter((g) => g.length > 1), p.order?.filter(alive));
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
