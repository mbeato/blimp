# Account Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Claude account in use runs out, blimpd puts another saved login in place, tells the sessions that stopped on the limit to continue, and tells Max.

**Architecture:** A new `src/accounts/` folder in blimpd: a store (saved logins and state, files only), pure rules (which account next, was a change a login or a renewal), and a `Switcher` that ticks once a second with injected dependencies, the way `PushWatcher` (src/push/watch.ts) does. The limit reaches it through one more Claude hook, `StopFailure`, written into the session's status file.

**Tech Stack:** Bun + TypeScript, `bun:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-16-account-switching-design.md`. Read it first: the plan argues from it.

## Global Constraints

- A login is a secret. `<socket dir>/accounts` is 700 and every file in it 600. No token in any log line, command output, route, error message or test name. Tests use made-up tokens (`"tok-A"`), never a real file.
- The live login file is `<claude dir>/.credentials.json` (`claudeDir()` in src/sessions.ts). It must stay a regular file: write a temp file (600, flag `wx`) beside it and `renameSync`. Never a symlink, never an in-place write.
- blimpd never writes `.claude.json`. It only reads `oauthAccount` from it. That file is `$CLAUDE_CONFIG_DIR/.claude.json` when the variable is set, else `~/.claude.json`.
- Every function that touches a path takes it as a parameter with the live path as the default, as src/secrets.ts and src/hooks.ts do, so tests run in temp folders.
- Match the repo's style: a comment block at the top of each file saying what it is and naming the spec; comments in plain short sentences; no new abstractions for one caller.
- Tests: `~/.bun/bin/bun test test/<file>` from the repo root (bun is not on every shell's PATH). The whole suite: `~/.bun/bin/bun test --parallel`.
- Commits: one per task, message in the repo's form (`blimpd: <what is now true>`). No `Co-Authored-By` line or other attribution.
- Do not start, attach to or type into any real session, and do not touch `~/.claude` or `~/.blimp`, while building or testing.

## File structure

| File | What it is |
|---|---|
| `src/accounts/store.ts` (new) | Saved logins and `state.json`: read, save, list, put one live, forget. Files only. |
| `src/accounts/rules.ts` (new) | Pure: constants, `nextAccount`, `filing`, `isOut`. |
| `src/accounts/switcher.ts` (new) | `Switcher` (tick, switch, continue, tell, log) and `startAccounts()` with the live dependencies. |
| `src/accounts/cli.ts` (new) | `blimpd accounts`, `blimpd account use|forget`. |
| `src/hooks.ts` | `StopFailure` joins the Claude hooks; the status file gets `failure`. |
| `src/files.ts` | `secretPaths` gets the accounts folder. |
| `src/main.ts`, `src/server.ts` | The commands; `startAccounts()` beside `startPush()`. |
| `test/accounts-store.test.ts`, `test/accounts-rules.test.ts`, `test/accounts-switcher.test.ts`, `test/accounts-cli.test.ts` (new) | One per source file. |
| `docs/SECURITY.md`, `docs/DESIGN.md`, `README.md` | As the spec's Docs section says. |

---

### Task 1: The store

**Files:** Create `src/accounts/store.ts`, `test/accounts-store.test.ts`.

**Interfaces — produces:**

```ts
export type Saved = { id: string; email: string; expires?: number }; // expires: the refresh token's, ms
export type Out = { at: number; until: number };
export type Filed = { mtime: number; record: string }; // the live file's mtimeMs and oauthAccount's JSON when last filed
export type State = { active?: string; order: string[]; out: Record<string, Out>; switchedAt?: number; filed?: Filed };
export type Rec = { id: string; email: string; raw: string; account: unknown }; // oauthAccount; raw is JSON.stringify of it

export const accountsDir = (dir = blimpDir()) => join(dir, "accounts");
export const liveFile = (claude = claudeDir()) => join(claude, ".credentials.json");
export const recordFile = () => join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
export function readRecord(file = recordFile()): Rec | undefined;        // undefined: no file, bad JSON, or no accountUuid
export function liveMtime(live = liveFile()): number | undefined;         // statSync(live).mtimeMs
export function readState(dir = accountsDir()): State;                    // missing or bad file: { order: [], out: {} }
export function writeState(s: State, dir = accountsDir()): void;          // temp + rename, 600
export function saveLogin(id: string, credentials: string, account: unknown | undefined, dir = accountsDir()): void;
export function listSaved(dir = accountsDir(), state = readState(dir)): Saved[]; // state.order first, then other folders by name
export function putLive(id: string, live = liveFile(), dir = accountsDir()): number; // returns the live file's new mtimeMs
export function forgetLogin(id: string, dir = accountsDir()): void;
```

An account id is `oauthAccount.accountUuid`. `saveLogin`, `putLive` and `forgetLogin` throw on an id that fails `/^[A-Za-z0-9-]{1,64}$/`, so no path leaves the folder. `saveLogin` writes `<dir>/<id>/credentials.json` (the string as given) and, when `account` is given, `account.json`; it makes `<dir>` and `<dir>/<id>` 700 (and chmods them if they exist). `listSaved` reads `email` from `account.json` (`emailAddress`) and `expires` from `credentials.json` (`claudeAiOauth.refreshTokenExpiresAt`); a folder without a readable `credentials.json` is skipped.

- [ ] **Step 1: Write the failing tests.** In a `mkdtempSync` root, with this helper:

```ts
const creds = (tok: string, refreshExpires = 2e12) => JSON.stringify({ claudeAiOauth: { accessToken: tok, refreshToken: `r-${tok}`, expiresAt: 1, refreshTokenExpiresAt: refreshExpires } });
const acct = (id: string, email: string) => ({ accountUuid: id, emailAddress: email });
```

  Cases:
  1. `saveLogin("id-a", creds("tok-A"), acct("id-a", "a@x.com"), dir)` → both files hold exactly what was given; files are 600, both folders 700; no `.tmp` file left. A second save with `creds("tok-A2")` and `account` undefined replaces the credentials and keeps `account.json`.
  2. `saveLogin("../x", …)`, `putLive("a/b", …)`, `forgetLogin("", …)` each throw and write nothing outside `dir`.
  3. `listSaved`: two saved accounts with `state.order = ["id-b", "id-a"]` come back in that order with their emails and `expires`; a third folder not in `order` comes last; a folder with only `account.json` is skipped.
  4. `putLive("id-a", live, dir)`: `live` then holds id-a's credentials byte for byte, is 600, `lstatSync(live).isSymbolicLink()` is false, and the returned number equals `statSync(live).mtimeMs`. With `live` already there (another login), it is replaced. With no saved `id-a`, it throws and `live` is unchanged.
  5. `readState` on a missing folder and on a file holding `not json` → `{ order: [], out: {} }`. `writeState` then `readState` round-trips; the file is 600.
  6. `readRecord`: a file with `oauthAccount` → `id`, `email`, and `raw === JSON.stringify(oauthAccount)`; no file, bad JSON, or no `accountUuid` → `undefined`.
  7. `forgetLogin("id-a", dir)` removes the folder; a second call does nothing.

- [ ] **Step 2:** Run `~/.bun/bin/bun test test/accounts-store.test.ts`. Expected: fails, module not found.
- [ ] **Step 3:** Write `src/accounts/store.ts` to the interface above (model the temp-file-and-rename on `saveSecret`, src/secrets.ts:31).
- [ ] **Step 4:** Run the test. Expected: all pass.
- [ ] **Step 5:** Commit: `blimpd: saved logins have a private folder (accounts/store.ts)`.

---

### Task 2: The rules

**Files:** Create `src/accounts/rules.ts`, `test/accounts-rules.test.ts`.

**Interfaces — consumes:** `Saved`, `State`, `Rec` from Task 1. **Produces:**

```ts
export const OUT_ERRORS = ["rate_limit", "billing_error"]; // StopFailure errors that mean the account is out
export const OUT_MS = 5 * 3600_000;   // how long an account that ran out is skipped
export const QUIET_MS = 30_000;       // a limit stop this soon after a switch left before it: no second switch
export const FILE_AFTER_MS = 120_000; // a change to the live file is filed this long after it's seen
export const isOut = (s: State, id: string, now: number) => (s.out[id]?.until ?? 0) > now;
// The saved account to switch to: after the active one in order, wrapping, not out, login not expired. None: undefined.
export function nextAccount(saved: Saved[], s: State, now: number): Saved | undefined;
// Who a changed live file belongs to. oauthAccount changed since the last filing: a /login, that account's.
// Unchanged: a session renewed the token, the active account's. Unknown: undefined.
export function filing(s: State, rec: Rec | undefined): { id: string; login: boolean } | undefined;
```

- [ ] **Step 1: Write the failing tests.**
  - `nextAccount` with `saved = [a, b, c]` (ids `id-a`…): active `id-a` → b; active `id-b` → c; active `id-c` → a (wraps); active `id-a` and b out until `now + 1` → c; b out until `now - 1` → b (the time passed); b's `expires` < now → c; only `[a]` with active a → undefined; all others out → undefined; no `active` → the first not out.
  - `filing`: no `filed` and a record for `id-a` → `{ id: "id-a", login: true }`; `filed.record === rec.raw` and `active: "id-b"` → `{ id: "id-b", login: false }` (the record is stale after a swap by blimp, spec finding 2); `filed.record !== rec.raw` → `{ id: rec.id, login: true }`; `rec` undefined with `active` set → `{ id: active, login: false }`; `rec` undefined and no `active` → undefined; record unchanged and no `active` → undefined.
  - `isOut`: no entry → false; `until` in the future → true; in the past → false.
- [ ] **Step 2:** Run `~/.bun/bin/bun test test/accounts-rules.test.ts`. Expected: fails, module not found.
- [ ] **Step 3:** Write `src/accounts/rules.ts`.
- [ ] **Step 4:** Run the test. Expected: all pass.
- [ ] **Step 5:** Commit: `blimpd: which account comes next, and whose login a changed file is (accounts/rules.ts)`.

---

### Task 3: The hook says why a turn failed

**Files:** Modify `src/hooks.ts` (the `EVENTS` list at line 12, `STATES` at line 20, the `writeFileSync` at line 177), `test/hooks.test.ts`.

**Produces:** a session's status file (`<socket dir>/status/<session>.json`) after a `StopFailure` holds `state: "done"`, `event: "StopFailure"`, `failure: <error>`, and when the hook sent them `details` and `message` (each cut to 300 characters). Any later hook event writes the file without them.

- [ ] **Step 1: Write the failing tests** in `test/hooks.test.ts`:
  - `writeHookStatus(JSON.stringify({ hook_event_name: "StopFailure", session_id: "s1", error: "rate_limit", error_details: "429 Too Many Requests", last_assistant_message: "API Error: Rate limit reached" }), "sess", dir)` → the file has `state: "done"`, `event: "StopFailure"`, `failure: "rate_limit"`, `details: "429 Too Many Requests"`, `message: "API Error: Rate limit reached"`.
  - The same with no `error` → `failure: "unknown"`, and no `details` or `message` keys. A 1000-character `last_assistant_message` is stored as 300 characters.
  - A `UserPromptSubmit` for the same session afterwards → the file has no `failure`, `details` or `message`.
  - With `codex = true`, a `StopFailure` writes nothing (Codex has no such event).
  - Update the existing `installHooks` expectations (first test, and any other that lists the events): `"StopFailure"` is now the last of the Claude events. `CODEX_HOOKS` is unchanged.
- [ ] **Step 2:** Run `~/.bun/bin/bun test test/hooks.test.ts`. Expected: the new cases fail.
- [ ] **Step 3:** Implement: add `"StopFailure"` to the end of `EVENTS`; `StopFailure: "done"` in `STATES` with a comment that it is a turn that ended on an API error (accounts/switcher.ts reads it); in `writeHookStatus`, for a Claude `StopFailure`, add `failure`, `details`, `message` to the object written. Update the comment at the top of the file.
- [ ] **Step 4:** Run `~/.bun/bin/bun test test/hooks.test.ts test/sessions.test.ts test/install.test.ts`. Expected: all pass (a test elsewhere that lists the hook events gets the new one too).
- [ ] **Step 5:** Commit: `blimpd: a turn that ends on an API error is recorded with the error (the StopFailure hook)`.

---

### Task 4: The switcher

**Files:** Create `src/accounts/switcher.ts`, `test/accounts-switcher.test.ts`.

**Interfaces — consumes:** everything from Tasks 1 and 2. **Produces:**

```ts
export type Stop = { session: string; at: number; error: string; details?: string; message?: string };
export type SwitcherDeps = {
  dir: string;                                  // the accounts folder
  live: string;                                 // the live login file
  record: () => Rec | undefined;                // oauthAccount now
  stops: () => Promise<Stop[]>;                 // running Claude sessions whose latest hook event is a StopFailure
  menu: (session: string) => boolean;           // its screen shows a list of choices
  type: (session: string) => Promise<void>;     // types "continue" and Enter; throws if it couldn't
  tell: (title: string, body: string) => Promise<void>;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (entry: Record<string, unknown>) => void; // one line of accounts/log.jsonl
};
export const CONTINUE_AFTER_MS = 3000;
export class Switcher {
  constructor(deps: SwitcherDeps, started?: number);
  tick(): Promise<void>;                        // never throws; a tick still running makes the next return at once
  use(id: string): Promise<void>;               // by hand: file, swap, tell. No "continue".
}
export function startAccounts(every = 1000): void; // the live deps, on an interval (server.ts calls it)
```

**What `tick` does, in order:**

1. **File a change.** `m = liveMtime(live)`. If `m` is defined and differs from `state.filed?.mtime`: remember when it was first seen (in memory). Once `FILE_AFTER_MS` has passed since then, call `file()`.
2. **`file()`** (also called first by every swap): if the live file's mtime equals `state.filed?.mtime`, nothing. Else `who = filing(state, deps.record())`; if `who` is undefined, log `{ event: "unfiled" }` and set only `filed.mtime` (so it isn't retried every second). Else `saveLogin(who.id, <live file's text>, who.login ? rec.account : undefined)`, append `who.id` to `state.order` if new, set `state.active = who.id`, set `state.filed = { mtime, record: rec?.raw ?? state.filed?.record ?? "" }`, write the state, log `{ event: who.login ? "login" : "renewal", account: who.id }`.
3. **Limit stops.** `out = (await deps.stops()).filter(s => OUT_ERRORS.includes(s.error))`. Every stop not logged before (keep a `Map<session, at>` in memory) is logged: `{ event: "stop", session, error, details, message, account: state.active }`. Stops with other errors are logged the same way and otherwise ignored.
4. **Switch?** A stop asks for a switch when `stop.at > (state.switchedAt ?? 0) + QUIET_MS` and `stop.at >= started` (a stale status file from before blimpd started doesn't). If any does: `file()`; mark `state.out[active] = { at: now, until: now + OUT_MS }`; `next = nextAccount(listSaved(), state, now)`. None: write the state, and tell "Every Claude account is out" / "blimp will switch when one is back." once (not again until a switch happens); stop here. Else `mtime = putLive(next.id, live)`; `state.active = next.id`, `state.switchedAt = now`, `state.filed = { mtime, record: state.filed?.record ?? "" }`; write the state; log `{ event: "switch", from, to }`.
5. **Continue.** After a switch in this tick, or when a stop falls inside the quiet time (`stop.at <= switchedAt + QUIET_MS` and `stop.at > switchedAt - 600_000`) and hasn't been continued: `await deps.wait(CONTINUE_AFTER_MS)`, then for each limit-stopped session not yet continued for that `at`: if `deps.menu(session)` → skip, count as left; else `await deps.type(session)`; a throw → count as left and log it. Remember `session → at` as continued either way, so it is tried once.
6. **Tell**, after a switch: title `Now on <next.email>`, body `<old email> ran out. <n> session(s) continued.` plus ` <m> left as they were.` when m > 0, and `No session was waiting on it.` when both are 0.

`use(id)`: `file()`, `putLive`, state as in step 4 but nothing marked out, log `{ event: "switch", from, to, byHand: true }`, tell `Now on <email>` / `Switched by hand.` Throws `Error("no saved login for that account")` or `Error("that account's login has expired; log in to it again with /login")` before touching anything.

**Live deps (`startAccounts`):**

- `stops`: `listSessionsLite(claudeDir(), await zmxListAsync())` filtered to `CLAUDE_KINDS` (kinds.ts); for each, read `<blimpDir()>/status/<name>.json`; keep those with `event === "StopFailure"` → `{ session: name, at, error: failure, details, message }`.
- `menu`: `parseScreenOptions(<last 40 lines of zmx history name>).length > 0` (prompt.ts; read the screen the way `promptFor` in sessions.ts:293 does).
- `type`: `typeInto(name, "continue", { enter: true })` (typing.ts).
- `tell`: to every phone: `apnsFor(creds).send(device, { aps: { alert: { title, body }, sound: "default" } })` with `readCreds()` and `readDevices()` (push/store.ts, push/watch.ts `apnsFor`); no key or no phone → nothing. Always also `console.log`.
- `log`: append `JSON.stringify({ at: Date.now(), ...entry })` + newline to `<accounts dir>/log.jsonl`, created 600. When the file passes 1 MB, rename it to `log.1.jsonl` first.
- `record`: `readRecord()`. `wait`: `Bun.sleep`. `now`: `Date.now`.

- [ ] **Step 1: Write the failing tests** with fake deps: a temp `dir` and `live`, a settable clock (`now`), `wait` that resolves at once, arrays that record `type`, `tell` and `log` calls, and `stops`/`record`/`menu` returning what the test sets. Seed with the Task 1 helpers: accounts `id-a` (`a@x.com`) and `id-b` (`b@x.com`) saved, `live` holding id-a's credentials, state `{ active: "id-a", order: ["id-a", "id-b"], out: {}, filed: { mtime: <live's>, record: <rec a>.raw } }`, `started = 0`. Cases:
  1. **Switches and continues.** One `rate_limit` stop for `s1` at `now` → after `tick()`: `live` holds id-b's credentials; state `active: "id-b"`, `out["id-a"].until === now + OUT_MS`, `switchedAt === now`; `type` called once with `s1`; `tell` called once with title `Now on b@x.com` and a body containing `a@x.com ran out` and `1 session continued`.
  2. **One switch for many.** Three sessions stop in the same tick → one switch, three `type` calls, one `tell`. A second `tick()` with the same stops → nothing more.
  3. **Quiet time.** After case 1, a stop for `s2` at `switchedAt + 10_000` → no second switch (`active` still `id-b`), `s2` gets `continue`. A stop at `switchedAt + QUIET_MS + 1` → id-b is marked out; with id-a still out, no switch, and `tell` says `Every Claude account is out` once across two ticks.
  4. **Other errors do nothing.** A stop with `error: "overloaded"` → no switch, no `type`; one log line with `event: "stop"`.
  5. **Stale stop.** `started = 1000`, a stop with `at: 500` → no switch.
  6. **A menu or a refusal.** `menu` true for `s1`, `type` throws for `s2`, `s3` fine → `type` attempted for `s2` and `s3` only; the body says `1 session continued. 2 left as they were.`
  7. **A login is filed.** Write new credentials (`tok-C`) to `live` and make `record` return account `id-c` (`c@x.com`); `tick()` at once files nothing; after the clock moves `FILE_AFTER_MS`, `tick()` saves `id-c` with those credentials and `account.json`, `active` is `id-c`, `order` ends with `id-c`.
  8. **A renewal is filed under the active account.** After a switch to id-b (the record still says id-a, unchanged), write renewed credentials (`tok-B2`) to `live`; after `FILE_AFTER_MS` the saved id-b credentials are `tok-B2` and id-a's are untouched.
  9. **A swap files first.** With unfiled renewed credentials for id-a in `live` (`tok-A2`) and a limit stop in the same tick → id-a's saved copy is `tok-A2` before `live` becomes id-b's.
  10. **`use`.** `use("id-b")` → `live` is id-b's, nothing marked out, no `type`, `tell` title `Now on b@x.com`. `use("nope")` and `use` of an account whose `expires` is past → throw, `live` unchanged.
  11. **No token in the log.** After cases 1 and 7, no logged entry's JSON contains `tok-`.
  12. **Never throws.** `stops` rejecting → `tick()` resolves; the next tick works.
- [ ] **Step 2:** Run `~/.bun/bin/bun test test/accounts-switcher.test.ts`. Expected: fails, module not found.
- [ ] **Step 3:** Write `src/accounts/switcher.ts`.
- [ ] **Step 4:** Run the test, then `~/.bun/bin/bun test test/accounts-store.test.ts test/accounts-rules.test.ts test/accounts-switcher.test.ts`. Expected: all pass.
- [ ] **Step 5:** Commit: `blimpd: when the account in use runs out, the next saved one takes over and stopped sessions continue (accounts/switcher.ts)`.

---

### Task 5: Commands, start-up, and the folder is off limits

**Files:** Create `src/accounts/cli.ts`, `test/accounts-cli.test.ts`. Modify `src/main.ts` (the header comment, the imports, the command chain, the usage line), `src/server.ts` (beside `startPush()` at line 624), `src/files.ts` (`secretPaths`, line 90), `test/files.test.ts`.

**Interfaces — produces:**

```ts
// Each returns the exit code and prints through `out` / `err` (console.log / console.error by default).
export function runAccounts(dir?: string, now?: number, out?: (s: string) => void): number;                 // blimpd accounts
export function runAccount(args: string[], dir?: string, live?: string, out?, err?): Promise<number>;       // blimpd account use|forget <email>
```

`blimpd accounts` prints one line per saved account: the email, `(in use)` for the active one, `out until HH:MM` when out, and `login expires <date>` or `login expired: log in to it again with /login`. With none saved: `no saved logins yet. Log in with /login in a session and blimp keeps a copy.` `account use <email>` files the live login first and swaps, as `Switcher.use` does (build a `Switcher` with `stops: async () => []`, `type` and `menu` unused, `tell` printing to `out`); it prints `now on <email>`. `account forget <email>` refuses the active account (`that's the account in use`), else removes it from the folder, `order` and `out`. An email that matches no saved account: `no saved login for <email>`, exit 1. Bad arguments: a usage line, exit 1.

