// The switcher (src/accounts/switcher.ts) on stand-ins: a temp accounts folder and live login file, a
// settable clock, and fakes for the sessions, the typist and the phone. Tokens are made up.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGIN_RECORD_MS, OUT_MS, QUIET_MS, SETTLE_MS } from "../src/accounts/rules";
import { liveMtime, putLive, type Rec, readState, saveLogin, writeState } from "../src/accounts/store";
import { menuOn, readStops, type Stop, Switcher, type SwitcherDeps } from "../src/accounts/switcher";
import { writeHookStatus } from "../src/hooks";

const root = realpathSync(mkdtempSync(join(tmpdir(), "blimp-switcher-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const T = 1_900_000_000_000; // ahead of the real clock, so the real mtime of a swap is always in the past
const creds = (tok: string, refreshExpires = 2e12) => JSON.stringify({ claudeAiOauth: { accessToken: tok, refreshToken: `r-${tok}`, expiresAt: 1, refreshTokenExpiresAt: refreshExpires } });
const acct = (id: string, email: string) => ({ accountUuid: id, emailAddress: email });
const OLD = T - 7200_000; // a record fetched long before the seeded settle
// The account record (.claude.json's oauthAccount), fetched at fetchedAt.
const rec = (id: string, email: string, fetchedAt?: number): Rec => {
  const account = { ...acct(id, email), ...(fetchedAt !== undefined && { profileFetchedAt: fetchedAt }) };
  return { id, email, ...(fetchedAt !== undefined && { fetchedAt }), account };
};
const limit = (session: string, at: number, error = "rate_limit"): Stop => ({ session, at, error });

// id-a and id-b saved, id-a's login live and filed an hour before T, the record naming id-a fetched before that.
function setup(started = 0) {
  const top = join(root, `t${++n}`);
  const dir = join(top, "accounts");
  const live = join(top, "claude", ".credentials.json");
  mkdirSync(join(top, "claude"), { recursive: true });
  saveLogin("id-a", creds("tok-A"), acct("id-a", "a@x.com"), dir);
  saveLogin("id-b", creds("tok-B"), acct("id-b", "b@x.com"), dir);
  const mtime = putLive("id-a", live, dir);
  writeState({ active: "id-a", order: ["id-a", "id-b"], out: {}, filed: { mtime, at: T - 3600_000 } }, dir);
  const t = {
    dir,
    live,
    clock: T,
    rec: rec("id-a", "a@x.com", OLD) as Rec | undefined,
    note: undefined as number | undefined, // when the hook last noted a /login
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
    loginSeen: () => t.note,
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

// The live file changed by someone else (a /login or a renewal) at a given time (ms), which the test
// sets so the change's age is known.
function rewrite(live: string, text: string, at: number) {
  writeFileSync(live, text);
  utimesSync(live, at / 1000, at / 1000);
}
let stamp = 1_000_000;
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
  expect(t.logs).toContainEqual({ event: "switch", from: "id-a", to: "id-b", outUntil: T + OUT_MS });
});

// T is Mar 17 2030, 18:46 in Berlin (UTC+1 then).
const WEEKLY = "You've hit your weekly limit · resets 2pm (Europe/Berlin)"; // Mar 18, 13:00 UTC
const LATER = "You've hit your Fable limit · resets Mar 20, 9am (Europe/Berlin)"; // Mar 20, 08:00 UTC

test("a stop whose message names the reset time marks the account out until then, and the switch line says so", async () => {
  const { t, sw } = setup();
  t.stops = [{ ...limit("s1", T), message: WEEKLY }];
  await sw.tick();
  expect(readState(t.dir).out["id-a"].until).toBe(Date.UTC(2030, 2, 18, 13));
  expect(t.logs).toContainEqual({ event: "switch", from: "id-a", to: "id-b", outUntil: Date.UTC(2030, 2, 18, 13) });
});

test("several asking stops: out until the latest reset any of them names; none names one: OUT_MS on", async () => {
  const two = setup();
  two.t.stops = [{ ...limit("s1", T), message: LATER }, { ...limit("s2", T - 100), message: WEEKLY }, limit("s3", T - 200, "billing_error")];
  await two.sw.tick();
  expect(readState(two.t.dir).out["id-a"].until).toBe(Date.UTC(2030, 2, 20, 8));

  const none = setup();
  none.t.stops = [{ ...limit("s1", T), message: "API Error: Rate limit reached" }];
  await none.sw.tick();
  expect(readState(none.t.dir).out["id-a"].until).toBe(T + OUT_MS);
});

test("a reset time is read at the stop's own time: one already past when the switch is made means OUT_MS on, not tomorrow", async () => {
  const { t, sw } = setup();
  // The stop came 5 s before the 6:46pm it names (17:46:00 UTC is T - 40 s); the tick that switches is at T.
  t.stops = [{ ...limit("s1", T - 45_000), message: "You've hit your weekly limit · resets 6:46pm (Europe/Berlin)" }];
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
  expect(readState(t.dir).out["id-a"].until).toBe(T + OUT_MS);
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

test("case 6: a /login to a new account is filed under it once the change is 30 seconds old", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-C"), T);
  t.note = T + 100;
  t.rec = rec("id-c", "c@x.com", T + 200);
  t.clock = T + SETTLE_MS - 1;
  await sw.tick();
  expect(existsSync(join(t.dir, "id-c"))).toBe(false);
  t.clock = T + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-c")).toBe(creds("tok-C"));
  expect(JSON.parse(readFileSync(join(t.dir, "id-c", "account.json"), "utf8"))).toEqual(rec("id-c", "c@x.com", T + 200).account);
  const s = readState(t.dir);
  expect(s.active).toBe("id-c");
  expect(s.order.at(-1)).toBe("id-c");
  expect(s.filed).toEqual({ mtime: liveMtime(t.live)!, at: T + SETTLE_MS });
  expect(t.logs).toContainEqual({ event: "login", account: "id-c" });
});

test("after a switch, a renewal is filed under the active account, not the one the record names", async () => {
  const { t, sw } = await switched();
  t.stops = [];
  rewrite(t.live, creds("tok-B2"), T + 1000);
  t.clock = T + 1000;
  await sw.tick();
  t.clock = T + 1000 + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B2"));
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.logs).toContainEqual({ event: "renewal", account: "id-b" });
  // A renewal doesn't write the record into account.json: the record still names id-a.
  expect(JSON.parse(readFileSync(join(t.dir, "id-b", "account.json"), "utf8"))).toEqual(acct("id-b", "b@x.com"));
});

test("a swap files the live login first", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-A2"), T - 40_000);
  t.stops = [limit("s1", T)];
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A2"));
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
});

test("use switches by hand: nothing marked out, no continue; an unknown or expired account throws first", async () => {
  const { t, sw } = setup();
  expect(await sw.use("id-b")).toBe(false);
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
  const s = readState(t.dir);
  expect(s.active).toBe("id-b");
  expect(s.out).toEqual({});
  expect(s.switchedAt).toBe(T);
  expect(s.filed).toEqual({ mtime: liveMtime(t.live)!, at: T });
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
  rewrite(t.live, creds("tok-C"), T + 1000);
  t.note = T + 1100;
  t.rec = rec("id-c", "c@x.com", T + 1200);
  t.clock = T + 1000 + SETTLE_MS;
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
  await sw.tick();
  t.clock = T + SETTLE_MS;
  await sw.tick();
  expect(t.logs.filter((e) => e.event === "renewal" || e.event === "login" || e.event === "unfiled" || e.event === "adopted")).toEqual([]);
  t.clock = T + QUIET_MS + 2000;
  t.stops = [limit("s1", T + QUIET_MS + 1000)];
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
  expect(s.filed).toEqual({ mtime: liveMtime(t.live)!, at: T });
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
  rewrite(t.live, JSON.stringify({ mcpOAuth: {} }), T);
  for (const c of [T, T + SETTLE_MS, T + 2 * SETTLE_MS]) {
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
  rewrite(t.live, creds("tok-C"), T - 40_000);
  const mtime = liveMtime(t.live)!;
  t.note = T - 39_900;
  t.rec = rec("id-c", "c@x.com", T - 39_800);
  t.stops = [limit("s1", mtime + 5000)];
  await sw.tick();
  let s = readState(t.dir);
  expect(s.active).toBe("id-c");
  expect(s.out).toEqual({});
  expect(saved(t.dir, "id-c")).toBe(creds("tok-C"));
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-C"));

  t.stops = [limit("s1", mtime + 5000), limit("s2", mtime + 31_000)];
  t.clock = T + 12_000;
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
  writeState({ ...readState(t.dir), filed: { mtime, at: T - 3600_000 } }, t.dir);
  await new Switcher(deps, 0).tick();
  expect(readState(t.dir).active).toBe("id-b");
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(t.logs).toContainEqual({ event: "adopted", account: "id-b" });
});

test("a save that fails for another reason is retried, and nothing switches until it works", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-A2"), T - 40_000);
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
  rewrite(t.live, creds("tok-C"), T - 1000);
  t.note = T - 900;
  t.stops = [limit("s1", T - 500)];
  await sw.tick();
  expect(existsSync(join(t.dir, "id-c"))).toBe(false);
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readState(t.dir).active).toBe("id-a");
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-C"));

  t.rec = rec("id-c", "c@x.com", T + 5000);
  t.clock = T + 29_000;
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

// The rule for whose login a changed live file is (final-fix-wave.md, the amended table).

test("case 1: the record restamped before a switch, then a renewal: saved under the account switched to", async () => {
  const { t, sw } = setup();
  t.rec = rec("id-a", "a@x.com", T + 500);
  t.clock = T + 1000;
  t.stops = [limit("s1", T + 1000)];
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
  t.stops = [];
  rewrite(t.live, creds("tok-B2"), T + 2000);
  t.clock = T + 2000 + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B2"));
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.logs).toContainEqual({ event: "renewal", account: "id-b" });
});

test("case 2: a renewal after a switch whose refresh restamps the record but keeps the old account: saved under the active one", async () => {
  const { t, sw } = await switched();
  t.stops = [];
  rewrite(t.live, creds("tok-B2"), T + 2000);
  t.rec = rec("id-a", "a@x.com", T + 2000);
  t.clock = T + 2000 + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B2"));
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.logs).toContainEqual({ event: "renewal", account: "id-b" });
});

test("case 3: after a switch, a /login back to the account the record names is filed as its login, with the quiet time", async () => {
  const { t, sw } = await switched();
  t.stops = [];
  rewrite(t.live, creds("tok-A9"), T + 5000);
  t.note = T + 5100;
  t.rec = rec("id-a", "a@x.com", T + 5200);
  t.clock = T + 5000 + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A9"));
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B"));
  const s = readState(t.dir);
  expect(s.active).toBe("id-a");
  expect(s.switchedAt).toBe(liveMtime(t.live)!);
  expect(t.logs).toContainEqual({ event: "login", account: "id-a" });
});

test("case 4: no state.json, the live login equal to id-a's copy: adopted, then a switch and a renewal go under id-b", async () => {
  const { t, sw } = setup();
  rmSync(join(t.dir, "state.json"));
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-a");
  expect(t.logs).toContainEqual({ event: "adopted", account: "id-a" });
  t.clock = T + 1000;
  t.stops = [limit("s1", T + 1000)];
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
  t.stops = [];
  rewrite(t.live, creds("tok-B2"), T + 2000);
  t.clock = T + 2000 + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B2"));
  expect(readState(t.dir).active).toBe("id-b");
});

test("case 5: no state.json and a live login no copy holds: filed as a login under the account the record names", async () => {
  const { t, sw } = setup();
  rmSync(join(t.dir, "state.json"));
  rewrite(t.live, creds("tok-C"), T - 40_000);
  t.rec = rec("id-c", "c@x.com", OLD);
  await sw.tick();
  expect(saved(t.dir, "id-c")).toBe(creds("tok-C"));
  expect(readState(t.dir).active).toBe("id-c");
  expect(t.logs).toContainEqual({ event: "login", account: "id-c" });
});

test("case 7: a /login whose record isn't rewritten is given up after 60 seconds, once: nothing is saved and the owner is unknown", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-X"), T);
  t.note = T + 100;
  for (const c of [T + SETTLE_MS, T + LOGIN_RECORD_MS - 1]) {
    t.clock = c;
    await sw.tick();
  }
  expect(t.logs).toEqual([]);
  expect(readState(t.dir).filed?.mtime).not.toBe(liveMtime(t.live)!);
  for (const c of [T + LOGIN_RECORD_MS, T + LOGIN_RECORD_MS + 1000]) {
    t.clock = c;
    await sw.tick();
  }
  expect(t.logs).toEqual([{ event: "unknown", why: "login without a record" }]);
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B"));
  expect(readState(t.dir).active).toBeUndefined();
  // That notice is used up, and the next change isn't saved under id-a: blimp can't tell whose it is.
  rewrite(t.live, creds("tok-X2"), T + 70_000);
  t.clock = T + 70_000 + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(t.logs.at(-1)).toEqual({ event: "held" });
});

