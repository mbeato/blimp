// A Claude transcript as chat messages, for the phone (docs/DESIGN.md, Chat). The transcript is
// Claude Code's internal format: each content block is its own entry, tool results come back as
// user entries. Only what a person would see in a chat app is kept: what you typed, what Claude
// said, and one line per tool call.

import { closeSync, openSync, readSync, statSync } from "node:fs";

export type ToolMessage = { id: string; at: number; role: "tool"; name: string; summary: string; input: string; output?: string; error?: boolean };
export type ChatMessage =
  | { id: string; at: number; role: "user"; text: string }
  | { id: string; at: number; role: "assistant"; text: string }
  | { id: string; at: number; role: "compacted" }
  | ToolMessage;

// tools: tool_use id -> its message, so a later result can fill it in (then it's dropped).
export type ChatScan = { offset: number; dir: string; tools: Map<string, ToolMessage> };
export const newScan = (dir: string): ChatScan => ({ offset: 0, dir, tools: new Map() });

// Never between the two halves of an emoji: a lone surrogate can make the phone reject the whole frame.
const cut = (s: string, n: number) => s.slice(0, /[\ud800-\udbff]/.test(s[n - 1] ?? "") ? n - 1 : n);

const CAP = 20_000;
const cap = (s: string) => (s.length > CAP ? cut(s, CAP) + "\n… (cut)" : s);
const str = (v: unknown) => (typeof v === "string" ? v : "");

// Command wrappers (<command-name>), command output and system reminders all start with a tag;
// what a person types doesn't (the same rule titles use).
const typed = (t: unknown): t is string => typeof t === "string" && t.trim() !== "" && !t.startsWith("<");

const rel = (p: string, dir: string) => (dir && p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);

export function toolSummary(name: string, input: any, dir: string): string {
  switch (name) {
    case "Bash":
      return `Ran \`${cut(str(input?.command).split("\n")[0], 80)}\``;
    case "Edit":
    case "MultiEdit":
      return `Edited ${rel(str(input?.file_path), dir)}`;
    case "NotebookEdit":
      return `Edited ${rel(str(input?.notebook_path), dir)}`;
    case "Write":
      return `Wrote ${rel(str(input?.file_path), dir)}`;
    case "Read":
      return `Read ${rel(str(input?.file_path), dir)}`;
    case "Grep":
    case "Glob":
      return `Searched for ${str(input?.pattern)}`;
    case "Task":
    case "Agent":
      return `Agent: ${str(input?.description)}`;
    default:
      return name;
  }
}

const toolInput = (name: string, input: any) => cap(name === "Bash" ? str(input?.command) : JSON.stringify(input ?? {}, null, 2));

function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b: any) => (b?.type === "text" ? str(b.text) : b?.type === "image" ? "[image]" : "")).join("\n");
}

export function messagesFromLine(line: string, s: ChatScan): ChatMessage[] {
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    return [];
  }
  const at = Date.parse(r?.timestamp) || 0;
  const c = r?.message?.content;
  const out: ChatMessage[] = [];
  // Claude Code writes a compaction's summary as a prompt; the chat shows one line instead.
  if (r?.type === "user" && r.isCompactSummary) return [{ id: r.uuid, at, role: "compacted" }];
  if (r?.type === "user" && !r.isMeta) {
    if (typeof c === "string") return typed(c) ? [{ id: r.uuid, at, role: "user", text: c }] : [];
    if (!Array.isArray(c)) return [];
    c.forEach((b: any, i: number) => {
      if (b?.type === "text" && typed(b.text)) out.push({ id: `${r.uuid}#${i}`, at, role: "user", text: b.text });
      if (b?.type === "tool_result") {
        const t = s.tools.get(b.tool_use_id);
        if (!t) return;
        s.tools.delete(b.tool_use_id);
        t.output = cap(resultText(b.content));
        if (b.is_error) t.error = true;
        out.push({ ...t });
      }
    });
  } else if (r?.type === "assistant" && Array.isArray(c)) {
    c.forEach((b: any, i: number) => {
      const id = `${r.uuid}#${i}`;
      if (b?.type === "text" && str(b.text).trim()) out.push({ id, at, role: "assistant", text: b.text });
      if (b?.type === "tool_use") {
        const t: ToolMessage = { id, at, role: "tool", name: str(b.name), summary: toolSummary(str(b.name), b.input, s.dir), input: toolInput(b.name, b.input) };
        s.tools.set(b.id, t);
        out.push({ ...t });
      }
    });
  }
  return out;
}

// Transcripts only grow. Read the complete lines added since the last read; an unfinished last
// line is read next time, once it ends. At most max bytes, unless one line is longer than that.
export function readAppended(file: string, s: ChatScan, max = Infinity): ChatMessage[] {
  const size = statSync(file).size;
  if (size < s.offset) Object.assign(s, newScan(s.dir)); // rewritten shorter: start over
  if (size === s.offset) return [];
  const fd = openSync(file, "r");
  try {
    for (let len = Math.min(size - s.offset, max); ; len = Math.min(size - s.offset, len * 2)) {
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, buf.length, s.offset);
      const end = buf.lastIndexOf(10, n - 1);
      if (end < 0 && n === len && len < size - s.offset) continue; // a line longer than len
      if (end < 0) return [];
      s.offset += end + 1;
      return buf
        .toString("utf8", 0, end)
        .split("\n")
        .flatMap((l) => messagesFromLine(l, s));
    }
  } finally {
    closeSync(fd);
  }
}

// The last n messages of a whole transcript (50-100 MB is common). Read a chunk at a time, with a
// turn of the event loop between chunks, so terminals on the same thread keep streaming; only n
// messages are kept. From the start, so tool results still find their calls. Stops early if gone().
export async function readLast(file: string, s: ChatScan, n: number, chunk = 4 << 20, gone = () => false): Promise<ChatMessage[]> {
  let list: ChatMessage[] = [];
  for (;;) {
    const from = s.offset;
    list = mergeById(list, readAppended(file, s, chunk)).slice(-n);
    if (s.offset === from || gone()) return list;
    await Bun.sleep(0);
  }
}

export function mergeById(list: ChatMessage[], add: ChatMessage[]): ChatMessage[] {
  const out = [...list];
  const at = new Map(out.map((m, i) => [m.id, i]));
  for (const m of add) {
    const i = at.get(m.id);
    if (i === undefined) at.set(m.id, out.push(m) - 1);
    else out[i] = m;
  }
  return out;
}
