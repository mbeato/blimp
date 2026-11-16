// The switcher (docs/superpowers/specs/2026-11-16-account-switching-design.md, "Saving", "Switching" and
// "By hand"): once a second it files a change to the live login file, and when a session stops on the
// limit it marks the account out, puts the next saved login in place, types "continue" into the sessions
// that stopped on the limit, and tells the phone. state.json is read from disk every time, because
// `blimpd account use` in another process can swap the login too. Only what this process has already
// seen or done stays in memory. A login is a secret: the log gets ids, emails, times and the hook's
// error text, never anything read from a credentials file.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_KINDS } from "../kinds";
import { parseScreenOptions } from "../prompt";
import { apnsFor } from "../push/watch";
import { readCreds, readDevices } from "../push/store";
import { blimpDir, claudeDir, isSafeName, listSessionsLite, zmxEnv, zmxListAsync, zmxPath } from "../sessions";
import { typeInto } from "../typing";
import { FILE_AFTER_MS, filing, nextAccount, OUT_ERRORS, OUT_MS, QUIET_MS } from "./rules";
import { accountsDir, listSaved, liveFile, liveMtime, putLive, type Rec, readRecord, readState, saveLogin, type State, writeState } from "./store";

export type Stop = { session: string; at: number; error: string; details?: string; message?: string };
export type SwitcherDeps = {
  dir: string; // the accounts folder
  live: string; // the live login file
  record: () => Rec | undefined; // oauthAccount now
  stops: () => Promise<Stop[]>; // running Claude sessions whose latest hook event is a StopFailure
  menu: (session: string) => boolean; // its screen shows a list of choices
  type: (session: string) => Promise<void>; // types "continue" and Enter; throws if it couldn't
  tell: (title: string, body: string) => Promise<void>;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (entry: Record<string, unknown>) => void; // one line of accounts/log.jsonl
};

export const CONTINUE_AFTER_MS = 3000; // a session that just stopped gets a moment before "continue"

const plural = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

export class Switcher {
  private seen?: number; // when an unfiled change to the live file was first seen
  // A stop is a session and its `at`. Each is logged once, goes through "Switch?" once (else a session
  // left stopped while every account is out would mark the account out again every second), and gets
  // "continue" at most once.
  private logged = new Map<string, number>();
  private asked = new Map<string, number>();
  private continued = new Map<string, number>();
  private toldOutFor?: number; // switchedAt when "every account is out" was last told
  private busy = false;

  constructor(
    private deps: SwitcherDeps,
    private started = deps.now(),
  ) {}

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // The stops first: from here to the state written after a switch nothing waits, so a `use` in this
      // process can't land between reading the state and writing it.
      const stops = await this.deps.stops();
      const now = this.deps.now();
      const state = readState(this.deps.dir);

      const m = liveMtime(this.deps.live);
      if (m === undefined || m === state.filed?.mtime) this.seen = undefined;
      else if (now - (this.seen ??= now) >= FILE_AFTER_MS) this.file(state);

      for (const s of stops)
        if (this.logged.get(s.session) !== s.at) {
          this.logged.set(s.session, s.at);
          this.deps.log({ event: "stop", session: s.session, error: s.error, details: s.details, message: s.message, account: state.active });
        }
      const out = stops.filter((s) => OUT_ERRORS.includes(s.error));

      // A limit stop in the quiet time after a switch left before it, and one from before blimpd
      // started is a stale status file: neither asks for a switch.
      const asking = out.filter((s) => this.asked.get(s.session) !== s.at && s.at > (state.switchedAt ?? 0) + QUIET_MS && s.at >= this.started);
      let switched: { from: string; to: string } | undefined;
      if (asking.length) {
        this.file(state);
        const from = state.active;
        if (from) state.out[from] = { at: now, until: now + OUT_MS };
        const saved = listSaved(this.deps.dir, state);
        const next = nextAccount(saved, state, now);
        if (next) {
          const mtime = putLive(next.id, this.deps.live, this.deps.dir);
          state.active = next.id;
          state.switchedAt = now;
          state.filed = { mtime, record: state.filed?.record ?? "" };
        }
        writeState(state, this.deps.dir);
        for (const s of asking) this.asked.set(s.session, s.at);
        if (!next) {
          if (this.toldOutFor !== (state.switchedAt ?? 0)) {
            this.toldOutFor = state.switchedAt ?? 0;
            await this.deps.tell("Every Claude account is out", "blimp will switch when one is back.");
          }
          return;
        }
        this.deps.log({ event: "switch", from, to: next.id });
        switched = { from: saved.find((a) => a.id === from)?.email || "The last account", to: next.email };
      }

