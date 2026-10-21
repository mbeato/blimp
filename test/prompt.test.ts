import { expect, test } from "bun:test";
import { answerKeys, answerSteps, choiceLabel, parseDialog, parseScreenOptions, parseTrust, promptFromHook, screenMeets, trustPrompt, trustSteps, withScreenOptions } from "../src/prompt";

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
  expect(promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [multi] } })?.answerable).toBe(true);
  expect(promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [one, { ...one, question: "Size?" }] } })?.answerable).toBe(true);
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
  // The keys come from a status file: only a digit or Esc is ever pressed, whatever it says.
  const bad = { kind: "permission" as const, tool: "Bash", summary: "", options: ["a", "b", "c", "d"], keys: ["rm -rf ~\r", "0", "\x1b\x1b", "9"], answerable: true as const };
  expect([0, 1, 2, 3].map((i) => answerKeys(bad, i))).toEqual([undefined, undefined, undefined, "9"]);
});

test("choiceLabel is the text of the choice at pick", () => {
  const p = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "x" } })!;
  expect(choiceLabel(p, 1)).toBe("No");
  expect(choiceLabel(withScreenOptions(p, SCREEN), 1)).toBe("Yes, and don't ask again for rm -f nothing-here.txt and date commands in /Users/mbeato/x");
  expect(choiceLabel(p, 2)).toBeUndefined();
  const q = promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "?", multiSelect: false, options: [{ label: "a" }, { label: "b" }] }] } })!;
  expect(choiceLabel(q, 1)).toBe("b");
  expect(choiceLabel(q, -1)).toBeUndefined();
  expect(choiceLabel({ kind: "other", answerable: false }, 0)).toBeUndefined();
});

// What Claude Code 2.1.300 drew for AskUserQuestion dialogs (the probe, 2026-10-20: .superpowers/ask-probe.md).
const COLOR = `❯ Call the AskUserQuestion tool once, with exactly these 2 questions and nothing else.
────────────────────────────────────────────────────────────────────────
←  ☐ Color  ☐ Size  ✔ Submit  →

Which color?

❯ 1. Red
     Red
  2. Green
     Green
  3. Blue
     Blue
  4. Type something.
────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;
const SIZE = `←  ☒ Color  ☐ Size  ✔ Submit  →

Which size?

❯ 1. Small
     Small
  2. Large
     Large
  3. Type something.
