// The widgets' pinger (src/push/widgets.ts) on stand-ins: the session list, the clock, the hidden projects, and Apple.

import { expect, test } from "bun:test";
import type { Sent } from "../src/push/apns";
import type { Creds, Device } from "../src/push/store";
import { PING, PING_GAP, type WidgetDeps, WidgetPinger } from "../src/push/widgets";
import type { Session } from "../src/sessions";

const T = 1_800_000_000_000;
const key: Creds = { key: "k", keyId: "ABC123DEFG", teamId: "1A2B3C4D5E" };
const widget: Device = { token: "ab".repeat(50), env: "production", at: 0 };

const s = (name: string, o: Partial<Session> = {}): Session => ({
  name,
  pid: 1,
  clients: 0,
  created: (T - 3_600_000) / 1000,
  dir: "/u/blimp",
  cmd: "claude",
  kind: "claude",
  title: name,
  status: "busy",
  state: "working",
  stateSince: T - 60_000,
  unread: false,
  ...o,
});

function setup(o: { widgets?: Device[]; creds?: Creds; answer?: Sent; hidden?: string[] } = {}) {
  const t = {
    list: [] as Session[],
    clock: T,
    widgets: o.widgets ?? [widget],
    creds: ("creds" in o ? o.creds : key) as Creds | undefined,
    sent: [] as Device[],
    gone: [] as Device[],
    logs: [] as string[],
    reads: 0,
  };
  const deps: WidgetDeps = {
    sessions: async () => {
      t.reads++;
      return t.list;
    },
    hidden: () => new Set(o.hidden ?? []),
    creds: () => t.creds,
    widgets: () => t.widgets,
    send: async (_c, d) => {
      t.sent.push(d);
      return o.answer ?? { status: 200 };
    },
    gone: (d) => void t.gone.push(d),
    now: () => t.clock,
    log: (line) => void t.logs.push(line),
  };
  return { t, p: new WidgetPinger(deps) };
}

test("the ping only says the content changed", () => {
  expect(PING).toEqual({ aps: { "content-changed": true } });
  expect(PING_GAP).toBe(2 * 60_000);
});

test("what it finds first counts as known: a restart pings nothing", async () => {
  const { t, p } = setup();
  t.list = [s("a", { state: "waiting" })];
  await p.tick();
  expect(t.sent).toEqual([]);
});

test("a needs-you that wasn't there pings at once, even right after another ping", async () => {
  const { t, p } = setup();
  t.list = [s("a")];
  await p.tick();
  t.list = [s("a", { state: "waiting", stateSince: T })];
  await p.tick();
  expect(t.sent).toEqual([widget]);
  t.clock += 5000;
  t.list = [s("a", { state: "waiting", stateSince: T }), s("b", { state: "waiting", stateSince: T + 5000 })];
  await p.tick();
  expect(t.sent.length).toBe(2);
});

test("any other change: no sooner than 2 minutes after the last ping, then one ping for all of it", async () => {
  const { t, p } = setup();
  t.list = [s("a", { state: "waiting" })];
  await p.tick();
  // a answered: a change, and no ping in the last 2 minutes, so at once
  t.list = [s("a")];
  await p.tick();
  expect(t.sent.length).toBe(1);
  t.clock += 30_000;
  t.list = [s("a"), s("b")];
  await p.tick();
  t.clock += 30_000;
  t.list = [s("a"), s("b"), s("c")];
  await p.tick();
  expect(t.sent.length).toBe(1);
  // 2 minutes after the first ping: nothing new this second, but the changes since are still unsent
  t.clock = T + PING_GAP;
  await p.tick();
  expect(t.sent.length).toBe(2);
  t.clock += 1000;
  await p.tick();
  expect(t.sent.length).toBe(2);
});

test("a working row's time going on, and its activity, ping nothing", async () => {
  const { t, p } = setup();
  t.list = [s("a")];
  await p.tick();
  t.clock += PING_GAP * 3;
  t.list = [s("a", { updatedAt: t.clock })];
  await p.tick();
  expect(t.sent).toEqual([]);
});

test("no widget token, or no push key: nothing is listed or sent, and what was known is forgotten", async () => {
  const none = setup({ widgets: [] });
  none.t.list = [s("a")];
  await none.p.tick();
  expect(none.t.reads).toBe(0);
  const nokey = setup({ creds: undefined });
  await nokey.p.tick();
  expect(nokey.t.reads).toBe(0);
  const { t, p } = setup();
  t.list = [s("a")];
  await p.tick();
  t.creds = undefined;
  await p.tick();
  // the key back: its first list counts as known again
  t.creds = key;
  t.list = [s("a", { state: "waiting" })];
  await p.tick();
  expect(t.sent).toEqual([]);
});

test("the ping goes to each widget token, and one Apple says is gone is removed", async () => {
  const other: Device = { token: "cd".repeat(50), env: "development", at: 0 };
  const { t, p } = setup({ widgets: [widget, other], answer: { status: 410, reason: "Unregistered" } });
  t.list = [s("a")];
  await p.tick();
  t.list = [s("a", { state: "waiting" })];
  await p.tick();
  expect(t.sent).toEqual([widget, other]);
  expect(t.gone).toEqual([widget, other]);
  expect(t.logs.some((l) => l.includes("no longer works"))).toBe(true);
});

test("another answer from Apple is logged, and nothing is removed", async () => {
  const { t, p } = setup({ answer: { status: 429, reason: "TooManyRequests" } });
  t.list = [s("a")];
  await p.tick();
  t.list = [s("a", { state: "waiting" })];
  await p.tick();
  expect(t.gone).toEqual([]);
  expect(t.logs.some((l) => l.includes("429") && l.includes("TooManyRequests"))).toBe(true);
});

test("an empty list after sessions is skipped: more likely a zmx list that failed", async () => {
  const { t, p } = setup();
  t.list = [s("a")];
  await p.tick();
  t.list = [];
  await p.tick();
  t.list = [s("a")];
  await p.tick();
  expect(t.sent).toEqual([]);
});

test("a hidden project's sessions ping nothing", async () => {
  const { t, p } = setup({ hidden: ["/u/secret"] });
  t.list = [s("a")];
  await p.tick();
  t.list = [s("a"), s("x", { dir: "/u/secret", state: "waiting" })];
  await p.tick();
  expect(t.sent).toEqual([]);
});