test("case 8: a /login whose record turns fresh 40 seconds after the change is filed then, under the account it names", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-B9"), T);
  t.note = T + 100;
  t.clock = T + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B"));
  t.rec = rec("id-b", "b@x.com", T + 40_000);
  t.clock = T + 40_000;
  await sw.tick();
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B9"));
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.logs).toContainEqual({ event: "login", account: "id-b" });
});

test("case 9: a login note older than the last settle isn't a login: a renewal goes under the active account", async () => {
  const { t, sw } = setup();
  t.note = T - 7200_000;
  t.rec = rec("id-b", "b@x.com", T + 50);
  rewrite(t.live, creds("tok-A2"), T);
  t.clock = T + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A2"));
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B"));
  expect(readState(t.dir).active).toBe("id-a");
  expect(t.logs).toContainEqual({ event: "renewal", account: "id-a" });
});

test("a login note from before a switch isn't a login after it: the renewal goes under the account switched to", async () => {
  const { t, sw } = setup();
  t.clock = T + 1000;
  t.stops = [limit("s1", T + 1000)];
  rewrite(t.live, readFileSync(t.live, "utf8"), T - 60_000);
  writeState({ ...readState(t.dir), filed: { mtime: liveMtime(t.live)!, at: T - 3600_000 } }, t.dir);
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
  // The note is first seen after the switch. One seen before it, with nothing to file, is a late notice.
  t.note = T + 500;
  t.stops = [];
  t.rec = rec("id-a", "a@x.com", T + 2000);
  rewrite(t.live, creds("tok-B2"), T + 2000);
  t.clock = T + 2000 + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B2"));
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readState(t.dir).active).toBe("id-b");
});

