import { expect, mock, test } from "bun:test";

// The Mac app's side of ServerLink: invoke() goes to the Rust shell, mocked here.
const calls: [string, any][] = [];
// connect never answers by default: the tunnel is still starting when the link stops.
let connectReply: () => Promise<unknown> = () => new Promise(() => {});
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (cmd: string, args: any) => (calls.push([cmd, args]), cmd === "connect" || cmd === "connect_local" ? connectReply() : Promise.resolve()),
}));
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { ServerLink, defaultName, serverKey, serverName, thisMac, tryConnect } = await import("./connection");

test("the server key is the Rust tunnel id: user@host:port without the blank parts", () => {
  expect(serverKey({ host: "h" })).toBe("h");
  expect(serverKey({ host: "h", user: "u" })).toBe("u@h");
  expect(serverKey({ host: "h", port: 2222 })).toBe("h:2222");
  expect(serverKey({ host: "h", user: "u", port: 2222 })).toBe("u@h:2222");
});

test("a server's name is the one it was given, else its host; never part of its key", () => {
  const lab = { host: "100.64.0.7", user: "max", name: "  Lab  " };
  expect(serverName(lab, [lab])).toBe("Lab");
  expect(serverKey(lab)).toBe("max@100.64.0.7");
  expect(serverName({ host: "box" }, [])).toBe("box");
  expect(serverName({ host: "box", name: "   " }, [])).toBe("box");
});

test("This Mac's key is \"this mac\" whatever its name; it reads \"This Mac\" until it's given one", () => {
  expect(serverKey(thisMac)).toBe("this mac");
  expect(serverKey({ ...thisMac, name: "Mini" })).toBe("this mac");
  expect(serverName(thisMac, [thisMac])).toBe("This Mac");
  expect(serverName({ ...thisMac, name: "Mini" }, [thisMac])).toBe("Mini");
  expect(defaultName(thisMac)).toBe("This Mac");
  expect(defaultName({ host: "h" })).toBe("h");
});

test("trying This Mac calls connect_local, with no ssh, and its cancel has nothing to stop", async () => {
  connectReply = () => Promise.resolve({ id: "this mac", port: 3, token: "t", home: "/Users/max" });
  calls.length = 0;
  const t = tryConnect(thisMac);
  t.cancel();
  expect((await t.done).base).toBe("http://127.0.0.1:3");
  expect(calls).toEqual([["connect_local", undefined]]);
  connectReply = () => new Promise(() => {});
});

test("two servers that would read the same each show their key instead", () => {
  const a = { host: "box" };
  const b = { host: "box", user: "max", port: 2222 };
  const c = { host: "other", name: "box" };
  const d = { host: "gpu" };
  expect(serverName(a, [a, b, d])).toBe("box");
  expect(serverName(b, [a, b, d])).toBe("max@box:2222");
  expect(serverName(c, [a, c])).toBe("other");
  expect(serverName(d, [a, b, d])).toBe("gpu");
  // The server itself in the list doesn't clash with itself.
  expect(serverName(d, [d])).toBe("gpu");
});

test("Add server's try keeps the tunnel it opened, for the link that follows", async () => {
  connectReply = () => Promise.resolve({ id: "fresh", port: 1, token: "t", home: "/h" });
  calls.length = 0;
  const conn = await tryConnect({ host: "fresh" }).done;
  expect(conn.home).toBe("/h");
  expect(calls).toEqual([["connect", { host: "fresh", user: undefined, port: undefined, attempt: expect.any(String) }]]);
});

test("cancelling Add server's try stops that try only, by its own token, never the server's tunnel by id", async () => {
  const opened: ((v: unknown) => void)[] = [];
  connectReply = () => new Promise((r) => opened.push(r));
  calls.length = 0;
  const first = tryConnect({ host: "late", user: "u" });
  first.cancel();
  // Add server again for the same server: a try of its own.
  const second = tryConnect({ host: "late", user: "u" });
  const [a, b] = calls.filter(([c]) => c === "connect").map(([, args]) => args.attempt);
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(b).toMatch(/^[0-9a-f]{32}$/);
  expect(a).not.toBe(b);
  expect(calls).toContainEqual(["disconnect", { id: "u@late", attempt: a }]);
  // The first try finishing late drops nothing: Rust already ended it (or it was over).
  opened[0]({ id: "u@late", port: 1, token: "t", home: "/h" });
  await first.done;
  expect(calls.filter(([c]) => c === "disconnect")).toEqual([["disconnect", { id: "u@late", attempt: a }]]);
  opened[1]({ id: "u@late", port: 2, token: "t", home: "/h" });
  expect((await second.done).base).toBe("http://127.0.0.1:2");
  connectReply = () => new Promise(() => {});
});

