// What a notification says (src/push/payload.ts), for each row of the spec's table.

import { expect, test } from "bun:test";
import { PERMISSION_CATEGORY, plainText, pushPayload, type Shown } from "../src/push/payload";
import type { PushEvent } from "../src/push/rule";

const base = { name: "blimp-1", kind: "claude", state: "waiting", stateSince: 5, title: "Fix the drawer", dir: "/home/m/blimp" } as const;
const ask: PushEvent = { kind: "ask", session: "blimp-1", key: 5 };
const finish: PushEvent = { kind: "finish", session: "blimp-1", key: 9 };
const permission = (options: string[]) =>
  ({ ...base, prompt: { kind: "permission", tool: "Bash", summary: "Run bun test", options, keys: options.map((_, i) => String(i + 1)), answerable: true, at: 5 } }) as Shown;

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

test("a plan's No is its last option, as the screen names it", () => {
  const p = pushPayload(permission(["Yes, and auto-accept edits", "Yes, and manually approve edits", "No, keep planning"]), ask);
  expect(p.yes).toEqual({ pick: 0, label: "Yes, and auto-accept edits" });
  expect(p.no).toEqual({ pick: 2, label: "No, keep planning" });
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