test("use doesn't swap over a live login it couldn't save first", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-A2"), T - 40_000);
  renameSync(join(t.dir, "id-a"), join(t.dir, "id-a.away"));
  writeFileSync(join(t.dir, "id-a"), "not a folder");
  await expect(sw.use("id-b")).rejects.toThrow();
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-A2"));
  expect(readState(t.dir).active).toBe("id-a");
});

test("use doesn't swap over a /login still waiting for its record", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-C"), T - 40_000);
  t.note = T - 39_900;
  await expect(sw.use("id-b")).rejects.toThrow("a login made a moment ago isn't saved yet; try again in a minute");
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-C"));
  expect(readState(t.dir).active).toBe("id-a");
});

test("after a restart, an old stop in the last switch's quiet time isn't typed into", async () => {
  const { t, deps } = setup();
  writeState({ ...readState(t.dir), switchedAt: T - 3600_000 }, t.dir);
  t.stops = [limit("s1", T - 3600_000 + 5000)];
  await new Switcher(deps, T).tick();
  expect(t.typed).toEqual([]);
  expect(t.told).toEqual([]);
});

// When blimp can't tell whose login is in place (last-round.md).

const TITLE = "blimp can't tell which account is logged in";
const BODY = "The last /login was not saved. Run blimpd account use <email>, or /login again in a session.";
const prev = (dir: string, id: string) => join(dir, id, "credentials.prev.json");
// Whether any file in the accounts folder holds this text.
const anywhere = (dir: string, text: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).some((f) => statSync(join(dir, f)).isFile() && readFileSync(join(dir, f), "utf8").includes(text));

