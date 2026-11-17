// The connector gap (docs/superpowers/specs/2026-11-17-connector-gap-design.md): claude.ai connectors
// belong to the Claude account, so a switch can leave a session without one. blimp only reads: it asks
// Claude Code (`claude mcp list`) about the account logged in now, keeps the names and their state in
// <accounts dir>/<account id>/connectors.json, and tells the phone once when this account lacks one
// another saved account has. Never a URL, never a token.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginShell } from "../sessions";
import { CONNECTORS_AFTER_SWITCH_MS, CONNECTORS_EVERY_MS, CONNECTORS_RETRY_MS, CONNECTORS_TIMEOUT_MS, CONNECTORS_ZERO_AGAIN_MS } from "./rules";
import { checkId, listSaved, liveMtime, readState, type Saved, type State, write } from "./store";

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

// The live list: `claude mcp list` run the way sessions start Claude Code (sessions.ts start, kinds.ts),
// through the login shell, so it is the same claude on the same PATH; in blimpd's own environment, so a
// CLAUDE_CONFIG_DIR it runs with applies. In the temp folder, stdin closed, stdout kept. Undefined on a
// non-zero exit, no such shell, or a kill after the time limit: a hung profile or claude, or a child
// still holding stdout, can't keep a reading running for ever.
export async function mcpList(shell = loginShell(), limit = CONNECTORS_TIMEOUT_MS): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = Bun.spawn([shell, "-l", "-i", "-c", 'exec claude "$@"', "claude", "mcp", "list"], { cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const killed = new Promise<undefined>((r) => {
      timer = setTimeout(() => {
        p.kill("SIGKILL");
        r(undefined);
      }, limit);
    });
    const text = await Promise.race([new Response(p.stdout).text(), killed]);
    const code = await Promise.race([p.exited, killed]);
    return text !== undefined && code === 0 ? text : undefined;
  } catch {
    return undefined; // no such shell
  } finally {
    clearTimeout(timer);
  }
}

// What the phone is told: `No A, B.` for the missing ones, `C needs a sign-in.` for the others.
const gapText = (g: Gap) =>
  [g.missing.length && `No ${g.missing.join(", ")}.`, g.signin.length && `${g.signin.join(", ")} needs a sign-in.`].filter(Boolean).join(" ");
// The line under an account in `blimpd accounts`: either half alone when the other is empty.
export const gapLine = (g: Gap) =>
  [g.missing.length && `no ${g.missing.join(", ")}`, g.signin.length && `${g.signin.join(", ")} needs a sign-in`].filter(Boolean).join("; ");

// running: a reading is under way. until: a failed reading, or a first zero, asks to wait till then.
export type Due = { state: State; saved: Saved[]; mtime: number | undefined; reading: Reading | undefined; running: boolean; until?: number };

// Whether to ask now about the account in use. Only about a login blimp knows is that account's (filed,
// not unknown) and one that has settled after a switch; then when its reading is missing, from before
// the switch, or a day old. With one saved account there is nothing to compare.
export function readingDue(d: Due, now: number): boolean {
  const s = d.state;
  if (d.saved.length < 2 || !s.active || !d.saved.some((a) => a.id === s.active)) return false;
  if (s.unknown || d.mtime === undefined || d.mtime !== s.filed?.mtime) return false;
  if (s.switchedAt !== undefined && now - s.switchedAt < CONNECTORS_AFTER_SWITCH_MS) return false;
  if (d.running || (d.until !== undefined && now < d.until)) return false;
  const r = d.reading;
  return !r || (s.switchedAt !== undefined && r.at < s.switchedAt) || now - r.at > CONNECTORS_EVERY_MS;
}

export type ConnectorsDeps = {
  dir: string; // the accounts folder
  live: string; // the live login file
  list: () => Promise<string | undefined>; // what `claude mcp list` printed; undefined: it failed
  tell: (title: string, body: string) => Promise<void>;
  log: (entry: Record<string, unknown>) => void; // one line of accounts/log.jsonl
  now: () => number;
};

// Takes a reading of the account in use when one is due (readingDue), stores it and tells a new gap.
// What only this process has seen stays in memory: a reading running, a wait asked for, a first zero.
export class Connectors {
  private running = false;
  private until?: number;
  private zero?: { id: string; at: number }; // a reading with no connector, not yet believed

  constructor(private deps: ConnectorsDeps) {}

  // Called after each tick of the account loop. Never throws.
  async tick(): Promise<void> {
    if (this.running) return;
    const { dir, live } = this.deps;
    const at = this.deps.now();
    const state = readState(dir);
    const saved = listSaved(dir, state);
    const id = state.active;
    const reading = id && saved.some((a) => a.id === id) ? readConnectors(id, dir) : undefined;
    if (!readingDue({ state, saved, mtime: liveMtime(live), reading, running: this.running, until: this.until }, at)) return;
    this.running = true;
    try {
      await this.take(id!, at);
    } catch (e) {
      this.failed(id!, (e as Error)?.message ?? String(e));
    } finally {
      this.running = false;
    }
  }

  private failed(id: string, error?: string) {
    this.until = this.deps.now() + CONNECTORS_RETRY_MS;
    this.deps.log({ event: "connectors-failed", account: id, ...(error && { error }) });
  }

  private async take(id: string, at: number) {
    const { dir, live } = this.deps;
    const text = await this.deps.list();
    // The account may have changed while the command ran: then the reading may be of either one.
    const after = readState(dir);
    const m = liveMtime(live);
    if (after.active !== id || after.unknown || m === undefined || m !== after.filed?.mtime) return;
    if (text === undefined || !text.includes("Checking MCP server health")) return this.failed(id);
    this.until = undefined;
    const connectors = parseMcpList(text);
    // claude.ai not answering might print no connector at all, so a zero is believed only when
    // another one at least a minute later, and within ten, says the same.
    if (!connectors.length) {
      const z = this.zero;
      if (!z || z.id !== id || at - z.at < CONNECTORS_ZERO_AGAIN_MS || at - z.at > CONNECTORS_RETRY_MS) {
        this.zero = { id, at };
        this.until = this.deps.now() + CONNECTORS_ZERO_AGAIN_MS;
        return;
      }
    }
    this.zero = undefined;
    const r: Reading = { at, connectors, told: readConnectors(id, dir)?.told ?? [] };
    writeConnectors(id, r, dir);

    // A gap is told once: the same one again says nothing, an empty one clears what was told.
    const g = gapOf(id, dir)!;
    const key = gapKey(g);
    if (!key.length) {
      if (r.told.length) writeConnectors(id, { ...r, told: [] }, dir);
      return;
    }
    if (key.length === r.told.length && key.every((k, i) => k === r.told[i])) return;
    const who = listSaved(dir).find((a) => a.id === id);
    let error: string | undefined;
    try {
      await this.deps.tell(`${who?.email || id} is missing connectors`, `${gapText(g)} Add them at claude.ai/customize/connectors.`);
      writeConnectors(id, { ...r, told: key }, dir);
    } catch (e) {
      error = (e as Error)?.message ?? String(e); // told stays, so the next reading tries again
    }
    this.deps.log({ event: "connector-gap", account: id, missing: g.missing, signin: g.signin, ...(error && { error }) });
  }
}
