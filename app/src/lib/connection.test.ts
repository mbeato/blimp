import { expect, mock, test } from "bun:test";

// The Mac app's side of ServerLink: invoke() goes to the Rust shell, mocked here.
const calls: [string, any][] = [];
mock.module("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  // connect never answers: the tunnel is still starting when the link stops.
  invoke: (cmd: string, args: any) => (calls.push([cmd, args]), cmd === "connect" ? new Promise(() => {}) : Promise.resolve()),
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