// Row A: a /login to id-c whose record never gets a profileFetchedAt, its notice a second after the
// change; given up at 60 s. Then two renewals of that login, and a limit stop.
async function rowA() {
  const r = setup();
  const { t, sw } = r;
  rewrite(t.live, creds("tok-C1"), T);
  t.rec = rec("id-c", "c@x.com");
  t.note = T + 1000;
  for (const c of [T + SETTLE_MS, T + LOGIN_RECORD_MS, T + LOGIN_RECORD_MS + 1000]) {
    t.clock = c;
    await sw.tick();
  }
  for (const [tok, at] of [
    ["tok-C2", T + 100_000],
    ["tok-C3", T + 200_000],
  ] as const) {
    rewrite(t.live, creds(tok), at);
    for (const c of [at + SETTLE_MS, at + SETTLE_MS + 1000]) {
      t.clock = c;
      await sw.tick();
    }
  }
  t.stops = [limit("s1", T + 300_000)];
  t.clock = T + 300_000;
  await sw.tick();
  t.stops = [];
  return r;
}

test("row A: a /login with no profileFetchedAt is given up: owner unknown, nothing saved; its renewals are held, a limit stop does nothing", async () => {
  const { t } = await rowA();
  const s = readState(t.dir);
  expect(s.unknown).toBe(true);
  expect(s.active).toBeUndefined();
  expect(s.out).toEqual({});
  expect(t.logs.map((e) => e.event)).toEqual(["unknown", "held", "held", "stop"]);
  expect(t.logs[0]).toEqual({ event: "unknown", why: "login without a record" });
  expect(t.told).toEqual([{ title: TITLE, body: BODY }]);
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B"));
  expect(existsSync(prev(t.dir, "id-a"))).toBe(false);
  expect(existsSync(prev(t.dir, "id-b"))).toBe(false);
  expect(existsSync(join(t.dir, "id-c"))).toBe(false);
  expect(anywhere(t.dir, "tok-C")).toBe(false);
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-C3"));
  expect(t.typed).toEqual([]);
});

