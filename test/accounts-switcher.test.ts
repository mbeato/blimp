// The switcher (src/accounts/switcher.ts) on stand-ins: a temp accounts folder and live login file, a
// settable clock, and fakes for the sessions, the typist and the phone. Tokens are made up.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_AFTER_MS, OUT_MS, QUIET_MS } from "../src/accounts/rules";
import { liveMtime, putLive, type Rec, readState, saveLogin, writeState } from "../src/accounts/store";
import { menuOn, readStops, type Stop, Switcher, type SwitcherDeps } from "../src/accounts/switcher";
import { writeHookStatus } from "../src/hooks";

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
// A swap made outside this switcher (state.json not written), with an mtime of its own likewise.
function swapped(live: string, dir: string, id: string) {
  putLive(id, live, dir);
  stamp += 10;
  utimesSync(live, stamp, stamp);
  return liveMtime(live)!;
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
  expect(t.told[1]).toEqual({ title: "Every Claude account is out", body: "Claude Code carries on by itself when a limit resets." });

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

test("a stop from before blimpd started doesn't switch; one at the start does", async () => {
  const { t, sw } = setup(T);
  t.stops = [limit("s1", T - 1)];
  await sw.tick();
  const s = readState(t.dir);
  expect(s.active).toBe("id-a");
  expect(s.out).toEqual({});
  expect(t.typed).toEqual([]);
  expect(t.told).toEqual([]);
  t.stops = [limit("s1", T)];
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
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

test("readStops keeps a stop only from the Claude session that wrote it", () => {
  const status = join(root, "status-stops");
  const now = Date.now();
  const created = Math.floor(now / 1000) - 60;
  const fail = (name: string) =>
    writeHookStatus(JSON.stringify({ hook_event_name: "StopFailure", session_id: `sid-${name}`, error: "rate_limit", error_details: "429", last_assistant_message: "API Error" }), name, status);
  for (const name of ["cur", "old", "glm", "noid", "later"]) fail(name);
  writeHookStatus(JSON.stringify({ hook_event_name: "Stop", session_id: "sid-later" }), "later", status);
  writeFileSync(join(status, "noat.json"), JSON.stringify({ state: "done", event: "StopFailure", failure: "rate_limit", sessionId: "sid-noat" }));
  writeFileSync(join(status, "textat.json"), JSON.stringify({ state: "done", at: String(now), event: "StopFailure", failure: "rate_limit", sessionId: "sid-textat" }));
  const sess = (name: string, o: object = {}) => ({ name, kind: "claude", created, sessionId: `sid-${name}`, ...o });
  const stops = readStops(
    [sess("cur"), sess("old", { created: Math.floor(now / 1000) + 3600 }), sess("glm", { kind: "claude-glm" }), sess("noid", { sessionId: undefined }), sess("later"), sess("noat"), sess("textat"), sess("none")],
    status,
  );
  expect(stops.length).toBe(1);
  expect(stops[0]).toEqual({ session: "cur", at: expect.any(Number), error: "rate_limit", details: "429", message: "API Error" });
  expect(stops[0].at).toBeGreaterThanOrEqual(created * 1000);
});

test("menuOn: a cursor on a numbered row or a confirm footer is a menu; Claude's prompt isn't; an unread screen counts as one", () => {
  const prompt = ["⏺ Done. Two things changed:", "", "  1. The tests", "  2. The docs", "", "─────────────", "❯ ", "─────────────", "  ? for shortcuts"].join("\n");
  const limitMenu = [" What do you want to do?", "", " ❯ 1. Stop and wait for limit to reset", "   2. Switch to extra usage", "   3. Upgrade your plan"].join("\n");
  const confirm = [" Switch model?", " Opus 5.5 is now the default.", "", " Enter to confirm · Esc to cancel"].join("\n");
  expect(menuOn(prompt)).toBe(false);
  expect(menuOn(limitMenu)).toBe(true);
  expect(menuOn(confirm)).toBe(true);
  expect(menuOn("")).toBe(true);
  expect(menuOn("\n\n")).toBe(true);
  // Only the last 40 lines count: a menu scrolled further up is gone.
  expect(menuOn([limitMenu, ...Array(40).fill("⏺ later output"), prompt].join("\n"))).toBe(false);
});

test("a swap whose state write was lost is adopted on the next tick, not filed over the old account", async () => {
  const { t, sw } = setup();
  await sw.tick();
  swapped(t.live, t.dir, "id-b");
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  const s = readState(t.dir);
  expect(s.active).toBe("id-b");
  expect(s.filed?.mtime).toBe(liveMtime(t.live)!);
  expect(t.logs).toContainEqual({ event: "adopted", account: "id-b" });
  expect(t.logs.some((e) => e.event === "renewal" || e.event === "login")).toBe(false);
});

test("the stop behind a lost state write doesn't switch back once the swap is adopted", async () => {
  const { t, sw } = setup();
  const mtime = swapped(t.live, t.dir, "id-b");
  t.stops = [limit("s1", mtime - 1000)];
  await sw.tick();
  const s = readState(t.dir);
  expect(s.active).toBe("id-b");
  expect(s.out).toEqual({});
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
});

test("a live file with no login in it is noted as unfiled once, and nothing throws", async () => {
  const { t, sw } = setup();
  rewrite(t.live, JSON.stringify({ mcpOAuth: {} }));
  for (const c of [T, T + FILE_AFTER_MS, T + 2 * FILE_AFTER_MS]) {
    t.clock = c;
    await sw.tick();
  }
  expect(t.logs.filter((e) => e.event === "unfiled").length).toBe(1);
  expect(t.logs.filter((e) => e.event === "error")).toEqual([]);
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readState(t.dir).filed?.mtime).toBe(liveMtime(t.live)!);
});

test("a session that leaves the stop list during the wait, or stops again, isn't typed into", async () => {
  const { t, sw } = setup();
  let reads = 0;
  t.stops = async () => (++reads === 1 ? [limit("s1", T), limit("s2", T), limit("s3", T)] : [limit("s1", T), limit("s3", T + 500)]);
  await sw.tick();
  expect(reads).toBe(2);
  expect(t.typed).toEqual(["s1"]);
  expect(t.told[0].body).toBe("a@x.com ran out. 1 session continued.");
});

test("a login made by hand gets the quiet time: a limit stop 5 s after it doesn't switch, one 31 s after does", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-C"));
  const mtime = liveMtime(t.live)!;
  t.rec = rec("id-c", "c@x.com");
  t.stops = [limit("s1", mtime + 5000)];
  await sw.tick();
  let s = readState(t.dir);
  expect(s.active).toBe("id-c");
  expect(s.out).toEqual({});
  expect(saved(t.dir, "id-c")).toBe(creds("tok-C"));
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-C"));

  t.stops = [limit("s1", mtime + 5000), limit("s2", mtime + 31_000)];
  t.clock = T + 1000;
  await sw.tick();
  s = readState(t.dir);
  expect(Object.keys(s.out)).toEqual(["id-c"]);
  expect(s.active).toBe("id-a");
});

test("a throw from menu for one session doesn't stop the others or the notification", async () => {
  const { t, deps } = setup();
  const sw = new Switcher(
    {
      ...deps,
      menu: (s) => {
        if (s === "s1") throw new Error("zmx went away");
        return false;
      },
    },
    0,
  );
  t.stops = [limit("s1", T), limit("s2", T)];
  await sw.tick();
  expect(t.typed).toEqual(["s2"]);
  expect(t.told[0].body).toBe("a@x.com ran out. 1 session continued. 1 left as they were.");
});

test("an account with no email is named by its id", async () => {
  const { t, sw } = setup();
  rmSync(join(t.dir, "id-a", "account.json"));
  rmSync(join(t.dir, "id-b", "account.json"));
  t.stops = [limit("s1", T)];
  await sw.tick();
  expect(t.told[0]).toEqual({ title: "Now on id-b", body: "id-a ran out. 1 session continued." });
  await sw.use("id-a");
  expect(t.told[1]).toEqual({ title: "Now on id-a", body: "Switched by hand." });
});

test("an error that keeps coming back is logged once, a different one again", async () => {
  const { t, sw } = setup();
  let msg = "zmx went away";
  t.stops = () => Promise.reject(new Error(msg));
  for (let i = 0; i < 3; i++) await sw.tick();
  msg = "something else";
  await sw.tick();
  expect(t.logs).toEqual([
    { event: "error", error: "zmx went away" },
    { event: "error", error: "something else" },
  ]);
});

test("a fresh switcher adopts on its first tick a live login that is another account's, even with the mtime filed", async () => {
  const { t, deps } = setup();
  const mtime = swapped(t.live, t.dir, "id-b");
  writeState({ ...readState(t.dir), filed: { mtime, record: rec("id-a", "a@x.com").raw } }, t.dir);
  await new Switcher(deps, 0).tick();
  expect(readState(t.dir).active).toBe("id-b");
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(t.logs).toContainEqual({ event: "adopted", account: "id-b" });
});

test("a save that fails for another reason is retried, and nothing switches until it works", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-A2"));
  const before = readState(t.dir).filed;
  renameSync(join(t.dir, "id-a"), join(t.dir, "id-a.away"));
  writeFileSync(join(t.dir, "id-a"), "not a folder");
  t.stops = [limit("s1", T)];
  await sw.tick();
  await sw.tick();
  expect(readState(t.dir).filed).toEqual(before);
  expect(readState(t.dir).active).toBe("id-a");
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-A2"));
  expect(t.logs.some((e) => e.event === "unfiled")).toBe(false);
  expect(t.logs.filter((e) => e.event === "error").length).toBe(1);

  rmSync(join(t.dir, "id-a"));
  renameSync(join(t.dir, "id-a.away"), join(t.dir, "id-a"));
  t.clock = T + 1000;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A2"));
  expect(readState(t.dir).active).toBe("id-b");
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
});

