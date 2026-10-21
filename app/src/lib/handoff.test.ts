import { expect, test } from "bun:test";
import type { Session } from "./api";
import { ApiError } from "./api";
import { contextMeter, handoffError, handoffNews, handoffWords, tokens } from "./handoff";

const s = (name: string, extra: Partial<Session> = {}): Session =>
  ({ name, kind: "claude", pid: 1, clients: 0, created: 1, dir: "/w", cmd: "", title: name, status: "idle", state: "done", ...extra }) as Session;

test("token counts read as people say them: 620k, 1M, 1.5M", () => {
  expect([tokens(950), tokens(620_000), tokens(255_009), tokens(200_000), tokens(1_000_000), tokens(1_048_576), tokens(1_500_000)]).toEqual(["950", "620k", "255k", "200k", "1M", "1M", "1.5M"]);
});

test("the context meter shows from half full, and in red from 80%", () => {
  expect(contextMeter(undefined)).toBeUndefined();
  expect(contextMeter({ used: 499_000, limit: 1_000_000 })).toBeUndefined();
  expect(contextMeter({ used: 10, limit: 0 })).toBeUndefined();
  expect(contextMeter({ used: 620_000, limit: 1_000_000 })).toEqual({ width: 62, high: false, label: "Context 62% (620k of 1M tokens)" });
  // Shown as 80%, so red too.
  expect(contextMeter({ used: 795_000, limit: 1_000_000 })).toEqual({ width: 80, high: true, label: "Context 80% (795k of 1M tokens)" });
  expect(contextMeter({ used: 160_000, limit: 200_000 })).toEqual({ width: 80, high: true, label: "Context 80% (160k of 200k tokens)" });
  // Over the window (an old limit for a model): the bar stops at full.
  expect(contextMeter({ used: 250_000, limit: 200_000 })).toEqual({ width: 100, high: true, label: "Context 125% (250k of 200k tokens)" });
});

test("a row says Writing handoff while Claude writes it, then Handed off once it's idle; Waiting for you wins", () => {
  expect(handoffWords(s("p"))).toBeUndefined();
  expect(handoffWords(s("p", { state: "working", handoff: { state: "writing" } }))).toBe("Writing handoff");
  expect(handoffWords(s("p", { state: "waiting", handoff: { state: "writing" } }))).toBeUndefined();
  expect(handoffWords(s("p", { state: "done", handoff: { state: "started", child: "k" } }))).toBe("Handed off");
  expect(handoffWords(s("p", { state: "working", handoff: { state: "started", child: "k" } }))).toBeUndefined();
  expect(handoffWords(s("p", { state: "done", handoff: { state: "failed", error: "x" } }))).toBeUndefined();
});

test("a handoff asked for here is news once seen being written and then started or failed, once", () => {
  const watching = new Map<string, boolean>([["p", false], ["q", false]]);
  // An older handoff's result still listed right after the click isn't this one's.
  expect(handoffNews(watching, [s("p", { handoff: { state: "started", child: "old" } }), s("q")])).toEqual([]);
  expect(handoffNews(watching, [s("p", { handoff: { state: "writing" } }), s("q", { handoff: { state: "writing" } })])).toEqual([]);
  expect(handoffNews(watching, [s("p", { handoff: { state: "started", child: "k", file: "/w/h.md" } }), s("q", { handoff: { state: "failed", error: "No handoff file came back" } })])).toEqual([
    { parent: "p", child: "k" },
    { parent: "q", error: "No handoff file came back" },
  ]);
  expect(watching.size).toBe(0);
  // A session that ended while writing is no longer watched, and says nothing.
  watching.set("r", true);
  expect(handoffNews(watching, [])).toEqual([]);
  expect(watching.size).toBe(0);
});

test("a blimpd too old for handoffs says to update it; other failures say what went wrong", () => {
  expect(handoffError(new ApiError(404, "not found"))).toBe("This server's blimpd is too old to continue in a new session. Update it first.");
  expect(handoffError(new ApiError(404, "no session named web-1"))).toBe("Couldn't continue in a new session: no session named web-1");
  expect(handoffError(new ApiError(409, "Claude is asking something. Answer it first."))).toBe("Couldn't continue in a new session: Claude is asking something. Answer it first.");
  expect(handoffError(new Error("offline"))).toBe("Couldn't continue in a new session: offline");
});