test("stop() during a connect still disconnects that tunnel", () => {
  const link = new ServerLink({ host: "h", user: "u", port: 2222 }, () => {});
  link.start();
  expect(calls).toContainEqual(["connect", { host: "h", user: "u", port: 2222 }]);
  link.stop();
  expect(calls).toContainEqual(["disconnect", { id: "u@h:2222" }]);
});

// A blimpd that answers /health (and any other call) while `healthy` is true, and whose events socket sends an
// empty session list, then that the assistant is on, as soon as it opens. The base URL's port (1) is the tunnel's
// local port.
let healthy = true;
globalThis.fetch = (async () => {
  if (!healthy) throw new TypeError("Load failed");
  return new Response(JSON.stringify({ version: "0.2.6", home: "/h" }));
}) as unknown as typeof fetch;
class FakeSocket {
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  constructor() {
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ type: "sessions", sessions: [] }) });
      this.onmessage?.({ data: JSON.stringify({ type: "assistant", on: true }) });
    });
  }
  send() {}
  close() {}
}
globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;

async function connected(host: string) {
  connectReply = () => Promise.resolve({ id: host, port: 1, token: "t", home: "/h" });
  const link = new ServerLink({ host }, () => {});
  link.start();
  for (let i = 0; i < 50 && link.status !== "connected"; i++) await new Promise((r) => setTimeout(r, 1));
  expect(link.status).toBe("connected");
  return link;
}

test("check() keeps a tunnel that still answers", async () => {
  healthy = true;
  const link = await connected("alive");
  calls.length = 0;
  await link.check();
  expect(calls).toEqual([]);
  link.stop();
});

test("check() replaces a tunnel that no longer answers (the Mac woke on another network)", async () => {
  const link = await connected("gone");
  healthy = false;
  calls.length = 0;
  await link.check();
  // The dead ssh goes first, so connect starts a new one instead of reusing it. Only that
  // tunnel (by its port): not disconnect, which would also end browser tabs' forwards.
  expect(calls.map(([c]) => c)).toEqual(["drop_tunnel", "connect"]);
  expect(calls[0]).toEqual(["drop_tunnel", { id: "gone", port: 1 }]);
  healthy = true;
  link.stop();
});

test("a wake and an online event together reconnect once", async () => {
  const link = await connected("twice");
  healthy = false;
  calls.length = 0;
  await Promise.all([link.check(), link.check()]);
  expect(calls.map(([c]) => c)).toEqual(["drop_tunnel", "connect"]);
  healthy = true;
  link.stop();
});

test("an offline link whose tunnel still answers retries at once through it", async () => {
  const link = await connected("offline");
  link.retry("Lost the connection to blimpd.");
  expect(link.status).toBe("offline");
  calls.length = 0;
  await link.check();
  expect(calls.map(([c]) => c)).toEqual(["connect"]);
  link.stop();
});

test("an offline link whose tunnel is dead gets a new one, not a minute stuck connecting", async () => {
  const link = await connected("offline-dead");
  link.retry("Lost the connection to blimpd.");
  healthy = false;
  calls.length = 0;
  await link.check();
  expect(calls.map(([c]) => c)).toEqual(["drop_tunnel", "connect"]);
  healthy = true;
  link.stop();
});

test("a link stopped while its check waits doesn't reconnect", async () => {
  const link = await connected("stopped");
  healthy = false;
  const checking = link.check();
  link.stop();
  calls.length = 0;
  await checking;
  expect(calls).toEqual([]);
  healthy = true;
});

test("assistantOn is null until the events socket says, then what it says; setAssistant shows the new one at once", async () => {
  const quiet = new ServerLink({ host: "quiet" }, () => {});
  expect(quiet.assistantOn).toBeNull();
  quiet.stop();
  healthy = true;
  const link = await connected("assistant");
  expect(link.assistantOn).toBe(true);
  await link.setAssistant(false);
  expect(link.assistantOn).toBe(false);
  link.stop();
});
