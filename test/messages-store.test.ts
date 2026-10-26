// blimpd's texting state (src/messages/store.ts) and `blimpd messages` (src/messages/cli.ts), in a temp folder.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMessages } from "../src/messages/cli";
import { addOut, change, makeRelayKey, markSent, messagesOn, readRelayKey, readState, relayKeyFile, revokeRelayKey, setMessagesOn } from "../src/messages/store";

let dir = "";
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "blimp-messages-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const state = () => join(dir, "messages.json");
const config = () => join(dir, "config.json");

test("the state file: empty when missing or broken; changed in one step; 600", () => {
  expect(readState(state())).toEqual({ outbox: [], seen: [], held: [] });
  writeFileSync(state(), "[1, 2]");
  expect(readState(state())).toEqual({ outbox: [], seen: [], held: [] });
  addOut("one", 5, state());
  addOut("two", 6, state());
  expect(statSync(state()).mode & 0o777).toBe(0o600);
  const [a, b] = readState(state()).outbox;
  expect([a.text, a.at, b.text]).toEqual(["one", 5, "two"]);
  expect(a.id).not.toBe(b.id);
  markSent(a.id, state());
  expect(readState(state()).outbox.map((o) => o.text)).toEqual(["two"]);
  expect(change((s) => ((s.held = ["x"]), 7), state())).toBe(7);
  expect(readState(state())).toMatchObject({ held: ["x"], outbox: [{ text: "two" }] });
});

test("the switch keeps the rest of config.json; on from off starts again from the assistant's current reply", () => {
  writeFileSync(config(), JSON.stringify({ assistant: true, messages: { other: 1 } }));
  expect(messagesOn(config())).toBe(false);
  change((s) => void (s.primed = true), state());
  setMessagesOn(true, config(), state());
  expect(JSON.parse(readFileSync(config(), "utf8"))).toEqual({ assistant: true, messages: { other: 1, on: true } });
  expect(messagesOn(config())).toBe(true);
  expect(readState(state()).primed).toBe(false);
  change((s) => void (s.primed = true), state());
  setMessagesOn(true, config(), state()); // already on: kept
  expect(readState(state()).primed).toBe(true);
  setMessagesOn(false, config(), state());
  expect(messagesOn(config())).toBe(false);
});

test("the relay key: made once, 64 hex characters, 600; revoke deletes it", () => {
  expect(readRelayKey(dir)).toBe("");
  const k = makeRelayKey(dir);
  expect(k).toMatch(/^[0-9a-f]{64}$/);
  expect(makeRelayKey(dir)).toBe(k);
  expect(statSync(relayKeyFile(dir)).mode & 0o777).toBe(0o600);
  revokeRelayKey(dir);
  expect(existsSync(relayKeyFile(dir))).toBe(false);
});

test("blimpd messages on | off | status | revoke", () => {
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const T = 1_800_000_000_000;
    expect(runMessages(["status"], dir, T)).toBe(0);
    expect(out.mock.calls.at(-1)?.[0]).toBe("Texting is off. The relay hasn't called yet. 0 texts are waiting to go out. There's no relay key: blimpd messages on makes one.");
    expect(runMessages(["on"], dir, T)).toBe(0);
    expect(out.mock.calls.at(-1)?.[0]).toBe(`Texting is on. The relay's key is in ${relayKeyFile(dir)}: copy it into the relay's relay.json.`);
    expect(readRelayKey(dir)).toMatch(/^[0-9a-f]{64}$/);
    change((s) => void (s.relaySeen = T - 12_000), state());
    addOut("y", T, state());
    runMessages(["status"], dir, T);
    expect(out.mock.calls.at(-1)?.[0]).toBe("Texting is on. The relay last called 12 s ago. 1 text is waiting to go out.");
    runMessages([], dir, T + 3 * 60_000);
    expect(out.mock.calls.at(-1)?.[0]).toBe("Texting is on. The relay last called 3 min ago. 1 text is waiting to go out.");
    expect(runMessages(["off"], dir, T)).toBe(0);
    expect(out.mock.calls.at(-1)?.[0]).toBe("Texting is off. blimpd refuses the relay until it's on again; its key stays.");
    expect(runMessages(["revoke"], dir, T)).toBe(0);
    expect(out.mock.calls.at(-1)?.[0]).toBe("The relay's key is gone. blimpd messages on makes a new one, for a new relay.json.");
    expect(runMessages(["nope"], dir, T)).toBe(1);
    expect(runMessages(["on", "x"], dir, T)).toBe(1);
    expect(err.mock.calls.at(-1)?.[0]).toBe("blimpd messages: usage: blimpd messages on | off | status | revoke");
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
});