────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;
const REVIEW = `←  ☒ Color  ☒ Size  ✔ Submit  →

Review your answers

 ● Which color?
   → Green
 ● Which size?
   → Small

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel`;
const TOPPINGS = (cursor: number, ticks: string, text = "Type something") => {
  const row = (n: number, label: string) => `${cursor === n ? "❯" : " "} ${n}. [${ticks[n - 1] === "x" ? "✔" : " "}] ${label}`;
  return `←  ☐ Toppings  ☐ Drink  ✔ Submit  →

Which toppings?

${row(1, "Cheese")}
         Cheese
${row(2, "Ham")}
         Ham
${row(3, "Olives")}
         Olives
${row(4, text)}
${cursor === 5 ? "❯" : " "}    Next
────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;
};
const DRINK_TYPED = `←  ☒ Toppings  ☐ Drink  ✔ Submit  →

Which drink?

  1. Tea
     Tea
  2. Coffee
     Coffee
❯ 3. milk
────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel`;

const q = (question: string, labels: string[], multiSelect = false) => ({ question, header: question, multiSelect, options: labels.map((label) => ({ label, description: label })) });
const ask = (...questions: ReturnType<typeof q>[]) => promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions } })!;
const colorSize = ask(q("Which color?", ["Red", "Green", "Blue"]), q("Which size?", ["Small", "Large"]));
const toppingsDrink = ask(q("Which toppings?", ["Cheese", "Ham", "Olives"], true), q("Which drink?", ["Tea", "Coffee"]));

test("every AskUserQuestion is answerable now, unless its steps couldn't be told apart or typed as one key", () => {
  expect(colorSize.answerable).toBe(true);
  expect(toppingsDrink.answerable).toBe(true);
  expect(ask(q("Which fruits?", ["Apple", "Banana"], true)).answerable).toBe(true);
  expect(ask(q("Same?", ["a"]), q("Same?", ["b"])).answerable).toBe(false); // the screen can't tell the two apart
  expect(ask(q("Many?", ["1", "2", "3", "4", "5", "6", "7", "8", "9"])).answerable).toBe(false); // "Type something" would be 10
  expect(ask().answerable).toBe(false);
});

test("pick alone still answers only one single-choice question", () => {
  expect(answerKeys(colorSize, 0)).toBeUndefined();
  expect(answerKeys(ask(q("Which fruits?", ["Apple", "Banana"], true)), 0)).toBeUndefined();
  expect(answerKeys(ask(q("Which drink?", ["Tea", "Coffee"])), 1)).toBe("2");
});

test("answerSteps: two single-choice questions are a digit each, then 1 on the review screen", () => {
  expect(answerSteps(colorSize, [{ picks: [1] }, { picks: [0] }], [["Green"], ["Small"]])).toEqual({ steps: [
    { expect: { q: 0, cursor: 1 }, keys: "2" },
    { expect: { q: 1, cursor: 1 }, keys: "1" },
    { expect: { review: true }, keys: "1" },
  ] });
});

test("answerSteps: ticks, a typed answer in a multi-choice question, and a typed answer in a single-choice one", () => {
  const r = answerSteps(toppingsDrink, [{ picks: [0, 2], text: " pine\napple " }, { text: "milk\x1b[A\x03" }], [["Cheese", "Olives"], []]);
  expect(r).toEqual({ steps: [
    { expect: { q: 0, cursor: 1, ticked: [] }, keys: "1" },
    { expect: { q: 0, cursor: 1, ticked: [1] }, keys: "3" },
    { expect: { q: 0, cursor: 1, ticked: [1, 3] }, keys: "\x1b[B\x1b[B\x1b[B" },
    { expect: { q: 0, cursor: 4, ticked: [1, 3] }, keys: "\x1b[200~pine apple\x1b[201~" },
    { expect: { q: 0, cursor: 4, ticked: [1, 3, 4], typed: true }, keys: "\x1b[B" },
    { expect: { q: 0, cursor: "next", ticked: [1, 3, 4] }, keys: "\r" },
    { expect: { q: 1, cursor: 1 }, keys: "3" },
    { expect: { q: 1, cursor: 3 }, keys: "\x1b[200~milk[A\x1b[201~" }, // no Esc or ctrl+C from the phone
    { expect: { q: 1, cursor: 3, typed: true }, keys: "\r" },
    { expect: { review: true }, keys: "1" },
  ] });
  // Ticks only, no text: ↓ past the text row to Next.
  const ticks = answerSteps(toppingsDrink, [{ picks: [1] }, { picks: [0] }], [["Ham"], ["Tea"]]);
  expect("steps" in ticks && ticks.steps.slice(1, 3)).toEqual([
    { expect: { q: 0, cursor: 1, ticked: [2] }, keys: "\x1b[B\x1b[B\x1b[B\x1b[B" },
    { expect: { q: 0, cursor: "next", ticked: [2] }, keys: "\r" },
  ]);
  // One single-choice question: its digit (or Enter after the text) submits; there's no review screen.
  expect(answerSteps(ask(q("Which drink?", ["Tea", "Coffee"])), [{ text: "water" }], [[]])).toEqual({ steps: [
    { expect: { q: 0, cursor: 1 }, keys: "3" },
    { expect: { q: 0, cursor: 3 }, keys: "\x1b[200~water\x1b[201~" },
    { expect: { q: 0, cursor: 3, typed: true }, keys: "\r" },
  ] });
});

test("answerSteps refuses answers that don't fit, and options that changed", () => {
  const err = (answers: unknown, labels: unknown = [["Green"], ["Small"]]) => (answerSteps(colorSize, answers, labels) as any).error;
  expect(err([{ picks: [1] }, { picks: [0] }], [["Red"], ["Small"]])).toBe("the question changed");
  expect(err([{ picks: [1] }])).toBe("the question changed");
  expect(err([{ picks: [1] }, { picks: [0] }], null)).toBe("the question changed");
  expect(err([{ picks: [3] }, { picks: [0] }])).toBe("that answer doesn't fit the question");
  expect(err([{ picks: [1.5] }, { picks: [0] }])).toBe("that answer doesn't fit the question");
  expect(err([{ picks: [1, 0] }, { picks: [0] }], [["Green", "Red"], ["Small"]])).toBe("pick one option or type an answer");
  expect(err([{ picks: [1], text: "x" }, { picks: [0] }])).toBe("pick one option or type an answer");
  expect(err([{ text: "\x1b\x03 " }, { picks: [0] }], [[], ["Small"]])).toBe("a typed answer must be some text, at most 2000 characters");
  expect(err([{ text: "x".repeat(2001) }, { picks: [0] }], [[], ["Small"]])).toBe("a typed answer must be some text, at most 2000 characters");
  expect((answerSteps(toppingsDrink, [{ picks: [] }, { picks: [0] }], [[], ["Tea"]]) as any).error).toBe("pick at least one option or type an answer");
  expect((answerSteps(toppingsDrink, [{ picks: [1, 1] }, { picks: [0] }], [["Ham", "Ham"], ["Tea"]]) as any).error).toBe("that answer doesn't fit the question");
  const perm = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "x" } })!;
  expect((answerSteps(perm, [{ picks: [0] }], [["Yes"]]) as any).error).toBe("the question changed");
});

test("parseDialog reads the question, its rows, the ticks and the cursor", () => {
  expect(parseDialog(COLOR)).toEqual({ question: "Which color?", review: false, cursor: 1, rows: [
    { n: 1, label: "Red" }, { n: 2, label: "Green" }, { n: 3, label: "Blue" }, { n: 4, label: "Type something." }] });
  expect(parseDialog(REVIEW)).toMatchObject({ review: true, cursor: 1, rows: [{ n: 1, label: "Submit answers" }, { n: 2, label: "Cancel" }] });
  expect(parseDialog(TOPPINGS(5, "x-x-"))).toMatchObject({ question: "Which toppings?", cursor: "next", rows: [
    { n: 1, label: "Cheese", ticked: true }, { n: 2, label: "Ham", ticked: false }, { n: 3, label: "Olives", ticked: true }, { n: 4, label: "Type something", ticked: false }] });
  expect(parseDialog("no dialog\n❯ 1. Yes")).toBeUndefined();
});

test("screenMeets checks each step's screen", () => {
  expect(screenMeets(colorSize, parseDialog(COLOR), { q: 0, cursor: 1 })).toBe(true);
  expect(screenMeets(colorSize, parseDialog(COLOR), { q: 1, cursor: 1 })).toBe(false); // still on the first question
  expect(screenMeets(colorSize, parseDialog(SIZE), { q: 1, cursor: 1 })).toBe(true);
  expect(screenMeets(colorSize, parseDialog(SIZE), { review: true })).toBe(false);
  expect(screenMeets(colorSize, parseDialog(REVIEW), { review: true })).toBe(true);
  expect(screenMeets(colorSize, parseDialog(REVIEW), { q: 1, cursor: 1 })).toBe(false);
  const t = (cursor: number, ticks: string, text?: string) => parseDialog(TOPPINGS(cursor, ticks, text));
  expect(screenMeets(toppingsDrink, t(1, "----"), { q: 0, cursor: 1, ticked: [] })).toBe(true);
  expect(screenMeets(toppingsDrink, t(1, "x---"), { q: 0, cursor: 1, ticked: [] })).toBe(false); // a box already ticked
  expect(screenMeets(toppingsDrink, t(1, "x-x-"), { q: 0, cursor: 1, ticked: [3, 1] })).toBe(true);
  expect(screenMeets(toppingsDrink, t(4, "x-x-"), { q: 0, cursor: 4, ticked: [1, 3] })).toBe(true);
  expect(screenMeets(toppingsDrink, t(4, "x-xx"), { q: 0, cursor: 4, ticked: [1, 3, 4], typed: true })).toBe(false); // the paste didn't land
  expect(screenMeets(toppingsDrink, t(4, "x-xx", "pineapple"), { q: 0, cursor: 4, ticked: [1, 3, 4], typed: true })).toBe(true);
  expect(screenMeets(toppingsDrink, t(5, "x-xx", "pineapple"), { q: 0, cursor: "next", ticked: [1, 3, 4] })).toBe(true);
  expect(screenMeets(toppingsDrink, parseDialog(DRINK_TYPED), { q: 1, cursor: 3, typed: true })).toBe(true);
  expect(screenMeets(toppingsDrink, parseDialog(DRINK_TYPED), { q: 1, cursor: 1 })).toBe(false);
  expect(screenMeets(colorSize, undefined, { q: 0, cursor: 1 })).toBe(false);
});

// A long question, as Claude Code 2.1.300 drew it on Max's phone test: a "│" down its left side, the
// text wrapped, each option with a description, then "Chat about this" under a rule.
const BORDERED = `● Moving on to the questions round.
────────────────────────────────────────────
←  ☐ Invite done?  ☐ View request  ☐ Health refresh  ☐ Password  ✔ Submit  →

│ Roadmap 1 (tab never shows connected): how should the tab know an invite request is done? This
│ decides whether we add new data or just read what's already there.

❯ 1. Match by address (Recommended)
     The tab shows the company's connection for the same website address.
  2. Agent records it
     The agent says which connection finished the request.
  3. Request gets statuses
     The request gets its own statuses.
  4. Type something.
────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

test("a question Claude draws with a border on its left is still recognised", () => {
  const q = "Roadmap 1 (tab never shows connected): how should the tab know an invite request is done? This decides whether we add new data or just read what's already there.";
  expect(parseDialog(BORDERED)).toMatchObject({ question: q, review: false, cursor: 1 });
  const p = { kind: "question", answerable: true, questions: [{ question: q, header: "Invite done?", multiSelect: false, options: [
    { label: "Match by address (Recommended)" }, { label: "Agent records it" }, { label: "Request gets statuses" },
  ] }, { question: "Second?", header: "View request", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] } as const;
  expect(screenMeets(p as any, parseDialog(BORDERED), { q: 0, cursor: 1 })).toBe(true);
});

// A question whose options have a `preview`, as Claude Code 2.1.300 drew it in Max's session (2026-10-21): the
// preview in a box beside the rows, a long label wrapped under its row, no "Type something" row. A digit
// only moves the cursor there (the probe, the same day: `2` put ❯ on row 2, Enter then answered "Beta").
const PREVIEW = `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Inbox shape

│ When you open a project on the phone, what should the inbox show? This decides what the small model writes after each
│ turn: one line per session, or one summary for the whole project.

  1. Session rows                 ┌──────────────────────────────────────────┐
    (Recommended)                 │ blimp            [New chat]              │
❯ 2. Project summary + rows       │ ───────────────────────────              │
  3. Done / In progress lists     │ Done: v0.2.16 out, phone                 │
                                  │ ? phone inbox             2m             │
                                  ├─── ✂ ─── 1 lines hidden ─────────────────┤
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel`;
const inbox = promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{
  question: "When you open a project on the phone, what should the inbox show? This decides what the small model writes after each turn: one line per session, or one summary for the whole project.",
  header: "Inbox shape", multiSelect: false, options: [
    { label: "Session rows (Recommended)", description: "a list", preview: "┌─┐\n│a│" },
    { label: "Project summary + rows", description: "a summary", preview: "┌─┐\n│b│" },
    { label: "Done / In progress lists", description: "sections", preview: "┌─┐\n│c│" },
  ] }] } })!;

