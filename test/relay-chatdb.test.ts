// Reading new texts from Messages' database (relay/chatdb.ts), against a small database with the same tables and
// columns the query uses.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBody, newTexts, openChatDb, watermark } from "../relay/chatdb";

let dir = "";
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blimp-chatdb-"));
  db = new Database(join(dir, "chat.db"));
  db.run("CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)");
  db.run("CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER)");
  db.run("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, is_from_me INTEGER, associated_message_type INTEGER, cache_has_attachments INTEGER, handle_id INTEGER)");
  db.run("CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)");
  db.run("INSERT INTO handle VALUES (1, '+15550000000'), (2, 'user@example.com'), (3, '+15559999999')");
  db.run("INSERT INTO chat VALUES (1, 'any;-;+15550000000', 45), (2, 'any;+;chat123', 43), (3, 'any;-;user@example.com', 45), (4, 'any;-;+15559999999', 45)");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Msg = { text?: string | null; body?: Uint8Array | null; mine?: number; reaction?: number; pics?: number; handle: number; chat: number };
function add(rowid: number, m: Msg) {
  db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [rowid, `G${rowid}`, m.text === undefined ? "x" : m.text, m.body ?? null, m.mine ?? 0, m.reaction ?? 0, m.pics ?? 0, m.handle]);
  db.run("INSERT INTO chat_message_join VALUES (?, ?)", [m.chat, rowid]);
}

// A typedstream NSAttributedString as Messages writes it, cut down to what the decoder reads.
function body(text: string): Uint8Array {
  const bytes = Buffer.from(text, "utf8");
  const n = bytes.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n & 0xff, n >> 8];
  return Buffer.concat([Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01", "latin1"), Buffer.from([0x2b, ...len]), bytes, Buffer.from([0x86])]);
}

const all = ["+15550000000", "USER@example.com"];

test("watermark: the newest row, 0 for none", () => {
  const ro = () => openChatDb(join(dir, "chat.db"));
  expect(watermark(ro())).toBe(0);
  add(7, { handle: 1, chat: 1 });
  expect(watermark(ro())).toBe(7);
});

test("only allowed senders' own texts in one-to-one chats pass; skipped rows still move last on", () => {
  add(1, { text: "hello", handle: 1, chat: 1 });
  add(2, { text: "mine", handle: 1, chat: 1, mine: 1 });
  add(3, { text: "Liked “hello”", handle: 1, chat: 1, reaction: 2000 });
  add(4, { text: "group", handle: 1, chat: 2 });
  add(5, { text: "stranger", handle: 3, chat: 4 });
  add(6, { text: "from email", handle: 2, chat: 3 });
  const r = newTexts(openChatDb(join(dir, "chat.db")), 0, all);
  expect(r).toEqual({
    last: 6,
    texts: [
      { id: "G1", from: "+15550000000", text: "hello", picture: false },
      { id: "G6", from: "user@example.com", text: "from email", picture: false },
    ],
  });
  expect(newTexts(openChatDb(join(dir, "chat.db")), 6, all)).toEqual({ last: 6, texts: [] });
});

test("text kept only in attributedBody is decoded, short and long", () => {
  const long = "é".repeat(150); // 300 bytes: a 2-byte length
  add(1, { text: null, body: body("hi there"), handle: 1, chat: 1 });
  add(2, { text: null, body: body("x".repeat(200)), handle: 1, chat: 1 });
  add(3, { text: null, body: body(long), handle: 1, chat: 1 });
  expect(newTexts(openChatDb(join(dir, "chat.db")), 0, all).texts.map((t) => t.text)).toEqual(["hi there", "x".repeat(200), long]);
  expect(decodeBody(null)).toBeUndefined();
  expect(decodeBody(Buffer.from("no string here"))).toBeUndefined();
});

test("pictures: flagged, with the attachment mark taken out of the text; an empty text with nothing attached is skipped", () => {
  add(1, { text: "￼", pics: 1, handle: 1, chat: 1 });
  add(2, { text: "look ￼", pics: 1, handle: 1, chat: 1 });
  add(3, { text: "   ", handle: 1, chat: 1 });
  expect(newTexts(openChatDb(join(dir, "chat.db")), 0, all).texts).toEqual([
    { id: "G1", from: "+15550000000", text: "", picture: true },
    { id: "G2", from: "+15550000000", text: "look ", picture: true },
  ]);
});
