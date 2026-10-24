// What a notification says (src/push/payload.ts), for each row of the spec's table.

import { expect, test } from "bun:test";
import { answerKeys, choiceLabel, promptFromHook, withScreenOptions } from "../src/prompt";
import { PERMISSION_CATEGORY, plainText, pushPayload, type Shown } from "../src/push/payload";
import type { PushEvent } from "../src/push/rule";

const base = { name: "blimp-1", kind: "claude", state: "waiting", stateSince: 5, title: "Fix the drawer", dir: "/home/m/blimp" } as const;
const ask: PushEvent = { kind: "ask", session: "blimp-1", key: 5 };
const finish: PushEvent = { kind: "finish", session: "blimp-1", key: 9 };
const permission = (options: string[], extra: object = {}) =>
  ({ ...base, prompt: { kind: "permission", tool: "Bash", summary: "Run bun test", options, keys: options.map((_, i) => String(i + 1)), answerable: true, at: 5, ...extra } }) as Shown;

test("a permission: its summary, and Yes and No as the first option and the last, with the wait's at", () => {
  expect(pushPayload(permission(["Yes", "Yes, and don't ask again for bun test", "No"]), ask)).toEqual({
    aps: { alert: { title: "Fix the drawer is waiting", body: "Run bun test" }, sound: "default", "thread-id": "blimp-1", category: PERMISSION_CATEGORY },
    session: "blimp-1",
    kind: "ask",
    at: 5,
    yes: { pick: 0, label: "Yes" },
    no: { pick: 2, label: "No" },
  });
});

test("a plan has no buttons: the app only offers Review plan, so a tap opens the chat", () => {
  const p = pushPayload(permission(["Yes, and auto-accept edits", "Yes, and manually approve edits", "No, keep planning"], { tool: "ExitPlanMode" }), ask);
  expect((p.aps as any).category).toBeUndefined();
  expect(p.yes).toBeUndefined();
  expect(p.no).toBeUndefined();
  expect(p.at).toBeUndefined();
  expect((p.aps as any).alert.title).toBe("Fix the drawer is waiting");
});

test("a risky command has no buttons: the app asks again before it allows one", () => {
  const p = pushPayload(permission(["Yes", "No"], { risky: true }), ask);
  expect((p.aps as any).category).toBeUndefined();
  expect(p.yes).toBeUndefined();
  expect(p.no).toBeUndefined();
  expect(p.at).toBeUndefined();
  expect((p.aps as any).alert.body).toBe("Run bun test");
});

test("No is the last option that starts with No, as the app's Deny picks it; else the last option", () => {
  const a = pushPayload(permission(["Yes", "No, and tell Claude what to do differently", "Always allow this"]), ask);
  expect(a.no).toEqual({ pick: 1, label: "No, and tell Claude what to do differently" });
  const b = pushPayload(permission(["Yes", "Allow once", "Cancel"]), ask);
  expect(b.no).toEqual({ pick: 2, label: "Cancel" });
});

test("a title holding a secret comes out without it", () => {
  const s = { ...permission(["Yes", "No"]), title: "deploy with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123" } as Shown;
  expect(JSON.stringify(pushPayload(s, ask))).not.toContain("ghp_");
  expect(JSON.stringify(pushPayload({ ...s, state: "done" } as Shown, finish, "ok"))).not.toContain("ghp_");
});

// What the notification sends is what blimpd accepts (src/prompt.ts): the picks, the labels and the keys agree.
test("Yes and No answer the same way on the hook's prompt and on the screen's", () => {
  const hook = promptFromHook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "bun test" }, cwd: "/w" })!;
  const screen = "Do you want to proceed?\n\u276f 1. Yes\n  2. Yes, and don't ask again for bun test commands in /w\n  3. No, and tell Claude what to do differently (esc)";
  for (const prompt of [hook, withScreenOptions(hook, screen)]) {
    const p = pushPayload({ ...base, prompt: { ...prompt, at: 5 } } as Shown, ask) as any;
    expect(choiceLabel(prompt, p.yes.pick)).toBe(p.yes.label);
    expect(choiceLabel(prompt, p.no.pick)).toBe(p.no.label);
    expect(answerKeys(prompt, p.yes.pick)).toBe("1");
    expect(answerKeys(prompt, p.no.pick)).toMatch(/^[1-9]$|^\x1b$/);
  }
});

test("a question: its first question, no buttons", () => {
  const s = { ...base, prompt: { kind: "question", questions: [{ question: "Which one?", multiSelect: false, options: [{ label: "A" }] }], answerable: true, at: 5 } } as Shown;
  expect(pushPayload(s, ask)).toEqual({ aps: { alert: { title: "Fix the drawer is waiting", body: "Which one?" }, sound: "default", "thread-id": "blimp-1" }, session: "blimp-1", kind: "ask" });
});

test("another wait (Codex, folder trust): the folder's name", () => {
  expect((pushPayload(base as Shown, ask).aps as any).alert).toEqual({ title: "Fix the drawer is waiting", body: "blimp" });
  const trust = { ...base, prompt: { kind: "trust", folder: "/home/m/blimp", options: ["Yes, I trust this folder", "No, exit"], answerable: true, at: 5 } } as Shown;
  const p = pushPayload(trust, ask);
  expect((p.aps as any).alert.body).toBe("blimp");
  expect(p.yes).toBeUndefined();
});

test("a finish: Claude's last reply as plain text, at most 150 characters, with no secrets", () => {
  const done = { ...base, state: "done" } as Shown;
  expect(pushPayload(done, finish, "## Done\n\n**Shipped** it")).toEqual({
    aps: { alert: { title: "Fix the drawer finished", body: "Done Shipped it" }, sound: "default", "thread-id": "blimp-1" },
    session: "blimp-1",
    kind: "finish",
  });
  const long = (pushPayload(done, finish, "word ".repeat(100)).aps as any).alert.body;
  expect(Array.from(long).length).toBe(150);
  expect(long.endsWith("…")).toBe(true);
  expect((pushPayload(done, finish, "Set GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 and go").aps as any).alert.body).not.toContain("ghp_");
  expect((pushPayload(done, finish).aps as any).alert.body).toBe("blimp");
});

test("Markdown's marks come out; words with underscores stay", () => {
  expect(plainText("## Done\n\n**Shipped** v0.3.8: see [the run](https://x). Use `bun test` and keep snake_case_names.\n\n- one\n- two\n```ts\nconst a = 1\n```")).toBe(
    "Done Shipped v0.3.8: see the run. Use bun test and keep snake_case_names. one two const a = 1",
  );
});
