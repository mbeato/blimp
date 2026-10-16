import { expect, test } from "bun:test";
import { MAX_CHARS, parseMarkdown } from "./markdown";

test("parses Markdown to HTML", async () => {
  expect(await parseMarkdown("# Hi\n\n*there*")).toContain("<h1>Hi</h1>");
});

test("a parse past the time limit rejects without blocking this thread", async () => {
  // Quadratic in marked: seconds of work for 59 KB.
  const start = Date.now();
  let ticks = 0;
  const tick = setInterval(() => ticks++, 20);
  const err = await parseMarkdown("_a ".repeat(20000), undefined, 300).catch((e) => e);
  clearInterval(tick);
  expect(String(err)).toContain("too long");
  expect(Date.now() - start).toBeLessThan(2000);
  expect(ticks).toBeGreaterThan(5);
});

test("a parse that throws rejects with its message", async () => {
  // Deep enough to overflow the stack of any engine.
  const err = await parseMarkdown(">".repeat(200_000) + " a").catch((e) => e);
  expect((err as Error).message).toBe("Maximum call stack size exceeded.");
});

test("text over the size limit is refused up front", async () => {
  expect(String(await parseMarkdown("a".repeat(MAX_CHARS + 1)).catch((e) => e))).toContain("too big");
});

test("aborting stops the parse", async () => {
  const ac = new AbortController();
  const p = parseMarkdown("_a ".repeat(20000), ac.signal);
  ac.abort();
  expect(((await p.catch((e) => e)) as Error).name).toBe("AbortError");
});