      // After a switch, every limit stop; otherwise only one that came in the quiet time after the last.
      const sw = state.switchedAt;
      const due = out.filter((s) => this.continued.get(s.session) !== s.at && (switched || (sw !== undefined && sw < s.at && s.at <= sw + QUIET_MS)));
      let done = 0;
      let left = 0;
      if (due.length) {
        await this.deps.wait(CONTINUE_AFTER_MS);
        for (const s of due) {
          this.continued.set(s.session, s.at); // tried once, whatever happens
          if (this.deps.menu(s.session)) {
            left++;
            continue;
          }
          try {
            await this.deps.type(s.session);
            done++;
          } catch (e) {
            left++;
            this.deps.log({ event: "not continued", session: s.session, error: (e as Error).message });
          }
        }
      }

      if (switched) {
        const body = done || left ? `${plural(done)} continued.${left ? ` ${left} left as they were.` : ""}` : "No session was waiting on it.";
        await this.deps.tell(`Now on ${switched.to}`, `${switched.from} ran out. ${body}`);
      }
    } catch (e) {
      this.deps.log({ event: "error", error: (e as Error).message });
    } finally {
      this.busy = false;
    }
  }

  // By hand (`blimpd account use`): file, swap, tell. Nothing is marked out and nobody gets "continue".
  async use(id: string): Promise<void> {
    const now = this.deps.now();
    const state = readState(this.deps.dir);
    const to = listSaved(this.deps.dir, state).find((a) => a.id === id);
    if (!to) throw new Error("no saved login for that account");
    if ((to.expires ?? Infinity) <= now) throw new Error("that account's login has expired; log in to it again with /login");
    this.file(state);
    const from = state.active;
    const mtime = putLive(id, this.deps.live, this.deps.dir);
    state.active = id;
    state.switchedAt = now;
    state.filed = { mtime, record: state.filed?.record ?? "" };
    writeState(state, this.deps.dir);
    this.deps.log({ event: "switch", from, to: id, byHand: true });
    await this.deps.tell(`Now on ${to.email}`, "Switched by hand.");
  }

  // Saves the live file under whoever it belongs to (rules.ts `filing`), so the copy put back later has
  // the newest refresh token. Writes state.json; changes `s` in place.
  private file(s: State) {
    const mtime = liveMtime(this.deps.live);
    if (mtime === undefined || mtime === s.filed?.mtime) return;
    this.seen = undefined;
    const rec = this.deps.record();
    const who = filing(s, rec);
    if (!who) {
      // Nobody to file it under. Noted as filed, so it isn't tried again every second.
      s.filed = { mtime, record: s.filed?.record ?? "" };
      writeState(s, this.deps.dir);
      this.deps.log({ event: "unfiled" });
      return;
    }
    saveLogin(who.id, readFileSync(this.deps.live, "utf8"), who.login ? rec!.account : undefined, this.deps.dir);
    if (!s.order.includes(who.id)) s.order.push(who.id);
    s.active = who.id;
    s.filed = { mtime, record: rec?.raw ?? s.filed?.record ?? "" };
    writeState(s, this.deps.dir);
    this.deps.log({ event: who.login ? "login" : "renewal", account: who.id });
  }
}

// The live deps. Paths are worked out when blimpd starts the loop, not when this file is imported.
function liveDeps(): SwitcherDeps {
  const dir = accountsDir();
  const status = join(blimpDir(), "status");
  return {
    dir,
    live: liveFile(),
    record: () => readRecord(),
    stops: async () => {
      const stops: Stop[] = [];
      for (const s of listSessionsLite(claudeDir(), await zmxListAsync())) {
        if (!CLAUDE_KINDS.includes(s.kind) || !isSafeName(s.name)) continue;
        try {
          const j = JSON.parse(readFileSync(join(status, `${s.name}.json`), "utf8"));
          if (j?.event === "StopFailure") stops.push({ session: s.name, at: j.at, error: j.failure || "unknown", details: j.details, message: j.message });
        } catch {}
      }
      return stops;
    },
    // Read the way sessions.ts reads a permission prompt's screen: the last 40 lines, 5 s at most.
    menu: (name) => {
      const r = Bun.spawnSync([zmxPath(), "history", name], { env: zmxEnv(), stdout: "pipe", stderr: "ignore", timeout: 5000, killSignal: "SIGKILL" });
      return parseScreenOptions(r.exitedDueToTimeout ? "" : r.stdout.toString().split("\n").slice(-40).join("\n")).length > 0;
    },
    type: (name) => typeInto(name, "continue", { enter: true }),
    tell: async (title, body) => {
      console.log(`accounts: ${title}. ${body}`);
      const creds = readCreds();
      if (!creds) return;
      for (const d of readDevices()) await apnsFor(creds).send(d, { aps: { alert: { title, body }, sound: "default" } });
    },
    now: Date.now,
    wait: (ms) => Bun.sleep(ms),
    log: (entry) => {
      const file = join(dir, "log.jsonl");
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
          if (statSync(file).size > 1_000_000) renameSync(file, join(dir, "log.1.jsonl"));
        } catch {}
        appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, { mode: 0o600 });
      } catch (e) {
        console.log(`accounts: couldn't write the log (${(e as Error).message})`);
      }
    },
  };
}

export function startAccounts(every = 1000): void {
  const s = new Switcher(liveDeps());
  setInterval(() => void s.tick(), every);
}