test("a login seconds old isn't filed or switched on; once its record lands it is filed under its account", async () => {
  const { t, sw } = setup();
  writeFileSync(t.live, creds("tok-C"));
  utimesSync(t.live, (T - 1000) / 1000, (T - 1000) / 1000);
  t.stops = [limit("s1", T - 500)];
  await sw.tick();
  expect(existsSync(join(t.dir, "id-c"))).toBe(false);
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readState(t.dir).active).toBe("id-a");
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-C"));

  t.rec = rec("id-c", "c@x.com");
  t.clock = T + 11_000;
  await sw.tick();
  expect(saved(t.dir, "id-c")).toBe(creds("tok-C"));
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  const s = readState(t.dir);
  expect(s.active).toBe("id-c");
  expect(s.out).toEqual({});
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-C"));
});

test("a re-read of the stops that throws is tried again", async () => {
  const { t, sw } = setup();
  let reads = 0;
  t.stops = async () => {
    if (++reads === 2) throw new Error("zmx went away");
    return [limit("s1", T)];
  };
  await sw.tick();
  expect(reads).toBe(3);
  expect(t.typed).toEqual(["s1"]);
  expect(t.told[0].body).toBe("a@x.com ran out. 1 session continued.");
});

test("a re-read that can't be done types into nobody, and the notification says so", async () => {
  const { t, sw } = setup();
  let reads = 0;
  t.stops = async () => {
    if (++reads > 1) throw new Error("zmx went away");
    return [limit("s1", T)];
  };
  await sw.tick();
  expect(reads).toBe(5);
  expect(t.waits).toEqual([3000, 1000, 1000, 1000]);
  expect(t.typed).toEqual([]);
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.told[0]).toEqual({ title: "Now on b@x.com", body: "a@x.com ran out. blimp could not read the sessions, so none was continued." });
});

test("errors that differ only in a temp file's name are logged once, and again after 10 minutes", async () => {
  const { t, sw } = setup();
  let n = 0;
  t.stops = () => Promise.reject(new Error(`ENOENT: no such file or directory, open '/x/accounts/.tmp-${(++n).toString(16).padStart(12, "a")}'`));
  for (let i = 0; i < 3; i++) await sw.tick();
  expect(t.logs.length).toBe(1);
  t.clock = T + 600_000;
  await sw.tick();
  expect(t.logs.length).toBe(2);
  expect(t.logs[1].event).toBe("error");
});

test("a thrown value with no message is still logged", async () => {
  const { t, sw } = setup();
  t.stops = () => Promise.reject("zmx said no");
  await sw.tick();
  expect(t.logs).toEqual([{ event: "error", error: "zmx said no" }]);
});
