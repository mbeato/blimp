import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineEvents, sessionActivity } from "../src/activity";
import { runnableCommands } from "../src/runnable";

const tmp = mkdtempSync(join(tmpdir(), "blimp-runnable-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("runnableCommands", () => {
  test("a bash block is one command, whole, with its $ prompts taken off", () => {
    const text = "Run this:\n\n```bash\n$ cd ~/blimp\n$ bun test ./test\n```\n\nThen tell me.";
    expect(runnableCommands([text])).toEqual(["cd ~/blimp\nbun test ./test"]);
  });

  test("sh, shell, zsh and console blocks count; other languages and plain blocks don't", () => {
    const block = (lang: string, cmd: string) => "```" + lang + "\n" + cmd + "\n```";
    const text = [block("sh", "a"), block("shell", "b"), block("zsh", "c"), block("console", "d"), block("ts", "e"), block("", "f"), block("Bash", "g")].join("\n\n");
    expect(runnableCommands([text])).toEqual(["g", "d", "c", "b", "a"]);
  });

  test("inline code that starts with a command word counts, one line each; other inline code doesn't", () => {
    const text = "Try `bun run e2e copy.spec.ts`, or `npm test`. The file is `src/x.ts` and `bunx` alone isn't one; `python3 -m http.server` and `cd app && bun i` are.";
    expect(runnableCommands([text])).toEqual(["cd app && bun i", "python3 -m http.server", "npm test", "bun run e2e copy.spec.ts"]);
  });

  test("inline `! command` (what you'd type in Claude Code) is a command, whatever its first word", () => {
    const text = "Run this yourself: `! bash /private/tmp/claude-501/x.sh`, then `! gh workflow run deploy.yml --ref main`. Not `!important` or `!=`.";
    expect(runnableCommands([text])).toEqual(["gh workflow run deploy.yml --ref main", "bash /private/tmp/claude-501/x.sh"]);
  });

  test("a bare `cd <dir>` does nothing in a run of its own (the shell left open starts in Claude's folder): left out", () => {
    expect(runnableCommands(["Go `cd app`, `cd \"my dir\"` or `! cd ~/x`, then `cd app; ls`."])).toEqual(["cd app; ls"]);
  });

  test("a block that shows $ prompts and their output: only the prompted lines (and lines they continue with \\)", () => {
    expect(runnableCommands(["```console\n$ npm test\n> x@1 test\n> jest\nPASS\n```"])).toEqual(["npm test"]);
    expect(runnableCommands(["```bash\n$ ls\nfile1\nfile2\n$ docker run \\\n  -it x\nhello\n```"])).toEqual(["ls\ndocker run \\\n  -it x"]);
    // No prompts at all: the whole block.
    expect(runnableCommands(["```bash\ncd app\nbun i\n```"])).toEqual(["cd app\nbun i"]);
  });

  test("blocks and inline code in the order they come", () => {
    const text = "Try `npm a`, then:\n\n```bash\nnpm b\n```\n\nor `npm c`.";
    expect(runnableCommands([text])).toEqual(["npm c", "npm b", "npm a"]);
  });

  test("inline code inside a fenced block isn't read again", () => {
    const text = "```bash\necho `node -v`\n```";
    expect(runnableCommands([text])).toEqual(["echo `node -v`"]);
  });

  test("newest first across the reply's texts, at most 5, the same command once", () => {
    const texts = ["`npm a`", "`npm b`\n`npm c`", "`npm d` `npm e` `npm f` `npm b`"];
    expect(runnableCommands(texts)).toEqual(["npm b", "npm f", "npm e", "npm d", "npm c"]);
  });

  test("a block longer than 4000 characters, an empty one and an unclosed one are left out", () => {
    const long = "```bash\n" + "x".repeat(4001) + "\n```";
    const empty = "```bash\n\n```";
    const open = "```bash\necho never closed";
    expect(runnableCommands([long, empty, open])).toEqual([]);
    expect(runnableCommands(["```bash\n" + "x".repeat(4000) + "\n```"])).toEqual(["x".repeat(4000)]);
  });

  test("a block's longer fence closes only on one as long, and an indented fence counts", () => {
    const text = "````bash\necho ```\n````\n\n  ```sh\n  ls -la\n  ```";
    expect(runnableCommands([text])).toEqual(["ls -la", "echo ```"]);
  });

  test("no texts, no commands", () => {
    expect(runnableCommands([])).toEqual([]);
  });
});