test("row B: while the owner is unknown, a /login with a fresh record and a new notice is filed as its login", async () => {
  const { t, sw } = await rowA();
  rewrite(t.live, creds("tok-C9"), T + 400_000);
  t.rec = rec("id-c", "c@x.com", T + 399_900);
  t.note = T + 420_000;
  t.clock = T + 400_000 + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-c")).toBe(creds("tok-C9"));
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  const s = readState(t.dir);
  expect(s.unknown).toBeUndefined();
  expect(s.active).toBe("id-c");
  expect(t.logs.at(-1)).toEqual({ event: "login", account: "id-c" });
});

test("row C: while the owner is unknown, use puts the login in place, clears it, says the login in place wasn't saved, and saves it nowhere", async () => {
  const { t, sw } = await rowA();
  expect(await sw.use("id-b")).toBe(true);
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
  const s = readState(t.dir);
  expect(s.unknown).toBeUndefined();
  expect(s.active).toBe("id-b");
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B"));
  expect(existsSync(join(t.dir, "id-c"))).toBe(false);
  expect(anywhere(t.dir, "tok-C")).toBe(false);
  expect(t.logs.at(-1)).toEqual({ event: "switch", from: undefined, to: "id-b", byHand: true });
});

test("row D: while the owner is unknown, a live login equal to a saved one is adopted", async () => {
  const { t, sw } = await rowA();
  swapped(t.live, t.dir, "id-a");
  await sw.tick();
  const s = readState(t.dir);
  expect(s.unknown).toBeUndefined();
  expect(s.active).toBe("id-a");
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(t.logs.at(-1)).toEqual({ event: "adopted", account: "id-a" });
});

// A late notice (last-round.md, amendment 2): blimp tells and changes no file.

const WRONG = "A /login may have been saved under the wrong account";
// Every file under the accounts folder but state.json, with its text.
const files = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f !== "state.json" && statSync(join(dir, f)).isFile())
      .map((f) => [f, readFileSync(join(dir, f), "utf8")]),
  );

// A /login to id-c whose notice is slow: its change is filed at 30 s as a renewal of id-a.
async function filedAsRenewal() {
  const r = setup();
  const { t, sw } = r;
  t.rec = rec("id-c", "c@x.com", T - 100);
  rewrite(t.live, creds("tok-C1"), T);
  t.clock = T + SETTLE_MS;
  await sw.tick();
  return r;
}

test("row E: a /login's notice after its change was filed as a renewal is told once, naming that account; no file changes", async () => {
  const { t, sw } = await filedAsRenewal();
  const mtime = liveMtime(t.live)!;
  expect(saved(t.dir, "id-a")).toBe(creds("tok-C1"));
  expect(readFileSync(prev(t.dir, "id-a"), "utf8")).toBe(creds("tok-A"));
  expect(readState(t.dir).renewed).toEqual({ id: "id-a", at: mtime });
  const before = files(t.dir);

  t.note = T + SETTLE_MS + 5000;
  t.clock = T + SETTLE_MS + 5000;
  await sw.tick();
  expect(files(t.dir)).toEqual(before);
  const s = readState(t.dir);
  expect(s.active).toBe("id-a");
  expect(s.unknown).toBeUndefined();
  expect(s.renewed).toBeUndefined();
  expect(s.filed).toEqual({ mtime, at: T + SETTLE_MS + 5000 });
  expect(t.told).toEqual([{ title: WRONG, body: "Log in to a@x.com again with /login in a session." }]);
  expect(t.logs.at(-1)).toEqual({ event: "late login notice", account: "id-a", told: true });

  t.clock = T + SETTLE_MS + 6000;
  await sw.tick();
  expect(t.told.length).toBe(1);
  expect(t.logs.filter((e) => e.event === "late login notice").length).toBe(1);
});

