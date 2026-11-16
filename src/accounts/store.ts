// Saved logins (docs/superpowers/specs/2026-11-16-account-switching-design.md, "Saved accounts"):
// <socket dir>/accounts/ (700), one folder per account named by its accountUuid, holding
// credentials.json (the live login file as it was) and account.json (the oauthAccount object), and
// state.json beside them. Every file is 600 and written through a temp file and a rename, so never
// half written. The live login file is put in place the same way: it stays a regular file, never a
// symlink, because Claude Code opens it with O_NOFOLLOW. A login is a secret: nothing here logs one,
// and no error message carries one. .claude.json is only read, never written.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { blimpDir, claudeDir } from "../sessions";

export type Saved = { id: string; email: string; expires?: number }; // expires: the refresh token's, ms
export type Out = { at: number; until: number };
export type Filed = { mtime: number; record: string }; // the live file's mtimeMs and oauthAccount's JSON when last filed
export type State = { active?: string; order: string[]; out: Record<string, Out>; switchedAt?: number; filed?: Filed };
export type Rec = { id: string; email: string; raw: string; account: unknown }; // oauthAccount; raw is JSON.stringify of it

export const accountsDir = (dir = blimpDir()) => join(dir, "accounts");
export const liveFile = (claude = claudeDir()) => join(claude, ".credentials.json");
export const recordFile = () => join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");

// An account id is oauthAccount.accountUuid. One that isn't letters, digits and dashes is refused, so
// no path can leave the folder.
const ID = /^[A-Za-z0-9-]{1,64}$/;
function checkId(id: string) {
  if (!ID.test(id)) throw new Error("an account id is 1 to 64 letters, digits or dashes");
}

function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mode only applies to a new folder
}

// Through a temp file beside it (600, never there before) and a rename; the temp file is taken away
// if either fails, so a failed write leaves no copy of a login behind.
function write(file: string, text: string) {
  const tmp = join(dirname(file), `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// The account .claude.json names. Undefined: no file, bad JSON, or no accountUuid.
export function readRecord(file = recordFile()): Rec | undefined {
  try {
    const account = JSON.parse(readFileSync(file, "utf8"))?.oauthAccount;
    if (typeof account?.accountUuid !== "string") return;
    const email = typeof account.emailAddress === "string" ? account.emailAddress : "";
    return { id: account.accountUuid, email, raw: JSON.stringify(account), account };
  } catch {}
}

export function liveMtime(live = liveFile()): number | undefined {
  try {
    return statSync(live).mtimeMs;
  } catch {}
}

// Missing or broken: no accounts yet.
export function readState(dir = accountsDir()): State {
  try {
    const j = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    if (j && typeof j === "object") return { ...j, order: Array.isArray(j.order) ? j.order : [], out: j.out && typeof j.out === "object" ? j.out : {} };
  } catch {}
  return { order: [], out: {} };
}

export function writeState(s: State, dir = accountsDir()) {
  privateDir(dir);
  write(join(dir, "state.json"), JSON.stringify(s));
}

// credentials is the live file's text as it was; account, when given, replaces account.json.
export function saveLogin(id: string, credentials: string, account: unknown | undefined, dir = accountsDir()) {
  checkId(id);
  privateDir(dir);
  privateDir(join(dir, id));
  write(join(dir, id, "credentials.json"), credentials);
  if (account !== undefined) write(join(dir, id, "account.json"), JSON.stringify(account));
}

// state.order first, then any other folder by name. A folder without a readable credentials.json is
// skipped. The email is "" when account.json is missing.
export function listSaved(dir = accountsDir(), state = readState(dir)): Saved[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => ID.test(n));
  } catch {
    return [];
  }
  const ordered = [...new Set(state.order)].filter((id) => names.includes(id));
  const ids = [...ordered, ...names.filter((n) => !ordered.includes(n)).sort()];
  const list: Saved[] = [];
  for (const id of ids) {
    let creds: string;
    try {
      creds = readFileSync(join(dir, id, "credentials.json"), "utf8");
    } catch {
      continue;
    }
    const saved: Saved = { id, email: "" };
    try {
      const expires = JSON.parse(creds)?.claudeAiOauth?.refreshTokenExpiresAt;
      if (typeof expires === "number") saved.expires = expires;
    } catch {}
    try {
      const email = JSON.parse(readFileSync(join(dir, id, "account.json"), "utf8"))?.emailAddress;
      if (typeof email === "string") saved.email = email;
    } catch {}
    list.push(saved);
  }
  return list;
}

// Puts a saved login in place of the live one. Returns the live file's new mtimeMs, so the change
// can be told apart from one blimpd didn't make. Throws, with the live file untouched, if it isn't saved.
export function putLive(id: string, live = liveFile(), dir = accountsDir()): number {
  checkId(id);
  write(live, readFileSync(join(dir, id, "credentials.json"), "utf8"));
  return statSync(live).mtimeMs;
}

export function forgetLogin(id: string, dir = accountsDir()) {
  checkId(id);
  rmSync(join(dir, id), { recursive: true, force: true });
}
