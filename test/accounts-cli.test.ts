// `blimpd accounts` and `blimpd account use|forget` (src/accounts/cli.ts), in temp folders, seeded as the
// switcher's test is. Tokens are made up.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAccount, runAccounts } from "../src/accounts/cli";
import { type Connector, writeConnectors } from "../src/accounts/connectors";
import { accountsOn, putLive, readState, saveLogin, writeState } from "../src/accounts/store";

const root = realpathSync(mkdtempSync(join(tmpdir(), "blimp-accounts-cli-")));
// .claude.json is read through CLAUDE_CONFIG_DIR when a use files the live login: a temp one here.
const was = process.env.CLAUDE_CONFIG_DIR;
beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = join(root, "config");
});
afterAll(() => {
  if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = was;
  rmSync(root, { recursive: true, force: true });
});
let n = 0;

const T = 1_800_000_000_000;
const LATER = 4e12; // a login that expires long after any real clock in a test, for `use`, which reads the real one
const EXPIRED = 1e12; // long before
const creds = (tok: string, refreshExpires = LATER) => JSON.stringify({ claudeAiOauth: { accessToken: tok, refreshToken: `r-${tok}`, expiresAt: 1, refreshTokenExpiresAt: refreshExpires } });
const acct = (id: string, email: string) => ({ accountUuid: id, emailAddress: email });

// id-a (active, live and filed), id-b (out for an hour), id-c (login long expired). Switching is off
// unless `on`: use and forget work either way.
function setup(on = false) {
  const top = join(root, `t${++n}`);
  const dir = join(top, "accounts");
  const live = join(top, "claude", ".credentials.json");
  mkdirSync(join(top, "claude"), { recursive: true });
  saveLogin("id-a", creds("tok-A"), acct("id-a", "a@x.com"), dir);
  saveLogin("id-b", creds("tok-B"), acct("id-b", "b@x.com"), dir);
  saveLogin("id-c", creds("tok-C", EXPIRED), acct("id-c", "c@x.com"), dir);
  const mtime = putLive("id-a", live, dir);
  writeState(
    { active: "id-a", order: ["id-a", "id-b", "id-c"], out: { "id-b": { at: T, until: T + 3600_000 } }, filed: { mtime, at: 0 } },
    dir,
  );
  if (on) writeFileSync(join(top, "config.json"), JSON.stringify({ accounts: true }));
  return { top, dir, live };
}

