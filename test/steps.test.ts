// The followed turn's steps (src/steps.ts), from Claude Code's task list tools in a transcript. The TaskCreate and
// TaskUpdate lines are captured from Claude Code 2.1.284 (October 2026) with the task text replaced by neutral words
// and the fields that don't matter here left out. TodoWrite isn't in any transcript on hand (2.1.284 uses the task
// tools), so its line is built from its documented input: { todos: [{ content, status, activeForm }] }.

import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldSteps, lineSteps, newStepScan, shownSteps, transcriptSteps } from "../src/steps";

const dir = mkdtempSync(join(tmpdir(), "blimp-steps-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Claude's call, then its result, which says the new task's id.
const create = (id: string, subject: string, ts = "2026-10-07T13:53:25.158Z") => [
  `{"parentUuid":"p${id}","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_011CfnzHZSGMxk9PusBPSTU6","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_c${id}","name":"TaskCreate","input":{"subject":"${subject}","description":"Neutral words about it."},"caller":{"type":"direct"}}],"stop_reason":"tool_use"},"type":"assistant","uuid":"a${id}","timestamp":"${ts}","sessionId":"52e03410-a0a3-4168-8f47-dbdd4e5a10ec","version":"2.1.284"}`,
  `{"parentUuid":"a${id}","isSidechain":false,"promptId":"59dd4803-7df1-46cd-ab3f-49e0925a8c9b","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_c${id}","type":"tool_result","content":"Task #${id} created successfully: ${subject}"}]},"uuid":"r${id}","timestamp":"${ts}","toolUseResult":{"task":{"id":"${id}","subject":"${subject}"}},"sourceToolAssistantUUID":"a${id}","sessionId":"52e03410-a0a3-4168-8f47-dbdd4e5a10ec","version":"2.1.284"}`,
];
// input as Claude sent it; the result as Claude Code answered.
const update = (id: string, input: string, from: string, to: string, ts = "2026-10-07T13:53:31.129Z") => [
  `{"parentUuid":"q${id}","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"msg_011CfnzJ3GpqP1f7hWaznPnZ","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_u${id}${to}","name":"TaskUpdate","input":${input},"caller":{"type":"direct"}}],"stop_reason":"tool_use"},"type":"assistant","uuid":"b${id}${to}","timestamp":"${ts}","sessionId":"52e03410-a0a3-4168-8f47-dbdd4e5a10ec","version":"2.1.284"}`,
  `{"parentUuid":"b${id}${to}","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_u${id}${to}","type":"tool_result","content":"Updated task #${id} status"}]},"uuid":"s${id}${to}","timestamp":"${ts}","toolUseResult":{"success":true,"taskId":"${id}","updatedFields":["status"],"statusChange":{"from":"${from}","to":"${to}"}},"sessionId":"52e03410-a0a3-4168-8f47-dbdd4e5a10ec","version":"2.1.284"}`,
];
const todos = (list: object[], ts = "2026-10-07T14:00:00.000Z") =>
  `{"isSidechain":false,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_t1","name":"TodoWrite","input":{"todos":${JSON.stringify(list)}}}]},"type":"assistant","uuid":"t1","timestamp":"${ts}"}`;

const read = (lines: string[]) => {
  const s = newStepScan();
  for (const line of lines) foldSteps(s, lineSteps(line));
  return s;
};

test("TaskCreate's id comes from its result; the call alone adds nothing", () => {
  const [call, result] = create("1", "Write the test");
  expect(lineSteps(call)).toEqual([]);
  expect(lineSteps(result)).toEqual([{ type: "create", at: Date.parse("2026-10-07T13:53:25.158Z"), id: "1", subject: "Write the test" }]);
});

test("TaskUpdate's input changes a step's status and words; its result adds nothing", () => {
  const [call, result] = update("1", '{"taskId":"1","subject":"Write the tests","status":"in_progress","activeForm":"Writing the tests"}', "pending", "in_progress");
  expect(lineSteps(call)).toEqual([{ type: "update", at: Date.parse("2026-10-07T13:53:31.129Z"), id: "1", status: "in_progress", subject: "Write the tests", active: "Writing the tests" }]);
  expect(lineSteps(result)).toEqual([]);
});

test("done of total, and the step in progress", () => {
  const s = read([
    ...create("1", "Write the test"),
    ...create("2", "Make it pass"),
    ...create("3", "Commit"),
    ...update("1", '{"taskId":"1","status":"completed"}', "pending", "completed"),
    ...update("2", '{"taskId":"2","status":"in_progress"}', "pending", "in_progress"),
  ]);
  expect(shownSteps(s)).toEqual({ done: 1, total: 3, current: "Make it pass" });
  expect(s.at).toBe(Date.parse("2026-10-07T13:53:31.129Z"));
});

test("a step's activeForm is its words while in progress; deleted takes it out; an unknown id changes nothing", () => {
  const s = read([
    ...create("1", "Run the tests"),
    ...create("2", "Tidy up"),
    ...update("1", '{"taskId":"1","status":"in_progress","activeForm":"Running the tests"}', "pending", "in_progress"),
    ...update("2", '{"taskId":"2","status":"deleted"}', "pending", "deleted"),
    ...update("9", '{"taskId":"9","status":"completed"}', "pending", "completed", "2026-10-07T15:00:00.000Z"),
  ]);
  expect(shownSteps(s)).toEqual({ done: 0, total: 1, current: "Running the tests" });
  expect(s.at).toBe(Date.parse("2026-10-07T13:53:31.129Z"));
});

test("a TaskCreate once every step is completed starts a new list, as the captured session's tasks 7 to 9 did", () => {
  const done = (id: string) => update(id, `{"taskId":"${id}","status":"completed"}`, "pending", "completed");
  const s = read([...create("1", "Check one"), ...create("2", "Check two"), ...done("1"), ...done("2"), ...create("7", "Write the file"), ...create("8", "Count the uses")]);
  expect(shownSteps(s)).toEqual({ done: 0, total: 2 });
});

test("a subagent's task list isn't the turn's", () => {
  const [, result] = create("1", "Write the test");
  expect(lineSteps(result.replace('"isSidechain":false', '"isSidechain":true'))).toEqual([]);
});

test("TodoWrite: each call is the whole list", () => {
  const s = read([
    todos([
      { content: "Write the test", status: "completed", activeForm: "Writing the test" },
      { content: "Make it pass", status: "in_progress", activeForm: "Making it pass" },
      { content: "Commit", status: "pending", activeForm: "Committing" },
    ]),
  ]);
  expect(shownSteps(s)).toEqual({ done: 1, total: 3, current: "Making it pass" });
  foldSteps(s, lineSteps(todos([{ content: "Commit", status: "in_progress", activeForm: "Committing" }])));
  expect(shownSteps(s)).toEqual({ done: 0, total: 1, current: "Committing" });
});

test("no task list: no steps; a prompt that only mentions the tools is no call", () => {
  expect(shownSteps(newStepScan())).toBeUndefined();
  const prompt = `{"type":"user","message":{"role":"user","content":"use TodoWrite, or TaskCreate and TaskUpdate"},"isSidechain":false}`;
  expect(lineSteps(prompt)).toEqual([]);
  expect(lineSteps("not json")).toEqual([]);
});

test("the in-progress step's words are cut to 80 characters", () => {
  const s = read([...create("1", "x".repeat(200)), ...update("1", '{"taskId":"1","status":"in_progress"}', "pending", "in_progress")]);
  expect(shownSteps(s)?.current).toBe("x".repeat(80));
});

test("a transcript is read once, then only what was added; an unfinished last line waits", () => {
  const file = join(dir, "t.jsonl");
  writeFileSync(file, [...create("1", "Write the test"), ...create("2", "Make it pass")].join("\n") + "\n");
  expect(transcriptSteps(file)?.steps).toEqual({ done: 0, total: 2 });
  const [call, result] = update("1", '{"taskId":"1","status":"in_progress"}', "pending", "in_progress");
  appendFileSync(file, call + "\n" + result);
  expect(transcriptSteps(file)?.steps).toEqual({ done: 0, total: 2, current: "Write the test" });
  appendFileSync(file, "\n" + update("1", '{"taskId":"1","status":"completed"}', "in_progress", "completed").join("\n") + "\n");
  expect(transcriptSteps(file)?.steps).toEqual({ done: 1, total: 2 });
  expect(transcriptSteps(join(dir, "missing.jsonl"))).toBeUndefined();
});
