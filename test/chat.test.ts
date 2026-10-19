import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeById, messagesFromLine, newScan, readAppended, readLast, toolSummary } from "../src/chat";

const tmp = mkdtempSync(join(tmpdir(), "blimp-chat-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const T = "2026-10-19T12:00:00.000Z";
const at = Date.parse(T);
const line = (o: object) => JSON.stringify({ timestamp: T, ...o });
const user = (uuid: string, content: unknown, extra = {}) => line({ type: "user", uuid, message: { role: "user", content }, ...extra });
const assistant = (uuid: string, content: unknown[]) => line({ type: "assistant", uuid, message: { role: "assistant", content } });

describe("messagesFromLine", () => {
  test("typed prompts and assistant text become bubbles; thinking, meta and wrappers are skipped", () => {
    const s = newScan("/home/u/p");
    expect(messagesFromLine(user("u1", "fix the bug"), s)).toEqual([{ id: "u1", at, role: "user", text: "fix the bug" }]);
    expect(messagesFromLine(user("u2", "<command-name>/clear</command-name>"), s)).toEqual([]);
    expect(messagesFromLine(user("u3", "caveat", { isMeta: true }), s)).toEqual([]);
    expect(messagesFromLine(user("u4", [{ type: "text", text: "<system-reminder>x</system-reminder>" }]), s)).toEqual([]);
    expect(messagesFromLine(assistant("a1", [{ type: "thinking", thinking: "hmm" }]), s)).toEqual([]);
    expect(messagesFromLine(assistant("a2", [{ type: "text", text: "Done. **All** green." }]), s)).toEqual([
      { id: "a2#0", at, role: "assistant", text: "Done. **All** green." },
    ]);
    expect(messagesFromLine("not json", s)).toEqual([]);
    expect(messagesFromLine(line({ type: "ai-title", aiTitle: "x" }), s)).toEqual([]);
  });

  test("a tool call is one line, and its result fills it in under the same id", () => {
    const s = newScan("/home/u/p");
    const call = messagesFromLine(assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test\necho more" } }]), s);
    expect(call).toEqual([{ id: "a1#0", at, role: "tool", name: "Bash", summary: "Ran `bun test`", input: "bun test\necho more" }]);
    const result = messagesFromLine(user("u9", [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "3 pass" }], is_error: true }]), s);
    expect(result).toEqual([{ ...call[0], output: "3 pass", error: true }]);
  });

  test("tool input and output are capped at 20 000 characters", () => {
    const s = newScan("/");
    const [m] = messagesFromLine(assistant("a1", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/x", content: "y".repeat(30000) } }]), s);
    expect((m as any).input.length).toBeLessThan(20100);
    const [r] = messagesFromLine(user("u1", [{ type: "tool_result", tool_use_id: "t1", content: "z".repeat(30000) }]), s);
    expect((r as any).output.length).toBeLessThan(20100);
  });

  test("a cut never splits an emoji in two", () => {
    const s = newScan("/");
    const [m] = messagesFromLine(assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "x".repeat(19_999) + "😀" + "y".repeat(100) } }]), s);
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    expect((m as any).input.startsWith("x".repeat(19_999) + "\n… (cut)")).toBe(true);
    expect(lone.test((m as any).input)).toBe(false);
    expect(lone.test((m as any).summary)).toBe(false);
    expect(toolSummary("Bash", { command: "x".repeat(79) + "😀" }, "/")).toBe("Ran `" + "x".repeat(79) + "`");
    expect(toolSummary("Bash", { command: "x".repeat(78) + "😀" }, "/")).toBe("Ran `" + "x".repeat(78) + "😀`");
  });
});

test("toolSummary", () => {
  const d = "/home/u/p";
  expect(toolSummary("Edit", { file_path: "/home/u/p/src/a.ts" }, d)).toBe("Edited src/a.ts");
  expect(toolSummary("Write", { file_path: "/etc/x" }, d)).toBe("Wrote /etc/x");
  expect(toolSummary("Read", { file_path: "/home/u/p/README.md" }, d)).toBe("Read README.md");
  expect(toolSummary("Grep", { pattern: "TODO" }, d)).toBe("Searched for TODO");
  expect(toolSummary("Glob", { pattern: "**/*.ts" }, d)).toBe("Searched for **/*.ts");
  expect(toolSummary("Task", { description: "find callers" }, d)).toBe("Agent: find callers");
  expect(toolSummary("Agent", { description: "review" }, d)).toBe("Agent: review");
  expect(toolSummary("Bash", { command: "x".repeat(200) }, d)).toBe("Ran `" + "x".repeat(80) + "`");
  expect(toolSummary("WebFetch", {}, d)).toBe("WebFetch");
});

test("readAppended reads only complete lines added since the last read", () => {
  const file = join(tmp, "t.jsonl");
  writeFileSync(file, user("u1", "one") + "\n" + user("u2", "tw"));
  const s = newScan("/");
  expect(readAppended(file, s).map((m) => m.id)).toEqual(["u1"]); // u2's line isn't finished
  // Claude finishes writing the line.
  writeFileSync(file, user("u1", "one") + "\n" + user("u2", "two") + "\n");
  expect(readAppended(file, s).map((m) => m.id)).toEqual(["u2"]);
  expect(readAppended(file, s)).toEqual([]);
});

test("readLast reads a whole transcript a chunk at a time: the same last messages as reading it at once", async () => {
  const file = join(tmp, "long.jsonl");
  const lines: string[] = [];
  for (let i = 0; i < 1500; i++) {
    lines.push(user(`u${i}`, `prompt ${i}`));
    lines.push(assistant(`a${i}`, [{ type: "text", text: `answer ${i}` }, { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `echo ${i}` } }]));
    // One result far longer than a chunk.
    lines.push(user(`r${i}`, [{ type: "tool_result", tool_use_id: `t${i}`, content: i === 1400 ? "z".repeat(5000) : `${i}` }]));
  }
  writeFileSync(file, lines.join("\n") + "\n" + user("half", "not finished"));
  const whole = mergeById([], readAppended(file, newScan("/"))).slice(-200);
  const s = newScan("/");
  const last = await readLast(file, s, 200, 1000);
  expect(last).toEqual(whole);
  expect(last.length).toBe(200);
  expect(last.at(-1)).toMatchObject({ id: "a1499#1", output: "1499" });
  expect(s.tools.size).toBe(0); // every call got its result, so none is kept
  // It stops at the unfinished line, which the next read picks up once it ends.
  appendFileSync(file, "\n");
  expect(readAppended(file, s).map((m) => m.id)).toEqual(["half"]);
});

test("mergeById replaces by id and appends new ones", () => {
  const a = { id: "1", at: 0, role: "user" as const, text: "a" };
  const b = { id: "2", at: 0, role: "user" as const, text: "b" };
  expect(mergeById([a, b], [{ ...a, text: "A" }, { id: "3", at: 0, role: "user", text: "c" }]).map((m: any) => m.text)).toEqual(["A", "b", "c"]);
});
