import { expect, mock, test } from "bun:test";

// install_server's answer from Rust, mocked here.
let reply: () => Promise<unknown> = async () => "done";
mock.module("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: () => reply() }));
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { installServer } = await import("./updates");

test("Install blimpd: Cancel in the Mac's own dialog is false, not an error; a failure stays an error", async () => {
  expect(await installServer({ host: "box" })).toBe(true);
  reply = () => Promise.reject("Cancelled.");
  expect(await installServer({ host: "box" })).toBe(false);
  reply = () => Promise.reject("Installing blimpd on box failed: curl: not found");
  await expect(installServer({ host: "box" })).rejects.toBe("Installing blimpd on box failed: curl: not found");
});
