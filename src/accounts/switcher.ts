// The switcher (docs/superpowers/specs/2026-11-16-account-switching-design.md, "Saving", "Switching" and
// "By hand"): once a second it files a change to the live login file, and when a session stops on the
// limit it marks the account out, puts the next saved login in place, types "continue" into the sessions
// that stopped on the limit, and tells the phone. state.json is read from disk every time, because
// `blimpd account use` in another process can swap the login too. Only what this process has already
// seen or done stays in memory. A login is a secret: the log gets ids, emails, times and the hook's
// error text, never anything read from a credentials file.

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { apnsFor } from "../push/watch";
import { readCreds, readDevices } from "../push/store";
import { blimpDir, claudeDir, isSafeName, listSessionsLite, type Session, zmxEnv, zmxListAsync, zmxPath } from "../sessions";
import { typeInto } from "../typing";
import { filing, LATE_NOTICE_MS, LOGIN_RECORD_MS, nextAccount, OUT_ERRORS, OUT_MS, QUIET_MS, SETTLE_MS } from "./rules";
import { accountsDir, accountsOn, hasLogin, listSaved, liveFile, liveMtime, putLive, type Rec, readLoginNote, readRecord, readState, savedWith, saveLogin, type State, writeState } from "./store";

export type Stop = { session: string; at: number; error: string; details?: string; message?: string };
export type SwitcherDeps = {
  dir: string; // the accounts folder
  live: string; // the live login file
  record: () => Rec | undefined; // oauthAccount now
  loginSeen: () => number | undefined; // when Claude Code last said a /login succeeded in this Claude folder (hooks.ts)
  stops: () => Promise<Stop[]>; // running Claude sessions whose latest hook event is a StopFailure
  menu: (session: string) => boolean; // its screen shows a list of choices
  type: (session: string) => Promise<void>; // types "continue" and Enter; throws if it couldn't
  tell: (title: string, body: string) => Promise<void>;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (entry: Record<string, unknown>) => void; // one line of accounts/log.jsonl
};

export const CONTINUE_AFTER_MS = 3000; // a session that just stopped gets a moment before "continue"
const ERROR_AGAIN_MS = 600_000; // the same error is logged again after this long, so one that comes back leaves a line
const RECENT_MS = 60_000; // with no switch in the tick, only a stop this recent gets "continue": an older one is one a restart forgot

const plural = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

export class Switcher {
  // A stop is a session and its `at`. Each is logged once, goes through "Switch?" once (else a session
  // left stopped while every account is out would mark the account out again every second), and gets
  // "continue" at most once.
  private logged = new Map<string, number>();
  private asked = new Map<string, number>();
  private continued = new Map<string, number>();
  private toldOutFor?: number; // switchedAt when "every account is out" was last told
  private lastError?: { text: string; at: number };
  private looked = false; // whether a tick has checked the live login for a lost swap yet
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
      const wasUnknown = state.unknown;

      // A swap whose state write was lost is unmistakable, so it's adopted at once: a renewal would
      // hide it. On the first tick whatever the mtime (a crash can come between the swap and its state
      // write); after that on any change not yet filed. Any other change is filed once it is
      // SETTLE_MS old: a /login writes its account record, then its login file, and its notice last,
      // after network calls. A notice newer than the last settle with no change left to file came
      // after its change was filed, as a renewal.
      const m = liveMtime(this.deps.live);
      if (m !== undefined && (!this.looked || m !== state.filed?.mtime)) this.adopt(state, m, now);
      this.looked = true;
      const unfiled = () => m !== undefined && m !== state.filed?.mtime;
      const note = this.deps.loginSeen() ?? 0;
      let wrong: string | undefined;
      if (unfiled() && now - m! >= SETTLE_MS) this.file(state, now);
      else if (m !== undefined && !unfiled() && note > (state.filed?.at ?? 0)) wrong = this.late(state, m, note, now);
      // Told after the state is written, also when every account is out.
      const tellWrong = () => wrong && this.deps.tell("A /login may have been saved under the wrong account", `Log in to ${wrong} again with /login in a session.`);

      for (const s of stops)
        if (this.logged.get(s.session) !== s.at) {
          this.logged.set(s.session, s.at);
          this.deps.log({ event: "stop", session: s.session, error: s.error, details: s.details, message: s.message, account: state.active });
        }
      const out = stops.filter((s) => OUT_ERRORS.includes(s.error));