test("a note used up by a late notice doesn't hold up the next renewal: it is filed at 30 seconds under the account in use", async () => {
  const { t, sw } = await filedAsRenewal();
  t.note = T + SETTLE_MS + 5000;
  t.clock = T + SETTLE_MS + 5000;
  await sw.tick();
  rewrite(t.live, creds("tok-C2"), T + 100_000);
  t.clock = T + 100_000 + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-C2"));
  expect(readState(t.dir).active).toBe("id-a");
  expect(t.logs.at(-1)).toEqual({ event: "renewal", account: "id-a" });
});

test("row E2: a late notice after a switch in the filing's tick is told the same way; no saved file changes and the account switched to stays", async () => {
  const { t, sw } = setup();
  saveLogin("id-b", creds("tok-B1"), undefined, t.dir);
  t.rec = rec("id-c", "c@x.com", T - 100);
  rewrite(t.live, creds("tok-C1"), T);
  t.stops = [limit("s1", T + 1000)];
  t.clock = T + 1000;
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-a");
  t.clock = T + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-C1"));
  expect(readFileSync(prev(t.dir, "id-a"), "utf8")).toBe(creds("tok-A"));
  expect(saved(t.dir, "id-b")).toBe(creds("tok-B1"));
  expect(readFileSync(prev(t.dir, "id-b"), "utf8")).toBe(creds("tok-B"));
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B1"));
  expect(readState(t.dir).active).toBe("id-b");
  const before = files(t.dir);

  t.stops = [];
  t.note = T + SETTLE_MS + 5000;
  t.clock = T + SETTLE_MS + 5000;
  await sw.tick();
  expect(files(t.dir)).toEqual(before);
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B1"));
  const s = readState(t.dir);
  expect(s.active).toBe("id-b");
  expect(s.unknown).toBeUndefined();
  expect(s.renewed).toBeUndefined();
  expect(t.told.map((x) => x.title)).toEqual(["Now on b@x.com", WRONG]);
  expect(t.told[1].body).toBe("Log in to a@x.com again with /login in a session.");
  expect(t.logs.at(-1)).toEqual({ event: "late login notice", account: "id-a", told: true });
});

test("a late notice is still told when the same tick finds every account out", async () => {
  const { t, sw } = setup();
  t.rec = rec("id-c", "c@x.com", T - 100);
  rewrite(t.live, creds("tok-C1"), T);
  t.stops = [limit("s1", T + 1000)];
  t.clock = T + SETTLE_MS;
  await sw.tick();
  expect(readState(t.dir).active).toBe("id-b");
  t.stops = [limit("s1", T + 1000), limit("s2", T + SETTLE_MS + QUIET_MS + 1000)];
  t.note = T + SETTLE_MS + QUIET_MS + 2000;
  t.clock = T + SETTLE_MS + QUIET_MS + 2000;
  await sw.tick();
  expect(t.told.map((x) => x.title)).toEqual(["Now on b@x.com", "Every Claude account is out", WRONG]);
  expect(saved(t.dir, "id-a")).toBe(creds("tok-C1"));
  expect(readState(t.dir).active).toBe("id-b");
});

test("row F: a late notice 10 minutes after the last renewal-filing tells nothing; the note is used up and no file changes", async () => {
  const { t, sw } = await filedAsRenewal();
  const mtime = liveMtime(t.live)!;
  const before = files(t.dir);
  t.note = mtime + 600_000;
  t.clock = mtime + 600_000;
  await sw.tick();
  expect(files(t.dir)).toEqual(before);
  const s = readState(t.dir);
  expect(s.active).toBe("id-a");
  expect(s.unknown).toBeUndefined();
  expect(s.renewed).toBeUndefined();
  expect(s.filed).toEqual({ mtime, at: mtime + 600_000 });
  expect(t.told).toEqual([]);
  expect(t.logs.at(-1)).toEqual({ event: "late login notice", account: "id-a", told: false });
});