test("a question with previews: its digit moves the cursor there, then Enter takes it", () => {
  expect(inbox.kind === "question" && inbox.questions[0].preview).toBe(true);
  expect(answerKeys(inbox, 1)).toBeUndefined(); // a digit alone would only move the cursor
  // The digit goes wherever the cursor is (someone may have looked at another preview on the Mac).
  expect(answerSteps(inbox, [{ picks: [1] }], [["Project summary + rows"]])).toEqual({ steps: [
    { expect: { q: 0 }, keys: "2" },
    { expect: { q: 0, cursor: 2 }, keys: "\r" },
  ] });
  expect((answerSteps(inbox, [{ text: "both" }], [[]]) as any).error).toBe("this question takes one of its options; type an answer on the Mac");
  expect(parseDialog(PREVIEW)).toMatchObject({ cursor: 2, rows: [
    { n: 1, label: "Session rows" }, { n: 2, label: "Project summary + rows" }, { n: 3, label: "Done / In progress lists" }] });
  expect(screenMeets(inbox, parseDialog(PREVIEW), { q: 0 })).toBe(true);
  expect(screenMeets(inbox, parseDialog(PREVIEW), { q: 0, cursor: 2 })).toBe(true);
  expect(screenMeets(inbox, parseDialog(PREVIEW), { q: 0, cursor: 1 })).toBe(false);
  // Without previews, a question still needs its "Type something" row on screen.
  const plain = promptFromHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [{ ...(inbox as any).questions[0], preview: undefined, options: (inbox as any).questions[0].options.map((o: any) => ({ label: o.label })) }] } })!;
  expect(screenMeets(plain, parseDialog(PREVIEW), { q: 0 })).toBe(false);
});