      // A limit stop in the quiet time after a switch (or a login filed just above) left before it, and
      // one from before blimpd started is a stale status file: neither asks for a switch. Nothing
      // switches over a change not yet filed (seconds old, or a /login waiting for its record), so the
      // copy put back later has the newest refresh token; the stops ask again next tick. Nor while blimp
      // can't tell whose login is in place: no account to mark out, and a stop asks once that is known.
      const asks = (s: Stop) => this.asked.get(s.session) !== s.at && s.at > (state.switchedAt ?? 0) + QUIET_MS && s.at >= this.started;
      const asking = unfiled() || state.unknown ? [] : out.filter(asks);
      let switched: { from: string; to: string } | undefined;
      if (asking.length) {
        const from = state.active;
        if (from) state.out[from] = { at: now, until: now + OUT_MS };
        const saved = listSaved(this.deps.dir, state);
        const next = nextAccount(saved, state, now);
        if (next) {
          const mtime = putLive(next.id, this.deps.live, this.deps.dir);
          state.active = next.id;
          state.switchedAt = now;
          state.filed = { mtime, at: now };
        }
        writeState(state, this.deps.dir);
        for (const s of asking) this.asked.set(s.session, s.at);
        if (!next) {
          if (this.toldOutFor !== (state.switchedAt ?? 0)) {
            this.toldOutFor = state.switchedAt ?? 0;
            await this.deps.tell("Every Claude account is out", "Claude Code carries on by itself when a limit resets.");
          }
          await tellWrong();
          return;
        }
        this.deps.log({ event: "switch", from, to: next.id });
        switched = { from: saved.find((a) => a.id === from)?.email || from || "The last account", to: next.email || next.id };
      }

      // After a switch, every limit stop; otherwise only a recent one that came in the quiet time after
      // the last. None while blimp can't tell whose login is in place.
      const sw = state.switchedAt;
      const quiet = (s: Stop) => sw !== undefined && sw < s.at && s.at <= sw + QUIET_MS && now - s.at < RECENT_MS;
      const due = state.unknown ? [] : out.filter((s) => this.continued.get(s.session) !== s.at && (switched || quiet(s)));
      let done = 0;
      let left = 0;
      let unread = false;
      if (due.length) {
        await this.deps.wait(CONTINUE_AFTER_MS);
        // Only into a session still stopped on that same limit: one that moved on during the wait is
        // dropped, counted neither way. A list that can't be read is tried three more times, a second
        // apart; still unread, nobody is typed into and the notification says why.
        let still: Stop[] | undefined;
        for (let i = 0; i < 4 && !still; i++) {
          if (i) await this.deps.wait(1000);
          still = await this.deps.stops().catch((e) => void this.error(e));
        }
        unread = !still;
        for (const s of due) {
          if (!still) break;
          if (!still.some((x) => x.session === s.session && x.at === s.at && OUT_ERRORS.includes(x.error))) continue;
          this.continued.set(s.session, s.at); // tried once, whatever happens
          try {
            if (this.deps.menu(s.session)) left++;
            else {
              await this.deps.type(s.session);
              done++;
            }
          } catch (e) {
            left++;
            this.deps.log({ event: "not continued", session: s.session, error: (e as Error).message });
          }
        }
      }