// What a command printed, and its exit code.
async function printed(f: (out: (s: string) => void, err: (s: string) => void) => number | Promise<number>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await f(
    (s) => void out.push(s),
    (s) => void err.push(s),
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const pad = (k: number) => String(k).padStart(2, "0");
const hhmm = (t: number) => `${pad(new Date(t).getHours())}:${pad(new Date(t).getMinutes())}`;
const day = (t: number) => `${new Date(t).getFullYear()}-${pad(new Date(t).getMonth() + 1)}-${pad(new Date(t).getDate())}`;
// As `blimpd accounts` prints it: with the date when T + 1 h is another local day (a zone where T is 23:xx).
const outAt = (t: number) => (day(t) === day(T) ? hhmm(t) : `${day(t)} ${hhmm(t)}`);
const liveToken = (live: string) => JSON.parse(readFileSync(live, "utf8")).claudeAiOauth.accessToken;
const off = (top: string) => `account switching is off. To turn it on, add "accounts": true to ${join(top, "config.json")}`;

test("accountsOn: only with \"accounts\": true in config.json", () => {
  const top = join(root, `t${++n}`);
  mkdirSync(top);
  expect(accountsOn(top, "linux")).toBe(false);
  for (const [text, on] of [["{}", false], ['{"accounts": false}', false], ['{"accounts": true}', true], ["not json", false]] as const) {
    writeFileSync(join(top, "config.json"), text);
    expect(accountsOn(top, "linux")).toBe(on);
  }
});

// On a Mac, Claude Code keeps its login in the Keychain, so swapping .credentials.json would switch nothing.
const mac = "account switching does not work on a Mac yet, because Claude Code keeps its login in the macOS Keychain";

test("accountsOn: never on a Mac, whatever config.json says", () => {
  const { top } = setup(true);
  expect(accountsOn(top, "linux")).toBe(true);
  expect(accountsOn(top, "darwin")).toBe(false);
});

test("accounts, account use and forget: on a Mac, one line saying switching doesn't work there, and nothing changes", async () => {
  const { dir, live } = setup(true);
  const before = readFileSync(live, "utf8");
  expect(await printed((out) => runAccounts(dir, T, out, "darwin"))).toEqual({ code: 0, out: mac, err: "" });
  const none = join(root, `t${++n}`, "accounts");
  expect(await printed((out) => runAccounts(none, T, out, "darwin"))).toEqual({ code: 0, out: mac, err: "" });
  for (const verb of ["use", "forget"])
    expect(await printed((out, err) => runAccount([verb, "b@x.com"], dir, live, out, err, "darwin"))).toEqual({ code: 1, out: "", err: `blimpd: ${mac}` });
  expect(readFileSync(live, "utf8")).toBe(before);
  expect(existsSync(join(dir, "id-b"))).toBe(true);
  expect(readState(dir).active).toBe("id-a");
});

test("accounts: one line each, with which is in use, out until when, and when the login expires; never a token", async () => {
  const { dir } = setup(true);
  const r = await printed((out) => runAccounts(dir, T, out, "linux"));
  expect(r.code).toBe(0);
  expect(r.out.split("\n")).toEqual([
    `a@x.com (in use), login expires ${day(LATER)}`,
    `b@x.com, out until ${outAt(T + 3600_000)}, login expires ${day(LATER)}`,
    "c@x.com, login expired: log in to it again with /login",
  ]);
  expect(r.out).not.toContain("tok-");
});

test("accounts: out until later today is the clock only; another day adds the date", async () => {
  const { dir } = setup(true);
  const noon = new Date(2027, 0, 15, 12, 0).getTime(); // local, so the date doesn't hang on the machine's zone
  const outUntil = async (until: number) => {
    const s = readState(dir);
    s.out["id-b"] = { at: noon, until };
    writeState(s, dir);
    return (await printed((out) => runAccounts(dir, noon, out, "linux"))).out.split("\n")[1];
  };
  expect(await outUntil(new Date(2027, 0, 15, 18, 30).getTime())).toBe(`b@x.com, out until 18:30, login expires ${day(LATER)}`);
  expect(await outUntil(new Date(2027, 0, 17, 9, 5).getTime())).toBe(`b@x.com, out until 2027-01-17 09:05, login expires ${day(LATER)}`);
});

test("accounts: an out that has ended isn't shown, and one with no account.json shows its id", async () => {
  const { dir } = setup(true);
  rmSync(join(dir, "id-c", "account.json"));
  const r = await printed((out) => runAccounts(dir, T + 2 * 3600_000, out, "linux"));
  expect(r.out.split("\n").slice(1)).toEqual([`b@x.com, login expires ${day(LATER)}`, "id-c, login expired: log in to it again with /login"]);
});

test("accounts: with switching off, the list and then how to turn it on", async () => {
  const { top, dir } = setup();
  const r = await printed((out) => runAccounts(dir, T, out, "linux"));
  expect(r.code).toBe(0);
  expect(r.out.split("\n")).toHaveLength(4);
  expect(r.out.split("\n").at(-1)).toBe(off(top));
});

test("accounts: none saved, with switching on and off", async () => {
  const top = join(root, `t${++n}`);
  mkdirSync(top);
  const none = "no saved logins yet. Log in with /login in a session and blimp keeps a copy.";
  const r = await printed((out) => runAccounts(join(top, "accounts"), T, out, "linux"));
  expect(r.code).toBe(0);
  expect(r.out.split("\n")).toEqual([none, off(top)]);
  writeFileSync(join(top, "config.json"), JSON.stringify({ accounts: true }));
  expect((await printed((out) => runAccounts(join(top, "accounts"), T, out, "linux"))).out).toBe(none);
});

test("accounts: when blimp can't tell which account is logged in, none is in use and a line after the list says so", async () => {
  const { dir } = setup(true);
  const { active, ...s } = readState(dir);
  writeState({ ...s, unknown: true }, dir);
  const r = await printed((out) => runAccounts(dir, T, out, "linux"));
  expect(r.out.split("\n")).toEqual([
    `a@x.com, login expires ${day(LATER)}`,
    `b@x.com, out until ${outAt(T + 3600_000)}, login expires ${day(LATER)}`,
    "c@x.com, login expired: log in to it again with /login",
    "blimp can't tell which account is logged in. Say which with: blimpd account use <email>, or log in again with /login in a session.",
  ]);
});

// A stored connector reading (connectors.ts) for an account.
const reading = (dir: string, id: string, connectors: Connector[]) => writeConnectors(id, { at: T, connectors, told: [] }, dir);
const ok = (name: string): Connector => ({ name, state: "ok" });

test("accounts: under an account whose reading lacks connectors another has, one more line, in its three shapes", async () => {
  const { dir } = setup(true);
  reading(dir, "id-a", [ok("Slack"), { name: "Gmail", state: "signin" }]);
  reading(dir, "id-b", [ok("Slack"), ok("Gmail"), ok("Zapier"), ok("Google Calendar")]);
  reading(dir, "id-c", [{ name: "Slack", state: "signin" }, ok("Gmail"), ok("Zapier"), ok("Google Calendar")]);
  const r = await printed((out) => runAccounts(dir, T, out, "linux"));
  expect(r.out.split("\n")).toEqual([
    `a@x.com (in use), login expires ${day(LATER)}`,
    "  no Google Calendar, Zapier; Gmail needs a sign-in",
    `b@x.com, out until ${outAt(T + 3600_000)}, login expires ${day(LATER)}`,
    "c@x.com, login expired: log in to it again with /login",
    "  Slack needs a sign-in",
  ]);
  reading(dir, "id-a", [ok("Slack")]);
  reading(dir, "id-b", [ok("Slack"), ok("Zapier")]);
  reading(dir, "id-c", [ok("Slack"), ok("Zapier")]);
  expect((await printed((out) => runAccounts(dir, T, out, "linux"))).out.split("\n")[1]).toBe("  no Zapier");
});

test("accounts: no extra line for an account with no reading, nor with an empty gap", async () => {
  const { dir } = setup(true);
  reading(dir, "id-a", [ok("Slack"), { name: "Zapier", state: "down" }]);
  reading(dir, "id-b", [ok("Slack"), ok("Zapier")]);
  const r = await printed((out) => runAccounts(dir, T, out, "linux"));
  expect(r.out.split("\n")).toEqual([
    `a@x.com (in use), login expires ${day(LATER)}`,
    `b@x.com, out until ${outAt(T + 3600_000)}, login expires ${day(LATER)}`,
    "c@x.com, login expired: log in to it again with /login",
  ]);
});

test("account use: puts the login in place and says so", async () => {
  const { dir, live } = setup();
  const r = await printed((out, err) => runAccount(["use", "b@x.com"], dir, live, out, err, "linux"));
  expect(r).toEqual({ code: 0, out: "now on b@x.com", err: "" });
  expect(liveToken(live)).toBe("tok-B");
  expect(readState(dir).active).toBe("id-b");
});

test("account use: files a renewed live login under the account in use first", async () => {
  const { dir, live } = setup();
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", ".claude.json"), JSON.stringify({ oauthAccount: acct("id-a", "a@x.com") }));
  writeFileSync(live, creds("tok-A2"));
  utimesSync(live, 1_000_000, 1_000_000);
  expect((await printed((out, err) => runAccount(["use", "id-b"], dir, live, out, err, "linux"))).code).toBe(0);
  expect(readFileSync(join(dir, "id-a", "credentials.json"), "utf8")).toContain("tok-A2");
  expect(liveToken(live)).toBe("tok-B");
});

test("account use: the switch goes into log.jsonl, 600, with no token", async () => {
  const { dir, live } = setup();
  expect((await printed((out, err) => runAccount(["use", "b@x.com"], dir, live, out, err, "linux"))).code).toBe(0);
  const file = join(dir, "log.jsonl");
  const text = readFileSync(file, "utf8");
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.filter((l) => l.event === "switch")).toEqual([{ at: expect.any(Number), event: "switch", from: "id-a", to: "id-b", byHand: true }]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(text).not.toContain("tok-");
});

test("account use: a /login not yet filed goes under the account it was made to, not the one in use", async () => {
  const { top, dir, live } = setup();
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", ".claude.json"), JSON.stringify({ oauthAccount: { ...acct("id-d", "d@x.com"), profileFetchedAt: Date.now() } }));
  writeFileSync(join(top, "auth-success.json"), JSON.stringify({ at: Date.now(), dir: join(root, "config") }));
  writeFileSync(live, creds("tok-D"));
  utimesSync(live, 1_000_000, 1_000_000);
  expect((await printed((out, err) => runAccount(["use", "id-b"], dir, live, out, err, "linux"))).code).toBe(0);
  expect(readFileSync(join(dir, "id-d", "credentials.json"), "utf8")).toContain("tok-D");
  expect(readFileSync(join(dir, "id-a", "credentials.json"), "utf8")).toContain("tok-A");
  expect(liveToken(live)).toBe("tok-B");
});

test("account use: a login note from another Claude folder, or with no folder, isn't a /login here: the change is a renewal", async () => {
  for (const note of [{ at: Date.now(), dir: join(root, "elsewhere") }, { at: Date.now() }]) {
    const { top, dir, live } = setup();
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    writeFileSync(join(root, "config", ".claude.json"), JSON.stringify({ oauthAccount: { ...acct("id-d", "d@x.com"), profileFetchedAt: Date.now() } }));
    writeFileSync(join(top, "auth-success.json"), JSON.stringify(note));
    writeFileSync(live, creds("tok-A2"));
    utimesSync(live, 1_000_000, 1_000_000);
    expect((await printed((out, err) => runAccount(["use", "id-b"], dir, live, out, err, "linux"))).code).toBe(0);
    expect(readFileSync(join(dir, "id-a", "credentials.json"), "utf8")).toContain("tok-A2");
    expect(existsSync(join(dir, "id-d"))).toBe(false);
  }
});

test("account use: while blimp can't tell whose login is in place, says it wasn't saved, saves it nowhere, and clears that", async () => {
  const { dir, live } = setup();
  const { active, ...s } = readState(dir);
  writeState({ ...s, unknown: true, filed: { mtime: 1, at: 2 } }, dir);
  writeFileSync(live, creds("tok-X"));
  utimesSync(live, 1_000_000, 1_000_000);
  const r = await printed((out, err) => runAccount(["use", "b@x.com"], dir, live, out, err, "linux"));
  expect(r).toEqual({ code: 0, out: "the login that was in place was not saved, because blimp could not tell whose it was\nnow on b@x.com", err: "" });
  expect(liveToken(live)).toBe("tok-B");
  const after = readState(dir);
  expect(after.active).toBe("id-b");
  expect(after.unknown).toBeUndefined();
  for (const id of ["id-a", "id-b", "id-c"]) expect(readFileSync(join(dir, id, "credentials.json"), "utf8")).not.toContain("tok-X");
  expect(existsSync(join(dir, "id-a", "credentials.prev.json"))).toBe(false);
});

test("account use: refuses while a change to the live login is settling, and works once it has settled", async () => {
  const { dir, live } = setup();
  writeFileSync(live, creds("tok-A2"));
  utimesSync(live, (Date.now() - 2000) / 1000, (Date.now() - 2000) / 1000);
  const r = await printed((out, err) => runAccount(["use", "b@x.com"], dir, live, out, err, "linux"));
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  expect(r.err).toMatch(/^blimpd: a login is still settling; try again in 2[78] seconds$/);
  expect(liveToken(live)).toBe("tok-A2");
  expect(readState(dir).active).toBe("id-a");
  utimesSync(live, 1_000_000, 1_000_000);
  expect((await printed((out, err) => runAccount(["use", "b@x.com"], dir, live, out, err, "linux"))).code).toBe(0);
  expect(liveToken(live)).toBe("tok-B");
});

test("account use: an unknown email or an expired login changes nothing", async () => {
  const { dir, live } = setup();
  const before = readFileSync(live, "utf8");
  const r = await printed((out, err) => runAccount(["use", "z@x.com"], dir, live, out, err, "linux"));
  expect(r.code).toBe(1);
  expect(r.err).toContain("no saved login for z@x.com");
  const c = await printed((out, err) => runAccount(["use", "c@x.com"], dir, live, out, err, "linux"));
  expect(c.code).toBe(1);
  expect(c.err).toBe("blimpd: that account's login has expired; log in to it again with /login");
  expect(readFileSync(live, "utf8")).toBe(before);
  expect(`${r.out}${r.err}${c.out}${c.err}`).not.toContain("tok-");
});

test("account forget: not the one in use", async () => {
  const { dir, live } = setup();
  const r = await printed((out, err) => runAccount(["forget", "a@x.com"], dir, live, out, err, "linux"));
  expect(r.code).toBe(1);
  expect(r.err).toContain("that's the account in use");
  expect(existsSync(join(dir, "id-a"))).toBe(true);
});

test("account forget: another one goes from the folder, the order and the outs", async () => {
  const { dir, live } = setup();
  const r = await printed((out, err) => runAccount(["forget", "b@x.com"], dir, live, out, err, "linux"));
  expect(r.code).toBe(0);
  expect(existsSync(join(dir, "id-b"))).toBe(false);
  const s = readState(dir);
  expect(s.order).toEqual(["id-a", "id-c"]);
  expect(s.out).toEqual({});
  expect(s.active).toBe("id-a");
});

test("account: bad arguments get the usage", async () => {
  const { dir, live } = setup();
  for (const args of [[], ["use"], ["switch", "b@x.com"], ["use", "b@x.com", "extra"]]) {
    const r = await printed((out, err) => runAccount(args, dir, live, out, err, "linux"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("usage: blimpd account use|forget <email>");
  }
});
