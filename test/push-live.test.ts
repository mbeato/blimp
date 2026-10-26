// The live panel's runner (src/push/live.ts) on stand-ins: what the panel shows, the clock, the tokens, the open app
// and Apple.

import { expect, test } from "bun:test";
import type { LiveState } from "../src/live";
import type { Sent } from "../src/push/apns";
import { APP_GRACE, type LiveDeps, LiveRunner, QUIET, RESTART } from "../src/push/live";
import type { Creds, Device, LiveList } from "../src/push/store";
import type { Session } from "../src/sessions";

const T = 1_800_000_000_000;
const key: Creds = { key: "k", keyId: "ABC123DEFG", teamId: "1A2B3C4D5E" };
const startToken: Device = { token: "ab".repeat(60), env: "production", at: 0 };
const panelToken = (at: number): Device => ({ token: "cd".repeat(70), env: "production", at });
const row = (session: string, state: "needs" | "new" | "working") => ({ session, dir: "/u/blimp", title: session, state, since: T });
const working = (n = 1): LiveState => ({ rows: Array.from({ length: n }, (_, i) => row(`w${i}`, "working")), counts: { needs: 0, new: 0, working: n } });
const quiet: LiveState = { rows: [], counts: { needs: 0, new: 0, working: 0 } };
const anySession = { name: "x" } as Session;

type Push = { list: "starts" | "activities"; event: string; priority: 5 | 10; payload: any };

function setup(o: { creds?: Creds; answer?: (d: Device) => Sent; appOpen?: boolean } = {}) {
  const t = {
    state: quiet,
    clock: T,
    starts: [startToken],
    activities: [] as Device[],
    creds: ("creds" in o ? o.creds : key) as Creds | undefined,
    appOpen: o.appOpen ?? false,
    pushes: [] as Push[],
    told: [] as LiveState[],
    gone: [] as [LiveList, Device][],
    logs: [] as string[],
    list: [anySession] as Session[],
    reads: 0,
  };
  const deps: LiveDeps = {
    sessions: async () => {
      t.reads++;
      return t.list;
    },
    content: () => t.state,
    creds: () => t.creds,
    starts: () => t.starts,
    activities: () => t.activities,
    clearActivities: () => void (t.activities = []),
    send: async (_c, d, payload: any, priority) => {
      t.pushes.push({ list: d.token === startToken.token ? "starts" : "activities", event: payload.aps.event, priority, payload });
      return o.answer?.(d) ?? { status: 200 };
    },
    gone: (list, d) => void t.gone.push([list, d]),
    tellApp: (state) => (t.appOpen ? (t.told.push(state), true) : false),
    now: () => t.clock,
    log: (line) => void t.logs.push(line),
  };
  return { t, r: new LiveRunner(deps) };
}
const events = (t: { pushes: Push[] }) => t.pushes.map((p) => `${p.list}:${p.event}:${p.priority}`);

test("no push-to-start token, or no push key: no work, not even the list", async () => {
  const a = setup();
  a.t.starts = [];
  a.t.state = working();
  await a.r.tick();
  const b = setup({ creds: undefined });
  b.t.state = working();
  await b.r.tick();
  expect([a.t.reads, b.t.reads, a.t.pushes.length, b.t.pushes.length]).toEqual([0, 0, 0, 0]);
});

test("quiet: nothing starts", async () => {
  const { t, r } = setup();
  await r.tick();
  t.clock += 60_000;
  await r.tick();
  expect(t.pushes).toEqual([]);
});

test("busy with the app closed: a push-to-start at once, with its alert and no sound", async () => {
  const { t, r } = setup();
  t.state = working(3);
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
  expect(t.pushes[0].payload.aps.alert).toEqual({ title: "blimp", body: "3 working" });
  expect(t.pushes[0].payload.aps.sound).toBeUndefined();
  expect(t.pushes[0].payload.aps["content-state"]).toEqual(working(3));
});

test("busy with the app open: the app starts it (no banner); no token 10 s on, a push-to-start", async () => {
  const { t, r } = setup({ appOpen: true });
  t.state = working();
  await r.tick();
  expect(t.told).toEqual([working()]);
  expect(t.pushes).toEqual([]);
  t.clock += APP_GRACE - 1;
  await r.tick();
  expect(t.pushes).toEqual([]);
  t.clock += 1;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
  t.clock += 60_000;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
});

test("the app started it and sent its token: no push-to-start; updates go to that token", async () => {
  const { t, r } = setup({ appOpen: true });
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T + 500)];
  t.clock += APP_GRACE;
  await r.tick();
  expect(t.pushes).toEqual([]);
  t.state = working(2);
  await r.tick();
  expect(events(t)).toEqual(["activities:update:5"]);
});

test("updates on a change only: the same content, or a later time, sends nothing", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  for (let i = 0; i < 3; i++) {
    t.clock += 1000;
    await r.tick();
  }
  expect(events(t)).toEqual(["starts:start:10"]);
  t.state = working(2);
  await r.tick();
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:update:5"]);
  expect(t.pushes[1].payload.aps).toEqual({ timestamp: Math.floor(t.clock / 1000), event: "update", "content-state": working(2) });
});

test("a new needs-you: priority 10, no alert; the same one again later: 5", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.state = { rows: [row("ask", "needs"), row("w0", "working")], counts: { needs: 1, new: 0, working: 1 } };
  await r.tick();
  t.state = { rows: [row("ask", "needs"), row("w0", "new")], counts: { needs: 1, new: 1, working: 0 } };
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:update:10", "activities:update:5"]);
  expect(t.pushes[1].payload.aps.alert).toBeUndefined();
});