// Lines shaped as Claude Code 2.1.300 writes them (trimmed; ids made up).
const base = { isSidechain: false, cwd: "/Users/u/blimp", sessionId: "11111111-2222-3333-4444-555555555555", version: "2.1.300", gitBranch: "main" };
const prompt = (text: string) =>
  JSON.stringify({ parentUuid: "p", ...base, promptId: "q", type: "user", message: { role: "user", content: text }, uuid: "u", timestamp: "2026-10-21T15:52:04.146Z", origin: { kind: "human" }, promptSource: "typed" });
const reply = (text: string, extra = {}) =>
  JSON.stringify({ parentUuid: "p", ...base, message: { model: "claude-opus-5-5", id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 2, cache_creation_input_tokens: 625, cache_read_input_tokens: 70445, output_tokens: 147 } }, type: "assistant", uuid: "a", timestamp: "2026-10-21T15:52:30.961Z", ...extra });
const toolResult = JSON.stringify({ parentUuid: "a", ...base, type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "ok" }] }, uuid: "t", timestamp: "2026-10-21T15:52:31.000Z", toolUseResult: { stdout: "ok" } });
const notification = JSON.stringify({ parentUuid: "a", ...base, type: "user", message: { role: "user", content: "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>" }, uuid: "n", timestamp: "2026-10-21T15:53:00.000Z", origin: { kind: "task-notification" } });

describe("the latest reply's commands, from the transcript", () => {
  test("a reply's text is said; a typed prompt starts a new reply; a tool's result and a notification don't", () => {
    expect(lineEvents(reply("Run `npm test`"))).toContainEqual({ type: "said", at: Date.parse("2026-10-21T15:52:30.961Z"), text: "Run `npm test`" });
    expect(lineEvents(prompt("run the tests and tell me"))).toContainEqual({ type: "prompt" });
    expect(lineEvents(toolResult).some((e) => e.type === "prompt")).toBe(false);
    expect(lineEvents(notification).some((e) => e.type === "prompt")).toBe(false);
    expect(lineEvents(prompt("<bash-input>ls</bash-input>")).some((e) => e.type === "prompt")).toBe(false);
  });

  test("a subagent's text and Claude Code's own notes aren't Claude's reply", () => {
    expect(lineEvents(reply("`npm a`", { isSidechain: true }))).toEqual([]);
    const synthetic = JSON.parse(reply("`npm b`"));
    synthetic.message.model = "<synthetic>";
    expect(lineEvents(JSON.stringify(synthetic)).some((e) => e.type === "said")).toBe(false);
  });

  test("the session gets the commands of the reply since the last prompt, kept across tool calls, gone with the next prompt", () => {
    const file = join(tmp, "reply.jsonl");
    writeFileSync(file, [prompt("first"), reply("Old: `npm old`"), prompt("second"), reply("Run:\n```bash\nbun test\n```"), toolResult, notification, reply("Or `npm test`.")].join("\n") + "\n");
    expect(sessionActivity(file, "claude").runnable).toEqual(["npm test", "bun test"]);
    // When the reply began (its first text): a run from before it is for an older reply.
    expect(sessionActivity(file, "claude").runnableAt).toBe(Date.parse("2026-10-21T15:52:30.961Z"));
    appendFileSync(file, prompt("thanks") + "\n");
    expect(sessionActivity(file, "claude")).not.toHaveProperty("runnable");
    expect(sessionActivity(file, "claude")).not.toHaveProperty("runnableAt");
    appendFileSync(file, reply("No commands this time.") + "\n");
    expect(sessionActivity(file, "claude")).not.toHaveProperty("runnable");
  });
});
