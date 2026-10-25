// What the phone's live panel shows (src/live.ts): the followed turn on top, the widgets' rows under it, the counts,
// and the pushes that carry it, under Apple's 4 KB.

import { expect, test } from "bun:test";
import { isBusy, liveAlert, livePayload, liveShape, liveState, MAX_STATE, ROWS_ALONE, ROWS_UNDER_TURN } from "../src/live";
import type { Session } from "../src/sessions";

const T = 1_800_000_000_000;
const s = (name: string, o: Partial<Session> = {}): Session => ({
  name,
  pid: 1,
  clients: 0,
  created: (T - 3_600_000) / 1000,
  dir: "/u/blimp",
  cmd: "claude",
  kind: "claude",
  title: name,
  status: "busy",
  state: "working",
  stateSince: T - 60_000,
  unread: false,
  ...o,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => s(`w${i}`, { stateSince: T - 1000 * (i + 1) }));

test("without a followed turn: the widgets' first 4 rows and every count", () => {
  const l = liveState([s("ask", { state: "waiting", stateSince: T - 5000 }), ...many(6)], new Set(), undefined, T);
  expect(ROWS_ALONE).toBe(4);
  expect(l.turn).toBeUndefined();
  expect(l.rows.map((r) => [r.session, r.state])).toEqual([["ask", "needs"], ["w5", "working"], ["w4", "working"], ["w3", "working"]]);
  expect(l.counts).toEqual({ needs: 1, new: 0, working: 6 });
});

test("a followed turn on top: its title, project, state, when its prompt went in, its steps; 3 rows under it, its own left out", () => {
  const followed = s("phone", { title: "Server update", dir: "/u/cq", stateSince: T - 2000 });
  const steps = { done: 3, total: 7, current: "Running the tests" };
  const l = liveState([followed, ...many(5)], new Set(), { session: followed, at: T - 3000, steps }, T);
  expect(ROWS_UNDER_TURN).toBe(3);
  expect(l.turn).toEqual({ session: "phone", dir: "/u/cq", title: "Server update", state: "working", since: T - 3000, steps });
  expect(l.rows.map((r) => r.session)).toEqual(["w4", "w3", "w2"]);
  expect(l.counts.working).toBe(6);
});

test("a followed turn waiting on you shows as needs you; without a task list it has no steps", () => {
  const followed = s("phone", { state: "waiting" });
  const l = liveState([followed], new Set(), { session: followed, at: T }, T);
  expect(l.turn?.state).toBe("needs");
  expect(l.turn && "steps" in l.turn).toBe(false);
});

test("the hidden projects' sessions are left out, as in the widgets; a followed turn shows whatever its project", () => {
  const secret = s("secret", { dir: "/u/secret" });
  const l = liveState([secret, s("a")], new Set(["/u/secret"]), { session: secret, at: T }, T);
  expect(l.rows.map((r) => r.session)).toEqual(["a"]);
  expect(l.counts.working).toBe(1);
  expect(l.turn?.session).toBe("secret");
});

test("titles are cut to 80 characters, then shorter until the content-state is at most 3500 bytes", () => {
  const long = "🎈".repeat(500);
  const l = liveState([s("t", { title: long }), ...many(4).map((x) => ({ ...x, title: long }))], new Set(), undefined, T);
  expect(Buffer.byteLength(JSON.stringify(l))).toBeLessThanOrEqual(MAX_STATE);
  const short = liveState([s("t", { title: "x".repeat(100) })], new Set(), undefined, T);
  expect(short.rows[0].title).toBe("x".repeat(80));
  // the whole push stays under Apple's 4 KB
  const followed = s("f", { title: long });
  const full = liveState([followed, ...many(4).map((x) => ({ ...x, title: long }))], new Set(), { session: followed, at: T, steps: { done: 1, total: 9, current: "y".repeat(80) } }, T);
  expect(Buffer.byteLength(JSON.stringify(livePayload("start", full, T)))).toBeLessThanOrEqual(4096);
});

test("a change is the counts, a row's state or title, or the turn's state, title or step; not the time", () => {
  const followed = s("f");
  const base = liveShape(liveState([followed, s("a")], new Set(), { session: followed, at: T, steps: { done: 1, total: 3 } }, T));
  const later = liveShape(liveState([followed, s("a")], new Set(), { session: followed, at: T, steps: { done: 1, total: 3 } }, T + 60_000));
  expect(later).toBe(base);
  expect(liveShape(liveState([followed, s("a", { title: "renamed" })], new Set(), { session: followed, at: T, steps: { done: 1, total: 3 } }, T))).not.toBe(base);
  expect(liveShape(liveState([followed, s("a")], new Set(), { session: followed, at: T, steps: { done: 2, total: 3 } }, T))).not.toBe(base);
  expect(liveShape(liveState([followed, s("a", { state: "waiting" })], new Set(), { session: followed, at: T, steps: { done: 1, total: 3 } }, T))).not.toBe(base);
});

test("busy: something needs you or works, or a followed turn runs", () => {
  expect(isBusy(liveState([s("a", { state: "done", unread: true })], new Set(), undefined, T))).toBe(false);
  expect(isBusy(liveState([s("a")], new Set(), undefined, T))).toBe(true);
  expect(isBusy(liveState([s("a", { state: "waiting" })], new Set(), undefined, T))).toBe(true);
  const secret = s("secret", { dir: "/u/secret" });
  expect(isBusy(liveState([secret], new Set(["/u/secret"]), { session: secret, at: T }, T))).toBe(true);
});

test("the start's alert: what needs you and what works, else the turn's title", () => {
  const l = liveState([s("a", { state: "waiting" }), s("b", { state: "waiting" }), ...many(3)], new Set(), undefined, T);
  expect(liveAlert(l)).toEqual({ title: "blimp", body: "2 need you, 3 working" });
  expect(liveAlert(liveState([s("a", { state: "waiting" })], new Set(), undefined, T)).body).toBe("1 needs you");
  const secret = s("secret", { dir: "/u/secret", title: "Hidden work" });
  expect(liveAlert(liveState([secret], new Set(["/u/secret"]), { session: secret, at: T }, T)).body).toBe("Hidden work");
});

test("the pushes: start with its type, attributes, alert (no sound) and token request; update; end dismissed at once", () => {
  const l = liveState([s("a")], new Set(), undefined, T);
  expect(livePayload("start", l, T + 999)).toEqual({
    aps: {
      timestamp: T / 1000,
      event: "start",
      "content-state": l,
      "attributes-type": "BlimpActivityAttributes",
      attributes: {},
      alert: { title: "blimp", body: "1 working" },
      "input-push-token": 1,
    },
  });
  expect(livePayload("update", l, T)).toEqual({ aps: { timestamp: T / 1000, event: "update", "content-state": l } });
  expect(livePayload("end", l, T)).toEqual({ aps: { timestamp: T / 1000, event: "end", "content-state": l, "dismissal-date": T / 1000 } });
});