test("ends after 10 minutes with nothing needing you or working, dismissed at once; busy again, a new one", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.state = { rows: [row("w0", "new")], counts: { needs: 0, new: 1, working: 0 } };
  await r.tick(); // what it shows changed: an update
  t.clock += QUIET - 1;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:update:5"]);
  t.clock += 1;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:update:5", "activities:end:10"]);
  expect(t.pushes[2].payload.aps["dismissal-date"]).toBe(Math.floor(t.clock / 1000));
  expect(t.activities).toEqual([]);
  t.state = working();
  await r.tick();
  expect(events(t).at(-1)).toBe("starts:start:10");
});

test("something working again within the 10 minutes keeps it", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.state = quiet;
  await r.tick();
  t.clock += QUIET - 1000;
  t.state = working();
  await r.tick();
  t.clock += QUIET - 1000;
  await r.tick();
  expect(events(t).filter((e) => e.endsWith(":end:10"))).toEqual([]);
});

test("at 7 h 45 min, still busy: ended and started again", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.clock = T + RESTART - 1;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
  t.clock = T + RESTART;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:end:10", "starts:start:10"]);
  expect(RESTART).toBe((7 * 60 + 45) * 60_000);
});

test("blimpd started again with a panel's token kept: it carries on with that panel, and restarts it on time", async () => {
  const { t, r } = setup();
  t.activities = [panelToken(T - RESTART + 60_000)];
  t.state = working();
  await r.tick();
  expect(events(t)).toEqual(["activities:update:5"]);
  t.clock += 60_000;
  await r.tick();
  expect(events(t)).toEqual(["activities:update:5", "activities:end:10", "starts:start:10"]);
});

test("a panel whose token never came gets nothing more, and is forgotten after the quiet 10 minutes", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.state = working(2);
  await r.tick();
  t.state = quiet;
  await r.tick(); // the quiet starts here
  t.clock += QUIET;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
  t.state = working();
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "starts:start:10"]);
});

test("tokens Apple says are gone are removed", async () => {
  const { t, r } = setup({ answer: () => ({ status: 410, reason: "Unregistered" }) });
  t.state = working();
  await r.tick();
  expect(t.gone).toEqual([["starts", startToken]]);
  expect(t.logs.join("\n")).toContain("no longer works");
  const b = setup({ answer: (d) => (d.token === startToken.token ? { status: 200 } : { status: 400, reason: "BadDeviceToken" }) });
  b.t.state = working();
  await b.r.tick();
  b.t.activities = [panelToken(T)];
  b.t.state = working(2);
  await b.r.tick();
  expect(b.t.gone).toEqual([["activities", panelToken(T)]]);
});

test("another answer from Apple is logged, and nothing is removed", async () => {
  const { t, r } = setup({ answer: () => ({ status: 429, reason: "TooManyRequests" }) });
  t.state = working();
  await r.tick();
  expect(t.gone).toEqual([]);
  expect(t.logs).toEqual(["push: Apple said 429 (TooManyRequests) to the live panel"]);
});

test("the push-to-start token gone (the switch off in Settings): it forgets the panel", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.starts = [];
  await r.tick();
  t.starts = [startToken];
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "starts:start:10"]);
});

test("an empty list after a good one (a failed zmx list): that tick sends nothing new", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.list = [];
  t.state = working(2);
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
});

test("an empty list kept for the quiet 10 minutes still ends the panel", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.list = [];
  t.state = quiet;
  await r.tick();
  t.clock += QUIET - 1;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10"]);
  t.clock += 1;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:end:10"]);
});

test("a good busy list after an empty tick resets the quiet clock", async () => {
  const { t, r } = setup();
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.list = [];
  t.state = quiet;
  await r.tick();
  t.clock += QUIET - 1000;
  t.list = [anySession];
  t.state = working();
  await r.tick();
  t.clock += QUIET - 1000;
  await r.tick();
  expect(events(t).filter((e) => e.includes(":end:"))).toEqual([]);
});

test("an update Apple didn't take (no answer, 5xx) is sent again next tick; a 200 is not", async () => {
  let status = 0;
  const { t, r } = setup({ answer: (d) => (d.token === startToken.token ? { status: 200 } : { status }) });
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.state = working(2);
  await r.tick();
  status = 503;
  await r.tick();
  status = 200;
  await r.tick();
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:update:5", "activities:update:5", "activities:update:5"]);
});

test("an end that fails (no answer) keeps the panel and its token, and is sent again", async () => {
  let status = 0;
  const { t, r } = setup({ answer: (d) => (d.token === startToken.token ? { status: 200 } : { status }) });
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T)];
  t.state = quiet;
  await r.tick();
  t.clock += QUIET;
  await r.tick();
  expect(t.activities).toEqual([panelToken(T)]);
  status = 200;
  await r.tick();
  expect(events(t)).toEqual(["starts:start:10", "activities:update:5", "activities:end:10", "activities:end:10"]);
  expect(t.activities).toEqual([]);
});

test("the same token sent again doesn't move the restart", async () => {
  const { t, r } = setup();
  t.activities = [panelToken(T - RESTART + 60_000)];
  t.state = working();
  await r.tick();
  t.activities = [panelToken(T + 30_000)]; // the app posted it again
  t.creds = undefined; // the panel is forgotten for a tick, and picked up from its token again
  await r.tick();
  t.creds = key;
  t.clock += 60_000;
  await r.tick();
  expect(events(t)).toEqual(["activities:update:5", "activities:end:10", "starts:start:10"]);
});
