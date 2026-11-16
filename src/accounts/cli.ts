// `blimpd accounts`: the saved logins, which is in use, which is out and until when, and when each login
// expires. `blimpd account use <email>`: files the live login and puts that one in place, as a switch does,
// without "continue". `blimpd account forget <email>`: removes a saved login, never the one in use.
// (docs/superpowers/specs/2026-11-16-account-switching-design.md, "By hand".) An account with no
// account.json goes by its id. Never prints a token. Switching itself is off unless config.json turns it
// on (store.ts accountsOn); use and forget work either way, being the user's own act.

import { dirname, join } from "node:path";
import { isOut } from "./rules";
import { accountsDir, accountsOn, forgetLogin, listSaved, liveFile, loginNoteFile, readLoginNote, readRecord, readState, type Saved, writeState } from "./store";
import { accountsLog, Switcher } from "./switcher";

const USAGE = "usage: blimpd account use|forget <email>";

const name = (a: Saved) => a.email || a.id;
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (t: number) => `${pad(new Date(t).getHours())}:${pad(new Date(t).getMinutes())}`;
const date = (t: number) => `${new Date(t).getFullYear()}-${pad(new Date(t).getMonth() + 1)}-${pad(new Date(t).getDate())}`;

// dir is the accounts folder; config.json is in the folder that holds it.
export function runAccounts(dir = accountsDir(), now = Date.now(), out: (s: string) => void = console.log): number {
  const state = readState(dir);
  const saved = listSaved(dir, state);
  if (!saved.length) out("no saved logins yet. Log in with /login in a session and blimp keeps a copy.");
  for (const a of saved) {
    let line = name(a);
    if (a.id === state.active) line += " (in use)";
    if (isOut(state, a.id, now)) line += `, out until ${clock(state.out[a.id].until)}`;
    if (a.expires !== undefined) line += a.expires > now ? `, login expires ${date(a.expires)}` : ", login expired: log in to it again with /login";
    out(line);
  }
  const top = dirname(dir);
  if (!accountsOn(top)) out(`account switching is off. To turn it on, add "accounts": true to ${join(top, "config.json")}`);
  return 0;
}

export async function runAccount(
  args: string[],
  dir = accountsDir(),
  live = liveFile(),
  out: (s: string) => void = console.log,
  err: (s: string) => void = console.error,
): Promise<number> {
  const [verb, who, ...rest] = args;
  if ((verb !== "use" && verb !== "forget") || !who || rest.length) {
    err(USAGE);
    return 1;
  }
  const state = readState(dir);
  const a = listSaved(dir, state).find((s) => s.email === who || s.id === who);
  if (!a) {
    err(`blimpd: no saved login for ${who}`);
    return 1;
  }

  if (verb === "forget") {
    if (a.id === state.active) {
      err("blimpd: that's the account in use");
      return 1;
    }
    forgetLogin(a.id, dir);
    state.order = state.order.filter((id) => id !== a.id);
    delete state.out[a.id];
    writeState(state, dir);
    out(`forgot ${name(a)}`);
    return 0;
  }

  // Only the swap: no sessions to continue, and the phone isn't told.
  const switcher = new Switcher({
    dir,
    live,
    record: () => readRecord(),
    loginSeen: () => readLoginNote(loginNoteFile(dirname(dir))),
    stops: async () => [],
    menu: () => false,
    type: async () => {},
    tell: async () => out(`now on ${name(a)}`),
    now: Date.now,
    wait: async () => {},
    log: accountsLog(dir),
  });
  try {
    await switcher.use(a.id);
  } catch (e) {
    err(`blimpd: ${(e as Error).message}`);
    return 1;
  }
  return 0;
}
