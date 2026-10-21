import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand, readRun, resultMessage, type Run, runOutput } from "../src/runs";

const tmp = mkdtempSync(join(tmpdir(), "blimp-runs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("runOutput", () => {
  test("what the command printed: after the run's output line, before its exit line", () => {
    const history = "profile says hi\n$ bun test\n── output ──\n\x1b[32m3 pass\x1b[0m\n0 fail\n\n── exit 0 ──\nuser@host:~/web$ ls\nREADME.md\n";
    expect(runOutput(history)).toBe("3 pass\n0 fail");
  });

  test("a command wider than the terminal (its echo soft-wrapped) or of several lines is skipped whole; a progress bar shows its last state", () => {
    const history = "Last login: Tue\n$ gh workflow run deploy.yml --repo characterq\nuilt/characterquilt-app\n── output ──\n✓ Created\n── exit 0 ──\n";
    expect(runOutput(history)).toBe("✓ Created");
    expect(runOutput("$ cd app\nbun install\n── output ──\n10%\r50%\r100% done\n── exit 1 ──\n")).toBe("100% done");
  });

  test("at most the last 40 lines and 4000 characters", () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    expect(runOutput(`$ x\n── output ──\n${many}\n── exit 0 ──\n`).split("\n")).toEqual(Array.from({ length: 40 }, (_, i) => `line ${i + 60}`));
    const wide = Array.from({ length: 10 }, (_, i) => `${i}${"y".repeat(999)}`).join("\n");
    const out = runOutput(`$ x\n── output ──\n${wide}\n── exit 0 ──\n`);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.split("\n")[0]).toStartWith("7");
  });

  test("no output line on screen (scrolled away): everything before the exit line", () => {
    expect(runOutput("a\nb\n── exit 2 ──\n")).toBe("a\nb");
  });
});

describe("resultMessage", () => {
  const run: Run = { command: "bun test ./test", parent: "web-1", dir: "/h/web", cwd: "/h/web", startedAt: 1, endedAt: 2, exit: 1 };

  test("the command's first line, its exit code and its output in a code block", () => {
    expect(resultMessage(run, "1 fail")).toBe("[blimp run] `bun test ./test` finished with exit 1. Last lines of its output:\n```\n1 fail\n```");
  });

  test("a command of several lines shows its first; output with ``` gets a longer fence; no output says so", () => {
    expect(resultMessage({ ...run, command: "cd app\nbun x" }, "")).toBe("[blimp run] `cd app …` finished with exit 1. It printed nothing.");
    expect(resultMessage(run, "```ts\nx\n```")).toEndWith("output:\n````\n```ts\nx\n```\n````");
    // A command with backticks gets a longer inline span, so they can't end it.
    expect(resultMessage({ ...run, command: "echo `date`" }, "")).toStartWith("[blimp run] `` echo `date` `` finished");
  });
});

describe("readRun", () => {
  test("joins what blimpd wrote at the start with what the shell wrote at the end; nothing for a session it didn't start", () => {
    writeFileSync(join(tmp, "web-run-1.json"), JSON.stringify({ command: "ls", parent: "web-1", dir: "/h/web", cwd: "/h/web/wt", startedAt: 5000 }));
    expect(readRun("web-run-1", tmp)).toEqual({ command: "ls", parent: "web-1", dir: "/h/web", cwd: "/h/web/wt", startedAt: 5000 });
    // The shell's clock is in seconds: an end before the start is the start.
    writeFileSync(join(tmp, "web-run-1.end.json"), JSON.stringify({ exit: 0, endedAt: 4000 }));
    expect(readRun("web-run-1", tmp)).toMatchObject({ endedAt: 5000, exit: 0 });
    expect(readRun("web-run-2", tmp)).toBeUndefined();
    writeFileSync(join(tmp, "web-run-3.json"), "{not json");
    expect(readRun("web-run-3", tmp)).toBeUndefined();
  });
});

test("a command is 1 to 4000 characters of text, control characters taken out", () => {
  expect(checkCommand("echo hi\x07\n")).toBe("echo hi\n");
  for (const bad of ["", "  \n", 5, undefined, "x".repeat(4001)]) expect(() => checkCommand(bad)).toThrow("command must be text of 1 to 4000 characters");
});