// Plan approval (ExitPlanMode's permission), as the probe saw it: "Would you like to proceed?", and a
// third row that opens a text field the phone can't type into while Claude waits.
const PLAN = `Ready to code?

 Here is Claude's plan:
 Add a dark mode toggle.

 Would you like to proceed?

 ❯ 1. Yes, and use auto mode
   2. Yes, manually approve edits
   3. Tell Claude what to change
`;

test("plan approval shows Claude's own choices; its text-field row becomes No, keep planning (Esc)", () => {
  const p = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "x" }, cwd: "/p" })!;
  const q = withScreenOptions(p, PLAN);
  expect(q).toMatchObject({ options: ["Yes, and use auto mode", "Yes, manually approve edits", "No, keep planning"], keys: ["1", "2", "\x1b"] });
  expect(answerKeys(q, 2)).toBe("\x1b");
});

// Claude Code 2.1.300's folder trust question at 120 columns, from `zmx history` (the probe, 2026-10-20).
const TRUST = `
${"─".repeat(120)}
 Accessing workspace:

 /tmp/blimptest-trustprobe-42dF

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;
// The same at 44 columns: the path and the question wrap.
const NARROW = `
${"─".repeat(44)}
 Accessing workspace:

 /tmp/blimptest-trustprobe-narrow/a-rather-
 long-folder-name-for-wrapping

 Quick safety check: Is this a project you
 created or one you trust? (Like your own
 code, a well-known open source project, or
 work from your team). If not, take a
 moment to review what's in this folder
 first.

 Claude Code'll be able to read, edit, and
 execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel`;

test("parseTrust reads the folder and where the cursor is", () => {
  expect(parseTrust(TRUST)).toEqual({ folder: "/tmp/blimptest-trustprobe-42dF", cursor: "no" });
  // After ↓, as the probe saw it
  expect(parseTrust(TRUST.replace(" ❯ No, exit\n   Yes", "   No, exit\n ❯ Yes"))).toEqual({ folder: "/tmp/blimptest-trustprobe-42dF", cursor: "yes" });
  expect(parseTrust(NARROW)).toEqual({ folder: "/tmp/blimptest-trustprobe-narrow/a-rather-long-folder-name-for-wrapping", cursor: "no" });
});

test("parseTrust is only the question at the screen's end, as Claude draws it", () => {
  // Answered: Claude's own screen comes after it
  expect(parseTrust(TRUST + "\n Claude Code v2.1.300\n> \n")).toBeUndefined();
  // The rows the other way round: not the layout the keys are for
  expect(parseTrust(TRUST.replace(" ❯ No, exit\n   Yes, I trust this folder", " ❯ Yes, I trust this folder\n   No, exit"))).toBeUndefined();
  expect(parseTrust(TRUST.replace("Is this a project you created or one you trust?", "Something else?"))).toBeUndefined();
  expect(parseTrust(SCREEN)).toBeUndefined();
  expect(parseTrust("")).toBeUndefined();
});

test("a trust prompt: Yes first, its label checked as a permission's; Yes is ↓ then Enter, No is Enter", () => {
  const p = trustPrompt(TRUST)!;
  expect(p).toEqual({ kind: "trust", folder: "/tmp/blimptest-trustprobe-42dF", options: ["Yes, I trust this folder", "No, exit"], answerable: true });
  expect(trustPrompt(SCREEN)).toBeUndefined();
  expect(choiceLabel(p, 0)).toBe("Yes, I trust this folder");
  expect(choiceLabel(p, 1)).toBe("No, exit");
  expect(choiceLabel(p, 2)).toBeUndefined();
  expect(answerKeys(p, 0)).toBeUndefined(); // no digit for it
  expect(trustSteps(0)).toEqual([{ cursor: "no", keys: "\x1b[B" }, { cursor: "yes", keys: "\r" }]);
  expect(trustSteps(1)).toEqual([{ cursor: "no", keys: "\r" }]);
  expect(trustSteps(2)).toBeUndefined();
  expect(trustSteps(-1)).toBeUndefined();
});
