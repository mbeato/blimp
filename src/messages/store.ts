// Texting the assistant (docs/superpowers/specs/2026-10-26-messages-design.md): the switch in config.json
// ({"messages": {"on": true}}), the relay's key (<socket dir>/relay-key), and the state file (<socket
// dir>/messages.json). The state file holds:
// - texts waiting to go out;
// - ids of texts already taken in;
// - texts held for the assistant;
// - what's been texted of its replies and questions;
// - when the relay last called.
// Every change reads, changes and writes the file in one synchronous step, so the server's routes and the
// texter's tick never lose each other's changes.

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configFile, readConfig, saveConfig } from "../names";
import { blimpDir } from "../sessions";

export type Out = { id: string; text: string; at: number };
export type MessagesState = {
  outbox: Out[];
  seen: string[]; // ids of texts taken in, newest last, at most SEEN
  held: string[]; // texts to type into the assistant once it isn't asking anything
  primed?: boolean; // sentReply was set when texting began, so a reply from before isn't texted
  sentReply?: string; // the id of the assistant's latest reply that was texted (or primed)
  lastWait?: number; // the latest question texted, by push/rule.ts's waitKey (prompt.at, or stateSince without one)
  open?: boolean; // that question is still to be answered from Messages
  relaySeen?: number; // when the relay last called (ms), for `blimpd messages status`
};

export const SEEN = 500;
export const messagesFile = (dir = blimpDir()) => join(dir, "messages.json");
export const relayKeyFile = (dir = blimpDir()) => join(dir, "relay-key");

export const messagesOn = (file = configFile()) => (readConfig(file) as { messages?: { on?: unknown } }).messages?.on === true;

export function readState(file = messagesFile()): MessagesState {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (v && typeof v === "object" && !Array.isArray(v))
      return { ...v, outbox: Array.isArray(v.outbox) ? v.outbox : [], seen: Array.isArray(v.seen) ? v.seen : [], held: Array.isArray(v.held) ? v.held : [] };
  } catch {}
  return { outbox: [], seen: [], held: [] };
}

// Reads the state, lets f change it, writes it back (temp file, rename, 600) and returns what f returned.
export function change<T>(f: (s: MessagesState) => T, file = messagesFile()): T {
  const s = readState(file);
  const r = f(s);
  writeFileSync(file + ".tmp", JSON.stringify(s), { mode: 0o600 });
  chmodSync(file + ".tmp", 0o600);
  renameSync(file + ".tmp", file);
  return r;
}

export const pushOut = (s: MessagesState, text: string, now: number) => void s.outbox.push({ id: randomUUID(), text, at: now });
export const addOut = (text: string, now = Date.now(), file = messagesFile()) => change((s) => pushOut(s, text, now), file);
export const markSent = (id: string, file = messagesFile()) => change((s) => void (s.outbox = s.outbox.filter((o) => o.id !== id)), file);

// On from off starts from the assistant's reply at that moment: nothing older is texted, and texts left from
// before (to go out, or held for it) are dropped.
export function setMessagesOn(on: boolean, file = configFile(), state = messagesFile()) {
  const was = messagesOn(file);
  const m = (readConfig(file) as { messages?: unknown }).messages;
  saveConfig({ messages: { ...(m && typeof m === "object" && !Array.isArray(m) ? m : {}), on } }, file);
  if (on && !was)
    change((s) => {
      s.primed = false;
      s.outbox = [];
      s.held = [];
      s.open = false;
    }, state);
}

export function readRelayKey(dir = blimpDir()): string {
  try {
    return readFileSync(relayKeyFile(dir), "utf8").trim();
  } catch {
    return "";
  }
}

// Made if it's missing or empty: 32 random bytes as hex, readable only by you.
export function makeRelayKey(dir = blimpDir()): string {
  let key = readRelayKey(dir);
  if (!key) writeFileSync(relayKeyFile(dir), (key = randomBytes(32).toString("hex")), { mode: 0o600 });
  chmodSync(relayKeyFile(dir), 0o600);
  return key;
}

export const revokeRelayKey = (dir = blimpDir()) => rmSync(relayKeyFile(dir), { force: true });