- [ ] **Step 1: Write the failing tests.** `test/accounts-cli.test.ts`, seeded as in Task 4: the list's lines for an active, an out and an expired account (fixed `now`); the output never contains `tok-`; `use` swaps `live` and exits 0; `use` of an unknown email exits 1 with the message and leaves `live`; `forget` of the active one exits 1; `forget` of another removes its folder and its `order` entry. `test/files.test.ts`: beside the existing secrets-folder cases, `<dir>/accounts`, a file inside it, and `<dir>` itself are refused the same way.
- [ ] **Step 2:** Run both test files. Expected: the new cases fail.
- [ ] **Step 3:** Implement. `secretPaths` gets `join(dir, "accounts")` and its comment says so. `main.ts`: `accounts` → `process.exit(runAccounts())`; `account` → `process.exit(await runAccount(args))`; add both to the header comment and the usage line. `server.ts`: `startAccounts();` after `startPush();` with a one-line comment.
- [ ] **Step 4:** Run `~/.bun/bin/bun test --parallel`. Expected: the whole suite passes.
- [ ] **Step 5:** Commit: `blimpd: blimpd accounts lists the saved logins, account use switches by hand, and no route reads the folder`.

---

### Task 6: Docs

**Files:** Modify `docs/SECURITY.md`, `docs/DESIGN.md`, `README.md`, `docs/superpowers/specs/2026-11-16-account-switching-design.md`.

