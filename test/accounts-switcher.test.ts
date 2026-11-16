// The switcher (src/accounts/switcher.ts) on stand-ins: a temp accounts folder and live login file, a
// settable clock, and fakes for the sessions, the typist and the phone. Tokens are made up.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_AFTER_MS, OUT_MS, QUIET_MS } from "../src/accounts/rules";
import { liveMtime, putLive, type Rec, readState, saveLogin, writeState } from "../src/accounts/store";
import { type Stop, Switcher, type SwitcherDeps } from "../src/accounts/switcher";

const root = realpathSync(mkdtempSync(join(tmpdir(), "blimp-switcher-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const T = 1_800_000_000_000;
const creds = (tok: string, refreshExpires = 2e12) => JSON.stringify({ claudeAiOauth: { accessToken: tok, refreshToken: `r-${tok}`, expiresAt: 1, refreshTokenExpiresAt: refreshExpires } });
const acct = (id: string, email: string) => ({ accountUuid: id, emailAddress: email });
const rec = (id: string, email: string): Rec => ({ id, email, raw: JSON.stringify(acct(id, email)), account: acct(id, email) });
const limit = (session: string, at: number, error = "rate_limit"): Stop => ({ session, at, error });

// id-a and id-b saved, id-a's login live and filed, state as the brief seeds it.
function setup(started = 0) {
  const top = join(root, `t${++n}`);
  const dir = join(top, "accounts");
  const live = join(top, "claude", ".credentials.json");
  mkdirSync(join(top, "claude"), { recursive: true });
  saveLogin("id-a", creds("tok-A"), acct("id-a", "a@x.com"), dir);
  saveLogin("id-b", creds("tok-B"), acct("id-b", "b@x.com"), dir);
  const mtime = putLive("id-a", live, dir);
  writeState({ active: "id-a", order: ["id-a", "id-b"], out: {}, filed: { mtime, record: rec("id-a", "a@x.com").raw } }, dir);
  const t = {
    dir,
    live,
    clock: T,
    rec: rec("id-a", "a@x.com") as Rec | undefined,
    stops: [] as Stop[] | (() => Promise<Stop[]>),
    menus: new Set<string>(),
    refuse: new Set<string>(),
    typed: [] as string[],
    told: [] as { title: string; body: string }[],
    logs: [] as Record<string, unknown>[],
    waits: [] as number[],
  };
  const deps: SwitcherDeps = {
    dir,
    live,
    record: () => t.rec,
    stops: async () => (typeof t.stops === "function" ? t.stops() : t.stops),
    menu: (s) => t.menus.has(s),
    type: async (s) => {
      t.typed.push(s);
      if (t.refuse.has(s)) throw new Error("the session is asking something");
    },
    tell: async (title, body) => void t.told.push({ title, body }),
    now: () => t.clock,
    wait: async (ms) => void t.waits.push(ms),
    log: (e) => void t.logs.push(e),
  };
  return { t, deps, sw: new Switcher(deps, started) };
}

// The live file changed by someone else (a /login or a renewal), with an mtime of its own so it can't
// land in the same clock tick as the last write.
let stamp = 1_000_000;
function rewrite(live: string, text: string) {
  writeFileSync(live, text);
  stamp += 10;
  utimesSync(live, stamp, stamp);
}
const saved = (dir: string, id: string) => readFileSync(join(dir, id, "credentials.json"), "utf8");

// Case 1, reused by the cases that start after a switch.
async function switched() {
  const r = setup();
  r.t.stops = [limit("s1", T)];
  await r.sw.tick();
  return r;
}

test("a limit stop switches to the next account, continues the session and tells", async () => {
  const { t } = await switched();
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
  const s = readState(t.dir);
  expect(s.active).toBe("id-b");
  expect(s.out["id-a"].until).toBe(T + OUT_MS);
  expect(s.switchedAt).toBe(T);
  expect(t.typed).toEqual(["s1"]);
  expect(t.waits).toEqual([3000]);
  expect(t.told.length).toBe(1);
  expect(t.told[0].title).toBe("Now on b@x.com");
  expect(t.told[0].body).toContain("a@x.com ran out");
  expect(t.told[0].body).toContain("1 session continued");
  expect(t.logs).toContainEqual({ event: "switch", from: "id-a", to: "id-b" });
});

test("several sessions stopping in one tick give one switch; the same stops again do nothing", async () => {
  const { t, sw } = setup();
  t.stops = [limit("s1", T), limit("s2", T - 100), limit("s3", T - 200, "billing_error")];
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.typed).toEqual(["s1", "s2", "s3"]);
  expect(t.told.length).toBe(1);
  expect(t.told[0].body).toContain("3 sessions continued");
  t.clock = T + 1000;
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.typed.length).toBe(3);
  expect(t.told.length).toBe(1);
});

test("a limit stop in the quiet time is continued without a switch; one after it marks the account out, and every account out is told once", async () => {
  const { t, sw } = await switched();
  t.stops = [limit("s1", T), limit("s2", T + 10_000)];
  t.clock = T + 11_000;
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.typed).toEqual(["s1", "s2"]);
  expect(t.told.length).toBe(1);

  t.stops = [limit("s1", T), limit("s2", T + 10_000), limit("s3", T + QUIET_MS + 1)];
  t.clock = T + QUIET_MS + 2000;
  await sw.tick();
  const s = readState(t.dir);
  expect(s.active).toBe("id-b");
  expect(s.out["id-b"].until).toBe(T + QUIET_MS + 2000 + OUT_MS);
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
  expect(t.told.length).toBe(2);
  expect(t.told[1]).toEqual({ title: "Every Claude account is out", body: "blimp will switch when one is back." });

  // The same stop asks once: the out time doesn't slide forward while it stays stopped.
  t.clock = T + QUIET_MS + 3000;
  await sw.tick();
  expect(readState(t.dir).out["id-b"].until).toBe(T + QUIET_MS + 2000 + OUT_MS);
  expect(t.told.length).toBe(2);

  // Another stop while every account is still out isn't told again.
  t.stops = [limit("s1", T), limit("s2", T + 10_000), limit("s3", T + QUIET_MS + 1), limit("s4", T + QUIET_MS + 3500)];
  t.clock = T + QUIET_MS + 4000;
  await sw.tick();
  expect(t.told.length).toBe(2);
  expect(t.typed).toEqual(["s1", "s2"]);
});