      if (switched) {
        const body = unread
          ? "blimp could not read the sessions, so none was continued."
          : done || left
            ? `${plural(done)} continued.${left ? ` ${left} left as they were.` : ""}`
            : "No session was waiting on it.";
        await this.deps.tell(`Now on ${switched.to}`, `${switched.from} ran out. ${body}`);
      }
      await tellWrong();
      if (state.unknown && !wasUnknown)
        await this.deps.tell("blimp can't tell which account is logged in", "The last /login was not saved. Run blimpd account use <email>, or /login again in a session.");
    } catch (e) {
      this.error(e);
    } finally {
      this.busy = false;
    }
  }

  // A step that keeps failing would write the same line every second: an error is logged only when it
  // differs from the last one logged, or that was 10 minutes ago. A store write's temp file has a new
  // random name each time, so the name is taken out first.
  private error(e: unknown) {
    const text = String((e as Error)?.message ?? e).replace(/\.tmp-[0-9a-f]+/g, ".tmp");
    const now = this.deps.now();
    if (text === this.lastError?.text && now - this.lastError.at < ERROR_AGAIN_MS) return;
    this.lastError = { text, at: now };
    this.deps.log({ event: "error", error: text });
  }

  // By hand (`blimpd account use`): file, swap, tell. Nothing is marked out and nobody gets "continue".
  // True when the login that was in place wasn't saved, because blimp couldn't tell whose it was.
  async use(id: string): Promise<boolean> {
    const now = this.deps.now();
    const state = readState(this.deps.dir);
    const to = listSaved(this.deps.dir, state).find((a) => a.id === id);
    if (!to) throw new Error("no saved login for that account");
    if ((to.expires ?? Infinity) <= now) throw new Error("that account's login has expired; log in to it again with /login");
    // A change seconds old may be a /login whose notice hasn't come yet: filed now, it would go under
    // the account in use.
    const m = liveMtime(this.deps.live);
    if (m !== undefined && m !== state.filed?.mtime && now - m < SETTLE_MS) {
      const n = Math.ceil((SETTLE_MS - (now - m)) / 1000);
      throw new Error(`a login is still settling; try again in ${n} second${n === 1 ? "" : "s"}`);
    }
    if (!this.file(state, now)) throw new Error("a login made a moment ago isn't saved yet; try again in a minute");
    const unsaved = state.unknown === true;
    const from = state.active;
    const mtime = putLive(id, this.deps.live, this.deps.dir);
    state.active = id;
    delete state.unknown;
    state.switchedAt = now;
    state.filed = { mtime, at: now };
    writeState(state, this.deps.dir);
    this.deps.log({ event: "switch", from, to: id, byHand: true });
    await this.deps.tell(`Now on ${to.email || to.id}`, "Switched by hand.");
    return unsaved;
  }

  // Saves the live file under whoever it belongs to (rules.ts `filing`), so the copy put back later has
  // the newest refresh token. Writes state.json; changes `s` in place. False while a /login waits for
  // its account record: nothing is filed yet.
  private file(s: State, now: number): boolean {
    const mtime = liveMtime(this.deps.live);
    if (mtime === undefined || mtime === s.filed?.mtime) return true;
    if (this.adopt(s, mtime, now)) return true;
    const rec = this.deps.record();
    const who = filing(s, rec, this.deps.loginSeen());
    // Nobody to file it under, no login in it (after /logout, say), a /login whose record never came,
    // or a change held while blimp can't tell whose login is in place: noted as filed, so it isn't
    // tried again every second. Any other failure to save is thrown, and tried again next tick.
    const unfiled = (event: string, why?: string) => {
      s.filed = { mtime, at: now };
      writeState(s, this.deps.dir);
      this.deps.log({ event, ...(why && { why }) });
      return true;
    };
    // A /login whose record never came: blimp knows a login happened and not whose, so from here
    // nothing is saved under the account that was in use.
    if (who === "wait") {
      if (now - mtime < LOGIN_RECORD_MS) return false;
      s.unknown = true;
      delete s.active;
      return unfiled("unknown", "login without a record");
    }
    if (who === "held") return unfiled("held");
    const text = readFileSync(this.deps.live, "utf8");
    if (!who || !hasLogin(text)) return unfiled("unfiled");
    saveLogin(who.id, text, who.login ? rec!.account : undefined, this.deps.dir);
    if (!s.order.includes(who.id)) s.order.push(who.id);
    s.active = who.id;
    delete s.unknown;
    s.filed = { mtime, at: now };
    // A login by hand is a switch too: a limit stop from a request that left on the old account gets
    // the quiet time. A renewal may be a /login whose notice is late: noted, so `late` can name the
    // account it went under.
    if (who.login) s.switchedAt = mtime;
    else s.renewed = { id: who.id, at: mtime };
    writeState(s, this.deps.dir);
    this.deps.log({ event: who.login ? "login" : "renewal", account: who.id });
    return true;
  }

  // The live login is exactly another saved account's than the active one: a swap whose state write
  // was lost (a throw, a crash, or `account use` in another process). That account is in use, from
  // the swap's time; filing would put its login over the active one's.
  private adopt(s: State, mtime: number, now: number): boolean {
    const owner = savedWith(readFileSync(this.deps.live, "utf8"), this.deps.dir);
    if (!owner || owner === s.active) return false;
    s.active = owner;
    delete s.unknown;
    s.switchedAt = mtime;
    s.filed = { mtime, at: now };
    writeState(s, this.deps.dir);
    this.deps.log({ event: "adopted", account: owner });
    return true;
  }

  // A /login's notice that came after its change was filed: that change may have been a renewal saved
  // under state.renewed's account. blimp moves no saved login on a guess, so nothing else changes: the
  // notice is used up, and if a renewal was filed in the LATE_NOTICE_MS before it, the phone is told to
  // log in to that account again. Returns that account's email (or id) then.
  private late(s: State, m: number, note: number, now: number): string | undefined {
    const r = s.renewed;
    s.filed = { mtime: m, at: now };
    delete s.renewed;
    writeState(s, this.deps.dir);
    const told = r !== undefined && note >= r.at && note - r.at < LATE_NOTICE_MS;
    this.deps.log({ event: "late login notice", ...(r && { account: r.id }), told });
    if (told) return listSaved(this.deps.dir, s).find((a) => a.id === r.id)?.email || r.id;
  }
}

