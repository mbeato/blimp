// A Claude transcript as chat messages, for the phone (docs/DESIGN.md, Chat). The transcript is
// Claude Code's internal format: each content block is its own entry, tool results come back as
// user entries. Only what a person would see in a chat app is kept: what you typed, what Claude
// said, and one line per tool call.

import { closeSync, openSync, readSync, statSync } from "node:fs";

export type ToolMessage = { id: string; at: number; role: "tool"; name: string; summary: string; input: string; output?: string; error?: boolean };
export type ChatMessage =
  | { id: string; at: number; role: "user"; text: string }
  | { id: string; at: number; role: "assistant"; text: string }
  | ToolMessage;

// tools: tool_use id -> its message, so a later result can fill it in.
export type ChatScan = { offset: number; dir: string; tools: Map<string, ToolMessage> };
export const newScan = (dir: string): ChatScan => ({ offset: 0, dir, tools: new Map() });

const CAP = 20_000;
const cap = (s: string) => (s.length > CAP ? s.slice(0, CAP) + "\n… (cut)" : s);
const str = (v: unknown) => (typeof v === "string" ? v : "");

// Command wrappers (<command-name>), command output and system reminders all start with a tag;
// what a person types doesn't (the same rule titles use).
const typed = (t: unknown): t is string => typeof t === "string" && t.trim() !== "" && !t.startsWith("<");

const rel = (p: string, dir: string) => (dir && p.startsWith(dir + "/") ? p.slice(dir.length + 1) : p);

export function toolSummary(name: string, input: any, dir: string): string {
  switch (name) {
    case "Bash":
      return `Ran \`${str(input?.command).split("\n")[0].slice(0, 80)}\``;
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
  if (r?.type === "user" && !r.isMeta) {
    if (typeof c === "string") return typed(c) ? [{ id: r.uuid, at, role: "user", text: c }] : [];
    if (!Array.isArray(c)) return [];
    c.forEach((b: any, i: number) => {
      if (b?.type === "text" && typed(b.text)) out.push({ id: `${r.uuid}#${i}`, at, role: "user", text: b.text });
      if (b?.type === "tool_result") {
        const t = s.tools.get(b.tool_use_id);
        if (!t) return;
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
// line is read next time, once it ends.
export function readAppended(file: string, s: ChatScan): ChatMessage[] {
  const size = statSync(file).size;
  if (size < s.offset) Object.assign(s, newScan(s.dir)); // rewritten shorter: start over
  if (size === s.offset) return [];
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - s.offset);
    const n = readSync(fd, buf, 0, buf.length, s.offset);
    const end = buf.lastIndexOf(10, n - 1);
    if (end < 0) return [];
    s.offset += end + 1;
    return buf
      .toString("utf8", 0, end)
      .split("\n")
      .flatMap((l) => messagesFromLine(l, s));
  } finally {
    closeSync(fd);
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