test("a stop with another error is logged and does nothing else", async () => {
  const { t, sw } = setup();
  t.stops = [limit("s1", T, "overloaded")];
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-a");
  expect(t.typed).toEqual([]);
  expect(t.told).toEqual([]);
  expect(t.logs).toEqual([{ event: "stop", session: "s1", error: "overloaded", details: undefined, message: undefined, account: "id-a" }]);
});

test("a stop from before blimpd started doesn't switch", async () => {
  const { t, sw } = setup(1000);
  t.stops = [limit("s1", 500)];
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-a");
  expect(t.typed).toEqual([]);
});

test("a session showing a menu is left alone, one that refuses is counted as left", async () => {
  const { t, sw } = setup();
  t.stops = [limit("s1", T), limit("s2", T), limit("s3", T)];
  t.menus.add("s1");
  t.refuse.add("s2");
  await sw.tick();
  expect(t.typed).toEqual(["s2", "s3"]);
  expect(t.told[0].body).toBe("a@x.com ran out. 1 session continued. 2 left as they were.");
  expect(t.logs).toContainEqual({ event: "not continued", session: "s2", error: "the session is asking something" });
});

test("a new login is filed under its account once the live file has been changed for 2 minutes", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-C"));
  t.rec = rec("id-c", "c@x.com");
  await sw.tick();
  expect(existsSync(join(t.dir, "id-c"))).toBe(false);
  t.clock = T + FILE_AFTER_MS;
  await sw.tick();
  expect(saved(t.dir, "id-c")).toBe(creds("tok-C"));
  expect(JSON.parse(readFileSync(join(t.dir, "id-c", "account.json"), "utf8"))).toEqual(acct("id-c", "c@x.com"));
  const s = readState(t.dir);
  expect(s.active).toBe("id-c");
  expect(s.order.at(-1)).toBe("id-c");
  expect(s.filed).toEqual({ mtime: liveMtime(t.live)!, record: rec("id-c", "c@x.com").raw });
  expect(t.logs).toContainEqual({ event: "login", account: "id-c" });
});

