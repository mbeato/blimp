import { expect, mock, test } from "bun:test";

// The Mac app's side of ServerLink: invoke() goes to the Rust shell, mocked here.
const calls: [string, any][] = [];
// connect never answers by default: the tunnel is still starting when the link stops.
let connectReply: () => Promise<unknown> = () => new Promise(() => {});
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (cmd: string, args: any) => (calls.push([cmd, args]), cmd === "connect" ? connectReply() : Promise.resolve()),
}));
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { ServerLink, serverKey } = await import("./connection");

test("the server key is the Rust tunnel id: user@host:port without the blank parts", () => {
  expect(serverKey({ host: "h" })).toBe("h");
  expect(serverKey({ host: "h", user: "u" })).toBe("u@h");
  expect(serverKey({ host: "h", port: 2222 })).toBe("h:2222");
  expect(serverKey({ host: "h", user: "u", port: 2222 })).toBe("u@h:2222");
});

test("stop() during a connect still disconnects that tunnel", () => {
  const link = new ServerLink({ host: "h", user: "u", port: 2222 }, () => {});
  link.start();
  expect(calls).toContainEqual(["connect", { host: "h", user: "u", port: 2222 }]);
  link.stop();
  expect(calls).toContainEqual(["disconnect", { id: "u@h:2222" }]);
});

// A blimpd that answers /health while `healthy` is true, and whose events socket sends an empty
// session list as soon as it opens. The base URL's port (1) is the tunnel's local port.
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
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "sessions", sessions: [] }) }));
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
