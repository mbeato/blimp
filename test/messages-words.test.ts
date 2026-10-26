// What blimp texts, and how a texted reply answers the assistant (src/messages/words.ts).

import { expect, test } from "bun:test";
import type { Prompt } from "../src/prompt";
import { isShortAnswer, OPEN_BLIMP, plainLines, replyFor, waitText } from "../src/messages/words";

const perm = (tool: string, summary: string, options = ["Yes", "No"]): Prompt => ({ kind: "permission", tool, summary, options, keys: options.map((_, i) => String(i + 1)), answerable: true });
const question = (o: { multiSelect?: boolean; two?: boolean; answerable?: boolean } = {}): Prompt => {
  const q = { question: "Which branch?", multiSelect: !!o.multiSelect, options: [{ label: "main" }, { label: "dev" }] };
  return { kind: "question", questions: o.two ? [q, { ...q, question: "And?" }] : [q], answerable: o.answerable ?? true };
};
const at = <P extends Prompt>(p: P) => ({ ...p, at: 7 });

test("plainLines: Markdown marks out, link addresses kept, line breaks kept with at most one blank line", () => {
  expect(plainLines("**Done.** See [the PR](https://e.com/1).")).toBe("Done. See the PR (https://e.com/1).");
  expect(plainLines("# Title\n\nSome `code` and *em*.\n\n\n\n- one\n- two  ")).toBe("Title\n\nSome code and em.\n\n- one\n- two");
  expect(plainLines("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  expect(plainLines("[https://e.com](https://e.com) and ![logo](https://e.com/l.png)")).toBe("https://e.com and logo");
  expect(plainLines("> quoted\n__bold__ ~~gone~~")).toBe("quoted\nbold gone");
});

test("waitText: a permission names what it runs or uses; a single-choice question numbers its options; the rest say open blimp", () => {
  expect(waitText(perm("Bash", "blimpd send x hi"))).toBe("OK to run this?\nblimpd send x hi\n\nReply yes or no.");
  expect(waitText(perm("mcp__claude_ai_Gmail__send_message", "to: user@example.com"))).toBe("OK to use Gmail send message?\nto: user@example.com\n\nReply yes or no.");
  expect(waitText(perm("Read", ""))).toBe("OK to use Read?\n\nReply yes or no.");
  expect(waitText(perm("Bash", "x".repeat(700)))).toBe(`OK to run this?\n${"x".repeat(599)}…\n\nReply yes or no.`);
  expect(waitText(question())).toBe("Which branch?\n1. main\n2. dev\n\nReply with a number or your own words.");
  for (const p of [question({ two: true }), question({ multiSelect: true }), question({ answerable: false }), { kind: "trust", folder: "/x", options: ["Yes", "No"], answerable: true } as Prompt, { kind: "other", answerable: false } as Prompt])
    expect(waitText(p)).toBe(OPEN_BLIMP);
});

test("isShortAnswer: yes/no words and bare numbers", () => {
  for (const t of ["yes", "Y", "ok", "OKAY.", "no", "n!", "3", " 12. "]) expect(isShortAnswer(t)).toBe(true);
  for (const t of ["yes please", "", "no way", "3 or 4"]) expect(isShortAnswer(t)).toBe(false);
});

test("replyFor a permission: yes picks Yes, no picks No, other words are a no with them as the reason", () => {
  const p = at(perm("Bash", "ls"));
  expect(replyFor(p, " Yes! ")).toEqual({ type: "answer", at: 7, pick: 0, label: "Yes" });
  expect(replyFor(p, "okay")).toEqual({ type: "answer", at: 7, pick: 0, label: "Yes" });
  expect(replyFor(p, "N")).toEqual({ type: "answer", at: 7, pick: 1, label: "No" });
  expect(replyFor(p, "use the other branch")).toEqual({ type: "deny", at: 7, text: "use the other branch" });
  const screen = at(perm("Bash", "ls", ["Yes", "Yes, and don't ask again for ls", "No, and tell Claude what to do differently (esc)"]));
  expect(replyFor(screen, "no")).toEqual({ type: "answer", at: 7, pick: 2, label: "No, and tell Claude what to do differently (esc)" });
  expect(replyFor(at(perm("Bash", "ls", ["Allow", "Deny"])), "yes")).toBeUndefined();
});

test("replyFor a single-choice question: a number in range picks it, anything else is typed as the answer", () => {
  const p = at(question());
  expect(replyFor(p, "2")).toEqual({ type: "answer", at: 7, answers: [{ picks: [1] }], labels: [["dev"]] });
  expect(replyFor(p, "1.")).toEqual({ type: "answer", at: 7, answers: [{ picks: [0] }], labels: [["main"]] });
  expect(replyFor(p, "7")).toEqual({ type: "answer", at: 7, answers: [{ text: "7" }], labels: [[]] });
  expect(replyFor(p, "the release one")).toEqual({ type: "answer", at: 7, answers: [{ text: "the release one" }], labels: [[]] });
  expect(replyFor(at(question({ two: true })), "1")).toBeUndefined();
  expect(replyFor(at({ kind: "other", answerable: false } as Prompt), "yes")).toBeUndefined();
});