- [ ] **Step 1:** `docs/SECURITY.md`: a row for saved logins in the table the other key files are in: where (`~/.blimp/accounts`, 700/600), who can read it (the user), that no route serves it (`secretPaths`), that the log there holds no token, and that blimpd replaces `~/.claude/.credentials.json` by a rename and never writes `.claude.json`.
- [ ] **Step 2:** `docs/DESIGN.md`: an "Accounts" section in the form of its neighbours: the folder's layout, the filing rule, the `StopFailure` status fields, the switch's steps, the commands. State what is not known yet (spec findings 4 and 5).
- [ ] **Step 3:** `README.md`: a short paragraph after **Visuals**, in the README's plain style: what it does, that adding an account is `/login`, the two commands, that a session can show the old account's name after a switch, and that `blimpd install-hooks` must run once after updating (the installer does it).
- [ ] **Step 4:** The spec: change "Date" line to add "Built <date>", and correct anything the build did differently.
- [ ] **Step 5:** Commit: `Docs: account switching (README, DESIGN.md, SECURITY.md, the spec as built)`.

---

### Task 7: On claude1, by hand (Max is told before each step that changes the live login)

- [ ] **Step 1:** `~/.bun/bin/bun run build`; run the built binary's `--version`.
- [ ] **Step 2:** With Max's go-ahead: install the built blimpd, `blimpd install-hooks`, restart the service. `blimpd accounts` lists both saved logins, with the right one in use.
- [ ] **Step 3:** `blimpd account use <the other email>`; send one short message in a running session; it answers. `blimpd accounts` shows the change. Switch back.
- [ ] **Step 4:** Read `~/.blimp/accounts/log.jsonl`: a `switch` line each way, no token.
- [ ] **Step 5:** Leave it running. At the first real limit, read the log's `stop` line and the session's screen, and settle spec finding 5.

## Not in this plan

A Mac notification for a switch (the Mac app raises its own from the session list; a switch needs a new `/events` message and an app change), an accounts screen in either app, switching before the limit, and reading the reset time from the hook's message. Each waits for the first real limit to show what is needed.
