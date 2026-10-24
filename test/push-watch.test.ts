// The push watcher (src/push/watch.ts) on stand-ins: the session list, the clock, the Mac's last use, and Apple.

import { expect, test } from "bun:test";
import { eventsData, eventsMessage } from "../src/events";
import type { Sent } from "../src/push/apns";
import type { Creds, Device } from "../src/push/store";
import { lastActiveAt, type PushDeps, PushWatcher, type WatchedSession } from "../src/push/watch";

const T = 1_800_000_000_000;
const key: Creds = { key: "k", keyId: "ABC123DEFG", teamId: "1A2B3C4D5E" };
const phone: Device = { token: "a".repeat(64), env: "production", at: 0 };
const other: Device = { token: "b".repeat(64), env: "development", at: 0 };

function setup(o: { devices?: Device[]; creds?: Creds; answer?: Sent; reply?: (file: string) => Promise<string | undefined> } = {}) {
  const t = {
    list: [] as WatchedSession[],
    clock: T,
    active: 0,
    creds: "creds" in o ? o.creds : key,
    devices: o.devices ?? [phone],
    sent: [] as { device: Device; payload: any; collapseId: string }[],
    gone: [] as Device[],
    logs: [] as string[],
    reads: 0,
    replies: [] as string[],
  };
  const deps: PushDeps = {
    sessions: async () => {
      t.reads++;
      return t.list;
    },
    creds: () => t.creds,
    devices: () => t.devices,
    send: async (_c, device, payload, collapseId) => {
      t.sent.push({ device, payload, collapseId });
      return o.answer ?? { status: 200 };
    },
    gone: (d) => void t.gone.push(d),
    reply:
      o.reply ??
      (async (file) => {
        t.replies.push(file);
        return "All done.";
      }),
    now: () => t.clock,
    active: () => t.active,
    log: (l) => void t.logs.push(l),
  };
  return { t, w: new PushWatcher(deps) };
}
const s = (state: WatchedSession["state"], since: number, extra: object = {}) =>
  ({ name: "a", kind: "claude", title: "Fix it", dir: "/w/blimp", state, stateSince: since, ...extra }) as WatchedSession;
const waiting = (at: number) => s("waiting", at, { prompt: { kind: "other", answerable: false, at } });
// The watcher, after it has seen a session working (its first list counts as seen).
async function started(o: Parameters<typeof setup>[0] = {}) {
  const r = setup(o);
  r.t.list = [s("working", T - 5000)];
  await r.w.tick();
  return r;
}

test("with no phone, the session list isn't even read", async () => {
  const { t, w } = setup({ devices: [] });
  await w.tick();
  await w.tick();
  expect(t.reads).toBe(0);
  expect(t.logs).toEqual([]);
});

test("a phone but no key: said once in the log, and nothing read", async () => {
  const { t, w } = setup({ creds: undefined });
  await w.tick();
  await w.tick();
  expect(t.reads).toBe(0);
  expect(t.logs.length).toBe(1);
  expect(t.logs[0]).toContain("blimpd push-key");
});

test("a wait reaches every phone once, collapsed by session", async () => {
  const { t, w } = await started({ devices: [phone, other] });
  t.list = [waiting(T)];
  t.clock = T + 3000;
  await w.tick();
  expect(t.sent.map((x) => x.device)).toEqual([phone, other]);
  expect(t.sent[0].collapseId).toBe("a");
  expect(t.sent[0].payload.aps.alert.title).toBe("Fix it is waiting");
  t.clock = T + 4000;
  await w.tick();
  expect(t.sent.length).toBe(2);
});

test("while the Mac is in use, it waits until 2 minutes after the Mac's last use, and goes if still waiting", async () => {
  const { t, w } = await started();
  t.active = T;
  t.list = [waiting(T + 1000)];
  t.clock = T + 4000;
  await w.tick();
  t.clock = T + 119_000;
  await w.tick();
  expect(t.sent.length).toBe(0);
  t.clock = T + 120_000;
  await w.tick();
  expect(t.sent.length).toBe(1);
});

test("one answered on the Mac while it waited doesn't go", async () => {
  const { t, w } = await started();
  t.active = T;
  t.list = [waiting(T + 1000)];
  t.clock = T + 4000;
  await w.tick();
  t.list = [s("working", T + 60_000)];
  t.clock = T + 120_000;
  await w.tick();
  expect(t.sent.length).toBe(0);
});

test("a finish carries Claude's last reply, from its transcript", async () => {
  const { t, w } = setup();
  t.list = [s("working", T - 60_000, { transcript: "/t/a.jsonl" })];
  await w.tick();
  t.list = [s("done", T, { transcript: "/t/a.jsonl" })];
  t.clock = T + 1000;
  await w.tick();
  expect(t.replies).toEqual(["/t/a.jsonl"]);
  expect(t.sent[0].payload.aps.alert).toEqual({ title: "Fix it finished", body: "All done." });
});

test("a reply that can't be read still sends the finish, and the others ready with it", async () => {
  const { t, w } = setup({
    reply: async () => {
      throw new Error("ENOENT");
    },
  });
  t.list = [s("working", T - 60_000, { transcript: "/t/a.jsonl" }), s("working", T - 5000, { name: "b" })];
  await w.tick();
  t.list = [s("done", T, { transcript: "/t/a.jsonl" }), s("waiting", T, { name: "b", prompt: { kind: "other", answerable: false, at: T } })];
  t.clock = T + 3500;
  await w.tick();
  expect(t.sent.map((x) => x.collapseId).sort()).toEqual(["a", "b"]);
  expect(t.sent.find((x) => x.collapseId === "a")!.payload.aps.alert).toEqual({ title: "Fix it finished", body: "blimp" });
  expect(t.logs.join("\n")).toContain("last reply");
});

test("a phone Apple says is gone is removed", async () => {
  const { t, w } = await started({ answer: { status: 410, reason: "Unregistered" } });
  t.list = [waiting(T)];
  t.clock = T + 3000;
  await w.tick();
  expect(t.gone).toEqual([phone]);
  expect(t.logs.join("\n")).toContain("removed");
});

test("an empty list after sessions (a zmx list that failed) forgets nothing, so nothing is told again", async () => {
  const { t, w } = setup();
  t.list = [waiting(T - 10_000)];
  await w.tick();
  t.list = [];
  t.clock = T + 1000;
  await w.tick();
  t.list = [waiting(T - 10_000)];
  t.clock = T + 2000;
  await w.tick();
  expect(t.sent.length).toBe(0);
});

test("when the key comes back, what's there then counts as seen", async () => {
  const { t, w } = await started();
  t.creds = undefined;
  await w.tick();
  t.list = [waiting(T)];
  t.clock = T + 10_000;
  await w.tick();
  t.creds = key;
  await w.tick();
  t.clock = T + 11_000;
  await w.tick();
  expect(t.sent.length).toBe(0);
});

test("`active` on the events socket is when the Mac was last in use; other messages are still ignored", () => {
  const ws = { data: eventsData(), send() {} } as any;
  eventsMessage(ws, JSON.stringify({ type: "active" }));
  expect(Date.now() - lastActiveAt()).toBeLessThan(1000);
  expect(() => eventsMessage(ws, JSON.stringify({ type: "bogus" }))).not.toThrow();
  expect(ws.data.watches.size).toBe(0);
});
