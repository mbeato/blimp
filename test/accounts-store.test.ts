// Saved logins (src/accounts/store.ts): the private folder, the live login file put in place by a
// rename, state.json and the oauthAccount record. Everything happens in temp folders with made-up tokens.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetLogin, listSaved, putLive, readRecord, readState, saveLogin, writeState } from "../src/accounts/store";

const root = realpathSync(mkdtempSync(join(tmpdir(), "blimp-accounts-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `t${++n}`, "accounts");

const creds = (tok: string, refreshExpires = 2e12) => JSON.stringify({ claudeAiOauth: { accessToken: tok, refreshToken: `r-${tok}`, expiresAt: 1, refreshTokenExpiresAt: refreshExpires } });
const acct = (id: string, email: string) => ({ accountUuid: id, emailAddress: email });
const mode = (p: string) => statSync(p).mode & 0o777;

describe("saveLogin", () => {
  test("writes both files as given, 600 in 700 folders, no temp file left; a save without the account keeps account.json", () => {
    const dir = fresh();
    saveLogin("id-a", creds("tok-A"), acct("id-a", "a@x.com"), dir);
    const sub = join(dir, "id-a");
    expect(readFileSync(join(sub, "credentials.json"), "utf8")).toBe(creds("tok-A"));
    expect(JSON.parse(readFileSync(join(sub, "account.json"), "utf8"))).toEqual(acct("id-a", "a@x.com"));
    expect(mode(join(sub, "credentials.json"))).toBe(0o600);
    expect(mode(join(sub, "account.json"))).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(mode(sub)).toBe(0o700);
    expect(readdirSync(dir)).toEqual(["id-a"]);
    expect(readdirSync(sub).sort()).toEqual(["account.json", "credentials.json"]);

    saveLogin("id-a", creds("tok-A2"), undefined, dir);
    expect(readFileSync(join(sub, "credentials.json"), "utf8")).toBe(creds("tok-A2"));
    expect(JSON.parse(readFileSync(join(sub, "account.json"), "utf8"))).toEqual(acct("id-a", "a@x.com"));
    expect(readdirSync(sub).sort()).toEqual(["account.json", "credentials.json"]);
  });

  test("folders that were opened up are made 700 again", () => {
    const dir = fresh();
    mkdirSync(join(dir, "id-a"), { recursive: true, mode: 0o755 });
    saveLogin("id-a", creds("tok-A"), undefined, dir);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "id-a"))).toBe(0o700);
  });
});

describe("ids", () => {
  test("an id that isn't letters, digits and dashes is refused, and nothing is written outside the folder", () => {
    const top = join(root, "ids");
    const dir = join(top, "accounts");
    saveLogin("id-a", creds("tok-A"), undefined, dir);
    const live = join(top, "live.json");
    expect(() => saveLogin("../x", creds("tok-X"), acct("x", "x@x.com"), dir)).toThrow();
    expect(() => putLive("a/b", live, dir)).toThrow();
    expect(() => forgetLogin("", dir)).toThrow();
    expect(readdirSync(top)).toEqual(["accounts"]);
    expect(readdirSync(dir)).toEqual(["id-a"]);
    expect(existsSync(live)).toBe(false);
  });
});

describe("listSaved", () => {
  test("state.order first, then other folders by name; email and refresh expiry from the files; a folder with no login is skipped", () => {
    const dir = fresh();
    saveLogin("id-a", creds("tok-A", 111), acct("id-a", "a@x.com"), dir);
    saveLogin("id-b", creds("tok-B", 222), acct("id-b", "b@x.com"), dir);
    saveLogin("id-c", creds("tok-C", 333), acct("id-c", "c@x.com"), dir);
    mkdirSync(join(dir, "id-d"), { mode: 0o700 });
    writeFileSync(join(dir, "id-d", "account.json"), JSON.stringify(acct("id-d", "d@x.com")), { mode: 0o600 });
    const list = listSaved(dir, { order: ["id-b", "id-a"], out: {} });
    expect(list).toEqual([
      { id: "id-b", email: "b@x.com", expires: 222 },
      { id: "id-a", email: "a@x.com", expires: 111 },
      { id: "id-c", email: "c@x.com", expires: 333 },
    ]);
  });
});

describe("putLive", () => {
  test("puts a saved login in place byte for byte as a 600 regular file, replacing what was there", () => {
    const top = join(root, "live");
    const dir = join(top, "accounts");
    const live = join(top, ".credentials.json");
    saveLogin("id-a", creds("tok-A"), undefined, dir);
    writeFileSync(live, creds("tok-OTHER"), { mode: 0o600 });
    const mtime = putLive("id-a", live, dir);
    expect(readFileSync(live, "utf8")).toBe(creds("tok-A"));
    expect(mode(live)).toBe(0o600);
    expect(lstatSync(live).isSymbolicLink()).toBe(false);
    expect(lstatSync(live).isFile()).toBe(true);
    expect(mtime).toBe(statSync(live).mtimeMs);
    expect(readdirSync(top).sort()).toEqual([".credentials.json", "accounts"]);
  });

  test("an account that isn't saved is refused and the live file is left as it was", () => {
    const top = join(root, "nolive");
    const dir = join(top, "accounts");
    const live = join(top, ".credentials.json");
    mkdirSync(top);
    writeFileSync(live, creds("tok-OTHER"), { mode: 0o600 });
    expect(() => putLive("id-a", live, dir)).toThrow();
    expect(readFileSync(live, "utf8")).toBe(creds("tok-OTHER"));
    expect(readdirSync(top)).toEqual([".credentials.json"]);
  });
});

describe("state", () => {
  test("a missing folder or a broken file reads as empty; a written state reads back, 600", () => {
    const dir = fresh();
    expect(readState(dir)).toEqual({ order: [], out: {} });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "not json");
    expect(readState(dir)).toEqual({ order: [], out: {} });
    const s = { active: "id-a", order: ["id-a", "id-b"], out: { "id-b": { at: 1, until: 2 } }, switchedAt: 3, filed: { mtime: 4, record: "{}" } };
    writeState(s, dir);
    expect(readState(dir)).toEqual(s);
    expect(mode(join(dir, "state.json"))).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});

describe("readRecord", () => {
  test("oauthAccount's id, email and JSON; no file, bad JSON or no accountUuid is undefined", () => {
    const top = join(root, "record");
    mkdirSync(top);
    const file = join(top, ".claude.json");
    const oauthAccount = { accountUuid: "id-a", emailAddress: "a@x.com", organizationName: "x" };
    writeFileSync(file, JSON.stringify({ numStartups: 3, oauthAccount }));
    expect(readRecord(file)).toEqual({ id: "id-a", email: "a@x.com", raw: JSON.stringify(oauthAccount), account: oauthAccount });
    expect(readRecord(join(top, "none.json"))).toBeUndefined();
    writeFileSync(file, "{ not json");
    expect(readRecord(file)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "a@x.com" } }));
    expect(readRecord(file)).toBeUndefined();
  });
});

describe("forgetLogin", () => {
  test("removes the account's folder; a second time does nothing", () => {
    const dir = fresh();
    saveLogin("id-a", creds("tok-A"), acct("id-a", "a@x.com"), dir);
    saveLogin("id-b", creds("tok-B"), acct("id-b", "b@x.com"), dir);
    forgetLogin("id-a", dir);
    expect(readdirSync(dir)).toEqual(["id-b"]);
    forgetLogin("id-a", dir);
    expect(readdirSync(dir)).toEqual(["id-b"]);
  });
});
