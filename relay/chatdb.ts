// Reading new texts from Messages' database on the Mac (docs/superpowers/specs/2026-10-26-messages-design.md,
// section 1): read-only, the rows after the last one read. Only texts from an allowed handle, in a one-to-one
// chat, that aren't the account's own or a reaction, ever leave this file.

import { Database } from "bun:sqlite";

export type Incoming = { id: string; from: string; text: string; picture: boolean };

// chat.style for a one-to-one chat; group chats are 43.
const DIRECT = 45;

export const openChatDb = (file: string) => new Database(file, { readonly: true });

// The newest row now: where a first run starts, so old history is never sent.
export function watermark(db: Database): number {
  return db.query<{ max: number | null }, []>("SELECT MAX(ROWID) AS max FROM message").get()?.max ?? 0;
}

type Row = { rowid: number; guid: string; text: string | null; body: Uint8Array | null; mine: number; reaction: number | null; pics: number; handle: string | null; style: number };

// Texts after row `after` that may go to blimpd, and the last row read: skipped rows count, so they're never read
// again. allow: handles as chat.db writes them (+15551234567, name@example.com), in any case.
export function newTexts(db: Database, after: number, allow: string[]): { last: number; texts: Incoming[] } {
  const rows = db
    .query<Row, [number]>(
      `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody AS body, m.is_from_me AS mine,
              m.associated_message_type AS reaction, m.cache_has_attachments AS pics, h.id AS handle, c.style
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE m.ROWID > ?
       ORDER BY m.ROWID ASC`,
    )
    .all(after);
  const allowed = new Set(allow.map((a) => a.toLowerCase()));
  const taken = new Set<number>();
  let last = after;
  const texts: Incoming[] = [];
  for (const r of rows) {
    last = Math.max(last, r.rowid);
    if (taken.has(r.rowid) || r.mine || r.reaction || r.style !== DIRECT || !r.handle || !allowed.has(r.handle.toLowerCase())) continue;
    taken.add(r.rowid);
    // U+FFFC marks where an attachment sits in the text.
    const text = (r.text ?? decodeBody(r.body) ?? "").replace(/￼/g, "");
    const picture = r.pics === 1;
    if (!text.trim() && !picture) continue;
    texts.push({ id: r.guid, from: r.handle, text, picture });
  }
  return { last, texts };
}

// Newer macOS keeps the text in attributedBody (a typedstream NSAttributedString) when `text` is NULL: the
// NSString's bytes after the '+' that starts them, behind a length (0x81, 0x82, 0x83: a 1, 2 or 3-byte
// little-endian length follows). Adapted from the official Claude Code iMessage plugin
// (github.com/anthropics/claude-plugins-official, external_plugins/imessage, Apache-2.0).
export function decodeBody(blob: Uint8Array | null): string | undefined {
  if (!blob) return undefined;
  const buf = Buffer.from(blob);
  let i = buf.indexOf("NSString");
  if (i < 0) return undefined;
  i += "NSString".length;
  while (i < buf.length && buf[i] !== 0x2b) i++;
  if (++i >= buf.length) return undefined;
  const b = buf[i++];
  let len = b;
  if (b === 0x81) {
    len = buf[i];
    i += 1;
  } else if (b === 0x82) {
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (b === 0x83) {
    len = buf.readUIntLE(i, 3);
    i += 3;
  }
  return i + len <= buf.length ? buf.toString("utf8", i, i + len) : undefined;
}
