// The chat socket against a fake WebSocket, for what the server tests can't make happen.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatData, chatMessage, openChat } from "../src/chatsocket";

test("a chat socket that can't start closes with 1011 instead of taking blimpd down", async () => {
  // A zmx socket folder others can write: every zmx call refuses to run.
  const dir = mkdtempSync(join(tmpdir(), "blimp-zmx-"));
  chmodSync(dir, 0o777);
  const old = process.env.ZMX_DIR;
  process.env.ZMX_DIR = dir;
  try {
    let closed: { code: number; reason: string } | undefined;
    const ws: any = { data: chatData("blimpunit-chat"), send() {}, close: (code: number, reason: string) => (closed = { code, reason }) };
    await openChat(ws);
    expect(closed?.code).toBe(1011);
    await chatMessage(ws, JSON.stringify({ type: "interrupt", id: "i1" }));
  } finally {
    if (old === undefined) delete process.env.ZMX_DIR;
    else process.env.ZMX_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
