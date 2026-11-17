// The connector gap (docs/superpowers/specs/2026-11-17-connector-gap-design.md): claude.ai connectors
// belong to the Claude account, so a switch can leave a session without one. blimp only reads: it asks
// Claude Code (`claude mcp list`) about the account logged in now, keeps the names and their state in
// <accounts dir>/<account id>/connectors.json, and tells the phone once when this account lacks one
// another saved account has. Never a URL, never a token.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkId, listSaved, write } from "./store";

export type Connector = { name: string; state: "ok" | "signin" | "down" };
// at: when the reading was taken. told: the gap key last told for this account (gapKey).
export type Reading = { at: number; connectors: Connector[]; told: string[] };
export type Gap = { missing: string[]; signin: string[] };

const PREFIX = "claude.ai ";

// The claude.ai connectors in what `claude mcp list` printed: lines starting `claude.ai ` with a `: `.
// The name runs to the first `: `; the state is read after the last ` - `. The user's own servers and
// every other line are ignored. A name listed twice: the first line counts.
export function parseMcpList(text: string): Connector[] {
  const list: Connector[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.startsWith(PREFIX)) continue;
    const colon = line.indexOf(": ", PREFIX.length);
    if (colon < 0) continue;
    const name = line.slice(PREFIX.length, colon);
    if (!name || list.some((c) => c.name === name)) continue;
    const dash = line.lastIndexOf(" - ");
    const tail = dash < 0 ? "" : line.slice(dash + 3);
    const state = tail.includes("Connected") && !tail.includes("Failed") ? "ok" : /needs authentication/i.test(tail) ? "signin" : "down";
    list.push({ name, state });
  }
  return list;
}

const file = (id: string, dir: string) => {
  checkId(id);
  return join(dir, id, "connectors.json");
};

const STATES = ["ok", "signin", "down"];
const isConnector = (c: unknown): c is Connector =>
  typeof (c as Connector)?.name === "string" && STATES.includes((c as Connector)?.state);

// The account's stored reading. Undefined: none, or one that can't be read. A bad told reads as [].
export function readConnectors(id: string, dir: string): Reading | undefined {
  try {
    const j = JSON.parse(readFileSync(file(id, dir), "utf8"));
    if (typeof j?.at !== "number" || !Array.isArray(j.connectors) || !j.connectors.every(isConnector)) return;
    const told = Array.isArray(j.told) && j.told.every((t: unknown) => typeof t === "string") ? j.told : [];
    return { at: j.at, connectors: j.connectors.map((c: Connector) => ({ name: c.name, state: c.state })), told };
  } catch {}
}

// 600, through a temp file and a rename (store.ts). The account's folder is not made: one forgotten
// while a reading ran gets no stray file.
export function writeConnectors(id: string, r: Reading, dir: string) {
  write(file(id, dir), JSON.stringify({ at: r.at, connectors: r.connectors, told: r.told }));
}

// What this account lacks against the others' readings: missing, connectors ok on another account and
// not here at all; signin, ones here needing a sign-in that are ok on another. One down here is
// neither: it exists, and a server being down is not the account's doing.
export function gap(mine: Connector[], others: Connector[][]): Gap {
  const okElsewhere = new Set(others.flat().filter((c) => c.state === "ok").map((c) => c.name));
  const here = new Set(mine.map((c) => c.name));
  return {
    missing: [...okElsewhere].filter((n) => !here.has(n)).sort(),
    signin: mine.filter((c) => c.state === "signin" && okElsewhere.has(c.name)).map((c) => c.name).sort(),
  };
}

// What `told` keeps: the missing names, then the sign-ins with ! in front, each sorted.
export const gapKey = (g: Gap) => [...[...g.missing].sort(), ...[...g.signin].sort().map((n) => `!${n}`)];

// The gap of a saved account's stored reading against the other saved accounts' stored readings.
// Undefined when it has no reading. Readings of accounts no longer saved are not read.
export function gapOf(id: string, dir: string): Gap | undefined {
  const mine = readConnectors(id, dir);
  if (!mine) return;
  const others = listSaved(dir)
    .filter((a) => a.id !== id)
    .map((a) => readConnectors(a.id, dir)?.connectors ?? []);
  return gap(mine.connectors, others);
}
