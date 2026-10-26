// The relay's work (relay/relay.ts, relay/send.ts) with fakes for chat.db, Messages and blimpd.

import { expect, test } from "bun:test";
import type { Incoming } from "../relay/chatdb";
import { inStep, outStep, parseConfig, parseState, type RelayDeps } from "../relay/relay";
import { SEND_SCRIPT, sendText } from "../relay/send";

const hi = (id: string, text = "hi", from = "+15550000000"): Incoming => ({ id, from, text, picture: false });

function setup(o: { server?: boolean; texts?: Incoming[]; answer?: (path: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  const t = {
    texts: o.texts ?? [],
    reads: [] as number[],
    sent: [] as [string, string][],
    sendFails: undefined as string | undefined,
    calls: [] as { path: string; init?: RequestInit }[],
    saves: 0,
    logs: [] as string[],
  };
  const d: RelayDeps = {
    config: { allow: ["+15550000000"], ...(o.server && { server: "https://blimp.example", key: "k" }) },
    state: { pending: [] },
    save: () => void t.saves++,
    watermark: () => 40,
    read: (after) => {
      t.reads.push(after);
      const texts = t.texts;
      t.texts = [];
      return { last: after + texts.length, texts };
    },
    send: (text, to) => {
      if (t.sendFails) return t.sendFails;
      t.sent.push([text, to]);
      return undefined;
    },
    fetch: async (path, init) => {
      t.calls.push({ path, init });
      return (await o.answer?.(path, init)) ?? Response.json({ ok: true });
    },
    log: (m) => void t.logs.push(m),
    sleep: async () => {},
  };
  return { t, d };
}

test("relay.json: allow is needed; a server needs its key; a trailing slash goes", () => {
  expect(parseConfig('{"allow": ["+15550000000"]}')).toEqual({ allow: ["+15550000000"], server: undefined, key: undefined });
  expect(parseConfig('{"allow": ["a"], "server": "https://x.example/", "key": "k"}')).toEqual({ allow: ["a"], server: "https://x.example", key: "k" });
  expect(() => parseConfig('{"allow": []}')).toThrow("allow");
  expect(() => parseConfig('{"allow": ["a"], "server": "https://x.example"}')).toThrow("server");
  expect(() => parseConfig('{"allow": ["a"], "server": "ftp://x", "key": "k"}')).toThrow("server");
});

test("state.json: what's missing or broken starts empty", () => {
  expect(parseState(undefined)).toEqual({ last: undefined, to: undefined, pending: [] });
  expect(parseState("not json")).toEqual({ pending: [] });
  expect(parseState('{"last": 5, "to": "+1", "pending": [{"id": "g"}]}')).toEqual({ last: 5, to: "+1", pending: [{ id: "g" } as Incoming] });
});

test("a first run starts at the watermark; echo mode texts each one back as got: <text> to its sender", async () => {
  const { t, d } = setup({ texts: [hi("g1", "ping"), hi("g2", "pong", "user@example.com")] });
  await inStep(d);
  expect(t.reads).toEqual([40]);
  expect(t.sent).toEqual([["got: ping", "+15550000000"], ["got: pong", "user@example.com"]]);
  expect(d.state).toEqual({ last: 42, to: "user@example.com", pending: [] });
  expect(t.calls).toEqual([]);
});

test("echo mode: a send that fails keeps that text and the rest for next time", async () => {
  const { t, d } = setup({ texts: [hi("g1"), hi("g2")] });
  t.sendFails = "Messages isn't running";
  await inStep(d);
  expect(d.state.pending.map((p) => p.id)).toEqual(["g1", "g2"]);
  expect(t.logs).toEqual(["couldn't send a text: Messages isn't running"]);
});

test("server mode: texts go to POST /messages/in in order; each leaves the list once blimpd has it", async () => {
  const { t, d } = setup({ server: true, texts: [hi("g1"), hi("g2")] });
  await inStep(d);
  expect(t.calls.map((c) => [c.path, c.init?.method, JSON.parse(String(c.init?.body)).id])).toEqual([
    ["/messages/in", "POST", "g1"],
    ["/messages/in", "POST", "g2"],
  ]);
  expect(d.state.pending).toEqual([]);
  expect(t.sent).toEqual([]);
});

test("server mode: unreachable, 401 and 5xx keep the text; another 4xx drops it", async () => {
  for (const [answer, kept] of [
    [() => Promise.reject(new Error("offline")), ["g1", "g2"]],
    [() => new Response("no", { status: 401 }), ["g1", "g2"]],
    [() => new Response("busy", { status: 503 }), ["g1", "g2"]],
    [() => Response.json({ error: "messages is off" }, { status: 403 }), []],
    [() => Response.json({ error: "bad" }, { status: 400 }), []],
  ] as const) {
    const { d } = setup({ server: true, texts: [hi("g1"), hi("g2")], answer: answer as any });
    await inStep(d);
    expect(d.state.pending.map((p) => p.id)).toEqual(kept as unknown as string[]);
  }
});

test("out: each text is sent to the latest sender (or the first allowed handle), then marked sent", async () => {
  const { t, d } = setup({ server: true, answer: (path) => (path.startsWith("/messages/out?") ? Response.json({ texts: [{ id: "o1", text: "one" }, { id: "o/2", text: "two" }] }) : Response.json({ ok: true })) });
  await outStep(d);
  expect(t.sent).toEqual([["one", "+15550000000"], ["two", "+15550000000"]]);
  expect(t.calls.map((c) => [c.path, c.init?.method])).toEqual([
    ["/messages/out?wait=25", undefined],
    ["/messages/out/o1/sent", "POST"],
    ["/messages/out/o%2F2/sent", "POST"],
  ]);
  d.state.to = "user@example.com";
  await outStep(d);
  expect(t.sent.at(-1)).toEqual(["two", "user@example.com"]);
});

test("out: a failed send throws and isn't marked sent; blimpd saying no throws", async () => {
  const { t, d } = setup({ server: true, answer: (path) => (path.startsWith("/messages/out?") ? Response.json({ texts: [{ id: "o1", text: "one" }] }) : Response.json({ ok: true })) });
  t.sendFails = "not allowed to send";
  await expect(outStep(d)).rejects.toThrow("couldn't send a text: not allowed to send");
  expect(t.calls.map((c) => c.path)).toEqual(["/messages/out?wait=25"]);
  const off = setup({ server: true, answer: () => Response.json({ error: "messages is off" }, { status: 403 }) });
  await expect(outStep(off.d)).rejects.toThrow("blimpd said 403");
});

test("sendText: osascript with the script on stdin, the text and handle as arguments", () => {
  const runs: [string[], string][] = [];
  expect(sendText("it's \"done\"", "+15550000000", (cmd, stdin) => (runs.push([cmd, stdin]), { code: 0, err: "" }))).toBeUndefined();
  expect(runs).toEqual([[["osascript", "-", "it's \"done\"", "+15550000000"], SEND_SCRIPT]]);
  expect(sendText("x", "y", () => ({ code: 1, err: "execution error" }))).toBe("execution error");
  expect(sendText("x", "y", () => ({ code: 2, err: "" }))).toBe("osascript exited 2");
});

test("a first run on a quiet chat.db saves the watermark", async () => {
  const { t, d } = setup();
  await inStep(d);
  expect(t.saves).toBeGreaterThanOrEqual(1);
  expect(d.state.last).toBe(40);
});