// The Claude sessions whose latest hook event is a StopFailure. Only a status file the session wrote
// itself counts: one older than the session was left by an earlier session of the same name (the rule
// deriveState in sessions.ts uses), and a session with no sessionId isn't running Claude. Only the
// Claude kind: a GLM session talks to another provider, so its limit says nothing about the account.
export function readStops(sessions: Pick<Session, "name" | "kind" | "created" | "sessionId">[], statusDir: string): Stop[] {
  const stops: Stop[] = [];
  for (const s of sessions) {
    if (s.kind !== "claude" || !s.sessionId || !isSafeName(s.name)) continue;
    try {
      const j = JSON.parse(readFileSync(join(statusDir, `${s.name}.json`), "utf8"));
      if (j?.event === "StopFailure" && typeof j.at === "number" && j.at >= s.created * 1000)
        stops.push({ session: s.name, at: j.at, error: j.failure || "unknown", details: j.details, message: j.message });
    } catch {}
  }
  return stops;
}

// Whether a session's screen shows a list of choices, from its last 40 lines: a cursor on a numbered
// row, or a dialog's "Enter to confirm" / "Esc to cancel". Typing "continue" and Enter there would pick
// whatever is highlighted. A screen that couldn't be read (no text) counts as one, so it's left alone.
export function menuOn(screen: string): boolean {
  if (!screen.trim()) return true;
  return screen
    .split("\n")
    .slice(-40)
    .some((l) => /^\s*❯\s*\d+\.\s+\S/.test(l) || l.includes("Enter to confirm") || l.includes("Esc to cancel"));
}

// The live deps. Paths are worked out when blimpd starts the loop, not when this file is imported.
function liveDeps(): SwitcherDeps {
  const dir = accountsDir();
  const status = join(blimpDir(), "status");
  return {
    dir,
    live: liveFile(),
    record: () => readRecord(),
    loginSeen: () => readLoginNote(),
    stops: async () => readStops(listSessionsLite(claudeDir(), await zmxListAsync()), status),
    // Read the way sessions.ts reads a permission prompt's screen, 5 s at most. Unread: no text.
    menu: (name) => {
      const r = Bun.spawnSync([zmxPath(), "history", name], { env: zmxEnv(), stdout: "pipe", stderr: "ignore", timeout: 5000, killSignal: "SIGKILL" });
      return menuOn(r.exitedDueToTimeout || r.exitCode !== 0 ? "" : r.stdout.toString());
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
    log: accountsLog(dir),
  };
}

// The writer of <accounts dir>/log.jsonl (600), one JSON line per entry with its time; past 1 MB the
// file becomes log.1.jsonl. Never throws: a log it can't write is said on the console.
export function accountsLog(dir: string): (entry: Record<string, unknown>) => void {
  const file = join(dir, "log.jsonl");
  return (entry) => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        if (statSync(file).size > 1_000_000) renameSync(file, join(dir, "log.1.jsonl"));
      } catch {}
      appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, { mode: 0o600 });
    } catch (e) {
      console.log(`accounts: couldn't write the log (${(e as Error).message})`);
    }
  };
}

export function startAccounts(every = 1000): void {
  const s = new Switcher(liveDeps());
  // Off unless config.json says so (store.ts accountsOn), checked every tick: no restart to turn it on.
  setInterval(() => {
    if (accountsOn()) void s.tick();
  }, every);
}