test("after a switch, a renewal is filed under the active account, not the one the record names", async () => {
  const { t, sw } = await switched();
  t.stops = [];
  rewrite(t.live, creds("tok-B2"));
  t.clock = T + 1000;
  await sw.tick();
  t.clock = T + 1000 + FILE_AFTER_MS;
  await sw.tick();
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B2"));
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.logs).toContainEqual({ event: "renewal", account: "id-b" });
});

test("a swap files the live login first", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-A2"));
  t.stops = [limit("s1", T)];
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A2"));
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
});

test("use switches by hand: nothing marked out, no continue; an unknown or expired account throws first", async () => {
  const { t, sw } = setup();
  await sw.use("id-b");
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
  const s = readState(t.dir);
  expect(s.active).toBe("id-b");
  expect(s.out).toEqual({});
  expect(t.typed).toEqual([]);
  expect(t.told).toEqual([{ title: "Now on b@x.com", body: "Switched by hand." }]);
  expect(t.logs).toContainEqual({ event: "switch", from: "id-a", to: "id-b", byHand: true });

  saveLogin("id-c", creds("tok-C", 1), acct("id-c", "c@x.com"), t.dir);
  await expect(sw.use("nope")).rejects.toThrow("no saved login for that account");
  await expect(sw.use("id-c")).rejects.toThrow("that account's login has expired; log in to it again with /login");
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
  expect(readState(t.dir).active).toBe("id-b");
});

test("no token reaches the log or the phone", async () => {
  const { t, sw } = await switched();
  rewrite(t.live, creds("tok-C"));
  t.rec = rec("id-c", "c@x.com");
  t.clock = T + 1000;
  await sw.tick();
  t.clock = T + 1000 + FILE_AFTER_MS;
  await sw.tick();
  expect(saved(t.dir, "id-c")).toBe(creds("tok-C"));
  expect(t.logs.length).toBeGreaterThan(2);
  for (const e of [...t.logs, ...t.told]) expect(JSON.stringify(e)).not.toContain("tok-");
});

test("a tick never throws, and the next one works", async () => {
  const { t, sw } = setup();
  t.stops = () => Promise.reject(new Error("zmx went away"));
  await sw.tick();
  t.stops = [limit("s1", T)];
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.typed).toEqual(["s1"]);
});

test("a tick still running makes the next return at once", async () => {
  const { t, deps } = setup();
  let release = () => {};
  const sw = new Switcher({ ...deps, wait: () => new Promise<void>((r) => (release = r)) }, 0);
  let reads = 0;
  t.stops = async () => {
    reads++;
    return [limit("s1", T)];
  };
  const first = sw.tick();
  await Bun.sleep(10);
  await sw.tick();
  expect(reads).toBe(1);
  expect(t.typed).toEqual([]);
  release();
  await first;
  expect(t.typed).toEqual(["s1"]);
});

test("an old limit stop is continued when another session's stop causes a switch", async () => {
  const { t, sw } = setup(T);
  t.stops = [limit("old", T - 3_600_000), limit("s1", T)];
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.typed).toEqual(["old", "s1"]);
});

test("with no switch in the tick, a limit stop from before the last switch gets nothing", async () => {
  const { t, sw } = await switched();
  t.stops = [limit("s1", T), limit("s9", T - 1)];
  t.clock = T + 5000;
  await sw.tick();
  expect(t.typed).toEqual(["s1"]);
  expect(readState(t.dir).active).toBe("id-b");
});

test("a swap made by another process counts as filed, and the next limit starts from its state", async () => {
  const { t, deps, sw } = setup();
  await sw.tick();
  await new Switcher(deps, 0).use("id-b");
  t.clock = T + FILE_AFTER_MS;
  await sw.tick();
  expect(t.logs.filter((e) => e.event === "renewal" || e.event === "login" || e.event === "unfiled")).toEqual([]);
  t.stops = [limit("s1", T + FILE_AFTER_MS)];
  await sw.tick();
  const s = readState(t.dir);
  expect(s.active).toBe("id-a");
  expect(s.out["id-b"]).toBeDefined();
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-A"));
});
