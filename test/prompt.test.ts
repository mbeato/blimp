import { expect, test } from "bun:test";
import { answerKeys, parseScreenOptions, promptFromHook, withScreenOptions } from "../src/prompt";

// What Claude Code 2.1.300 drew for a Bash permission prompt (from the probe, 2026-10-19).
const SCREEN = ` Bash command
 rm -f nothing-here.txt && date > probe2.txt
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm -f nothing-here.txt and date commands in /Users/mbeato/x
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend`;

test("parseScreenOptions reads the numbered options after the question", () => {
  expect(parseScreenOptions(SCREEN)).toEqual([
    "Yes",
    "Yes, and don't ask again for rm -f nothing-here.txt and date commands in /Users/mbeato/x",
    "Yes, and switch to auto mode · auto mode handles these prompts for you",
    "No",
  ]);
  expect(parseScreenOptions("no prompt here\n❯ ")).toEqual([]);
});

test("promptFromHook", () => {
  const perm = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push" }, cwd: "/p" });
  expect(perm).toEqual({ kind: "permission", tool: "Bash", summary: "Ran `git push`", options: ["Yes", "No"], keys: ["1", "\x1b"], answerable: true });

  const one = { question: "Color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "r" }, { label: "Green" }] };
  expect(promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [one] } })).toEqual({
    kind: "question",
    questions: [{ question: "Color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "r" }, { label: "Green" }] }],
    answerable: true,
  });
  const multi = { ...one, multiSelect: true };
  expect(promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [multi] } })?.answerable).toBe(false);
  expect(promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [one, one] } })?.answerable).toBe(false);
  // In default mode real Claude also sends PermissionRequest for the question tool: still a question.
  expect(promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: [one] } })).toEqual(promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [one] } }));
  expect(promptFromHook({ hook_event_name: "Elicitation" })).toEqual({ kind: "other", answerable: false });
  expect(promptFromHook({ hook_event_name: "Stop" })).toBeUndefined();
});

test("withScreenOptions swaps in the options the screen shows, as digits", () => {
  const p = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "x" } })!;
  const q = withScreenOptions(p, SCREEN);
  expect(q.kind === "permission" && q.options.length).toBe(4);
  expect(q.kind === "permission" && q.keys).toEqual(["1", "2", "3", "4"]);
  expect(withScreenOptions(p, "nothing")).toEqual(p);
});

test("answerKeys", () => {
  const p = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "x" } })!;
  expect(answerKeys(p, 0)).toBe("1");
  expect(answerKeys(p, 1)).toBe("\x1b"); // "No" without screen options: Esc cancels the prompt
  expect(answerKeys(p, 2)).toBeUndefined();
  const q = promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "?", multiSelect: false, options: [{ label: "a" }, { label: "b" }] }] } })!;
  expect(answerKeys(q, 1)).toBe("2");
  expect(answerKeys({ kind: "other", answerable: false }, 0)).toBeUndefined();
});
