import { expect, test } from "bun:test";
import { AWAY, cameBack, markShown } from "./recap";

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