test("row F2: a late notice with no renewal noted (a state.json from before): nothing told, the note is used up, one log entry with no account", async () => {
  const { t, sw } = setup();
  const live = readFileSync(t.live, "utf8");
  const before = readState(t.dir);
  const saves = files(t.dir);
  t.note = T;
  t.clock = T + 1000;
  await sw.tick();
  expect(readState(t.dir)).toEqual({ ...before, filed: { mtime: before.filed!.mtime, at: T + 1000 } });
  expect(t.logs).toEqual([{ event: "late login notice", told: false }]);
  expect(t.told).toEqual([]);
  expect(files(t.dir)).toEqual(saves);
  expect(readFileSync(t.live, "utf8")).toBe(live);
});

test("row G: a late notice while the owner is unknown, over 5 minutes after a real renewal: that renewal's save stays and nothing is told about it", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-A2"), T);
  t.clock = T + SETTLE_MS;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A2"));
  expect(readState(t.dir).renewed).toEqual({ id: "id-a", at: liveMtime(t.live)! });

  // A /login to id-c whose record never gets a profileFetchedAt: given up at 60 s.
  rewrite(t.live, creds("tok-C1"), T + 400_000);
  t.rec = rec("id-c", "c@x.com");
  t.note = T + 401_000;
  for (const c of [T + 400_000 + SETTLE_MS, T + 400_000 + LOGIN_RECORD_MS]) {
    t.clock = c;
    await sw.tick();
  }
  expect(readState(t.dir).unknown).toBe(true);

  // The user logs in again; this notice is slow too: the change is held at 30 s, then the note comes.
  rewrite(t.live, creds("tok-C2"), T + 500_000);
  t.rec = rec("id-c", "c@x.com", T + 499_900);
  t.clock = T + 500_000 + SETTLE_MS;
  await sw.tick();
  expect(t.logs.at(-1)).toEqual({ event: "held" });
  t.note = T + 540_000;
  t.clock = T + 540_000;
  await sw.tick();

  expect(saved(t.dir, "id-a")).toBe(creds("tok-A2"));
  expect(readFileSync(prev(t.dir, "id-a"), "utf8")).toBe(creds("tok-A"));
  expect(existsSync(join(t.dir, "id-c"))).toBe(false);
  expect(t.told).toEqual([{ title: TITLE, body: BODY }]);
  const s = readState(t.dir);
  expect(s.unknown).toBe(true);
  expect(s.active).toBeUndefined();
  expect(s.filed?.at).toBe(T + 540_000);
  expect(t.logs.at(-1)).toEqual({ event: "late login notice", account: "id-a", told: false });
});

test("a change is filed, and a switch waits, until it is 30 seconds old: not at 29", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-A2"), T);
  t.stops = [limit("s1", T + 1000)];
  t.clock = T + 29_000;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readState(t.dir).active).toBe("id-a");
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-A2"));
  t.clock = T + 30_000;
  await sw.tick();
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A2"));
  expect(readState(t.dir).active).toBe("id-b");
  expect(t.logs).toContainEqual({ event: "renewal", account: "id-a" });
});

test("use refuses while a change is settling, and works once it is 30 seconds old", async () => {
  const { t, sw } = setup();
  rewrite(t.live, creds("tok-A2"), T - 1500);
  await expect(sw.use("id-b")).rejects.toThrow(/^a login is still settling; try again in 29 seconds$/);
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-A2"));
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A"));
  expect(readState(t.dir).active).toBe("id-a");
  t.clock = T + 28_000;
  await expect(sw.use("id-b")).rejects.toThrow(/^a login is still settling; try again in 1 second$/);
  t.clock = T + 28_500;
  await sw.use("id-b");
  expect(saved(t.dir, "id-a")).toBe(creds("tok-A2"));
  expect(readFileSync(t.live, "utf8")).toBe(creds("tok-B"));
  expect(readState(t.dir).active).toBe("id-b");
});

test("while the owner is unknown, a limit stop in the quiet time after the last switch isn't continued", async () => {
  const { t, sw } = await switched();
  const { active, ...s } = readState(t.dir);
  writeState({ ...s, unknown: true }, t.dir);
  t.stops = [limit("s1", T), limit("s2", T + 6000)];
  t.clock = T + 7000;
  await sw.tick();
  expect(t.typed).toEqual(["s1"]);
});
