import { expect, test } from "bun:test";
import { ApiError } from "./api";
import { AWAY, cameBack, markShown, pickBack, recapError, recapSections } from "./recap";

const now = 1_000_000_000_000;
const MIN = 60_000;

test("a session that comes on screen after an hour or more off it, or never on it here, gets a card", () => {
  const last = { "s/a": now - 60 * MIN, "s/b": now - 59 * MIN };
  expect(cameBack(["s/a", "s/b", "s/c"], [], last, now)).toEqual(["s/a", "s/c"]);
  expect(AWAY).toBe(60 * MIN);
});

test("one that was already on screen doesn't, however long it has been there", () => {
  expect(cameBack(["s/a", "s/b"], ["s/a"], { "s/a": now - 3 * 60 * MIN }, now)).toEqual(["s/b"]);
  expect(cameBack([], ["s/a"], {}, now)).toEqual([]);
});

test("markShown: the sessions on screen (and the ones just off it) are shown now; month-old ones are dropped", () => {
  const last = { "s/a": now - 2 * 60 * MIN, "s/old": now - 31 * 24 * 60 * MIN, "s/b": now - 5 * MIN };
  expect(markShown(last, ["s/a", "s/c"], now)).toEqual({ "s/a": now, "s/b": now - 5 * MIN, "s/c": now });
});

test("one on screen all along gets a card when the last look was an hour or more ago (the Mac was asleep)", () => {
  const last = { "s/a": now - 2 * 60 * MIN, "s/b": now - 5 * MIN };
  expect(cameBack(["s/a", "s/b"], ["s/a", "s/b"], last, now, now - 2 * 60 * MIN)).toEqual(["s/a"]);
  // Looks every 30 s while it's awake: still nothing.
  expect(cameBack(["s/a"], ["s/a"], { "s/a": now - 30_000 }, now, now - 30_000)).toEqual([]);
  // Even with nothing kept on this computer.
  expect(cameBack(["s/a"], ["s/a"], {}, now, now - 30_000)).toEqual([]);
  expect(cameBack(["s/a"], ["s/a"], {}, now, now - 61 * MIN)).toEqual(["s/a"]);
});

test("pickBack: of splits that came back together, the focused one gets the card, else the leftmost", () => {
  expect(pickBack(["s/a", "s/b"], "s/b")).toBe("s/b");
  expect(pickBack(["s/a", "s/b"], "s/c")).toBe("s/a");
  expect(pickBack(["s/a", "s/b"])).toBe("s/a");
  expect(pickBack([], "s/a")).toBeUndefined();
});

test("recapError: a blimpd from before recaps (its generic 404) says to update; one that can't recap stays silent", () => {
  expect(recapError(new ApiError(404, "not found"))).toBe("This server's blimpd is too old for recaps. Update it first.");
  expect(recapError(new ApiError(404, "Not enough to recap yet"))).toBeUndefined();
  expect(recapError(new ApiError(404, "no session named web-1"))).toBeUndefined();
  expect(recapError(new ApiError(429, "Too many recaps this hour"))).toBeUndefined();
  expect(recapError(new Error("offline"))).toBeUndefined();
});

test("recapSections: Stuck first, then In progress, Next and Done, with an empty one left out", () => {
  const r = {
    goal: "Make the phone's login work again",
    done: ["Token refresh fixed", "Tests added"],
    doing: ["Running the full test suite"],
    stuck: ["Waiting on you: approve the deploy"],
    next: ["Release v0.2.20"],
    open: ["Running the full test suite", "Waiting on you: approve the deploy", "Release v0.2.20"],
    at: now,
  };
  expect(recapSections(r)).toEqual([
    { kind: "stuck", label: "Stuck", items: ["Waiting on you: approve the deploy"] },
    { kind: "doing", label: "In progress", items: ["Running the full test suite"] },
    { kind: "next", label: "Next", items: ["Release v0.2.20"] },
    { kind: "done", label: "Done", items: ["Token refresh fixed", "Tests added"] },
  ]);
  expect(recapSections({ ...r, doing: [], stuck: [] }).map((s) => s.label)).toEqual(["Next", "Done"]);
  expect(recapSections({ ...r, done: [], doing: [], stuck: [], next: [] })).toEqual([]);
});

test("recapSections: from a blimpd before 0.3.1 (only done and open), Done and Open as before", () => {
  const old = { goal: "Tidy the README", done: ["Install steps rewritten"], open: ["Add a screenshot"], at: now };
  expect(recapSections(old)).toEqual([
    { kind: "done", label: "Done", items: ["Install steps rewritten"] },
    { kind: "open", label: "Open", items: ["Add a screenshot"] },
  ]);
  expect(recapSections({ ...old, done: [] }).map((s) => s.label)).toEqual(["Open"]);
});
