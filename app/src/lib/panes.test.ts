import { describe, expect, test } from "bun:test";
import { dropAt, dropTarget, equalShares, forget, moveDivider, prune, removePane, show } from "./panes";

const P = (panes: string[], focus = 0, groups: string[][] = []) => ({ panes, focus, groups });

describe("show (a click in the session list), as in VS Code's terminal groups", () => {
  test("an empty terminal shows the session", () => {
    expect(show(P([]), "a")).toEqual(P(["a"]));
  });
  test("a session in the splits on screen gets the focus there", () => {
    expect(show(P(["a", "b"]), "b")).toEqual(P(["a", "b"], 1));
  });
  test("another session shows on its own; the split group is kept, not changed", () => {
    expect(show(P(["a", "b"], 1), "c")).toEqual(P(["c"], 0, [["a", "b"]]));
  });
  test("clicking either session of a kept group brings the whole group back", () => {
    const kept = P(["c"], 0, [["a", "b"]]);
    expect(show(kept, "b")).toEqual(P(["a", "b"], 1));
    expect(show(kept, "a")).toEqual(P(["a", "b"], 0));
  });
  test("switching between two groups keeps both", () => {
    const two = P(["a", "b"], 0, [["c", "d"]]);
    expect(show(two, "d")).toEqual(P(["c", "d"], 1, [["a", "b"]]));
  });
  test("a single session shown before isn't kept as a group", () => {
    expect(show(P(["a"]), "b")).toEqual(P(["b"]));
  });
});

describe("dropAt", () => {
  test("a session from a kept group leaves it (a group of one is no group)", () => {
    expect(dropAt(P(["x"], 0, [["a", "b"]]), "b", 0, "right")).toEqual(P(["x", "b"], 1));
    expect(dropAt(P(["x"], 0, [["a", "b", "c"]]), "b", 0, "left")).toEqual(P(["b", "x"], 0, [["a", "c"]]));
  });
  test("onto an empty terminal", () => {
    expect(dropAt(P([], 0), "a", 0, "left")).toEqual(P(["a"], 0));
  });
  test("right of a split", () => {
    expect(dropAt(P(["a"], 0), "b", 0, "right")).toEqual(P(["a", "b"], 1));
  });
  test("left of a split", () => {
    expect(dropAt(P(["a", "b"], 1), "c", 1, "left")).toEqual(P(["a", "c", "b"], 1));
  });
  test("a session already shown moves instead of showing twice", () => {
    expect(dropAt(P(["a", "b", "c"], 0), "a", 2, "right")).toEqual(P(["b", "c", "a"], 2));
    expect(dropAt(P(["a", "b", "c"], 0), "c", 0, "left")).toEqual(P(["c", "a", "b"], 0));
  });
  test("onto itself changes nothing", () => {
    const p = P(["a", "b"], 1);
    expect(dropAt(p, "a", 0, "right")).toBe(p);
    expect(dropAt(p, "a", 0, "left")).toBe(p);
    // Right of a, which is already where b sits (left of b).
    expect(dropAt(p, "a", 1, "left")).toBe(p);
  });
});

describe("removePane", () => {
  test("focus stays on the same session, or moves to the neighbour", () => {
    expect(removePane(P(["a", "b", "c"], 2), 0)).toEqual(P(["b", "c"], 1));
    expect(removePane(P(["a", "b", "c"], 1), 1)).toEqual(P(["a", "c"], 1));
    expect(removePane(P(["a", "b"], 1), 1)).toEqual(P(["a"], 0));
    expect(removePane(P(["a"], 0), 0)).toEqual(P([], 0));
  });
});

describe("forget", () => {
  test("a session moved to another window leaves the splits and any kept group", () => {
    expect(forget(P(["a", "b"], 1, [["c", "d"]]), ["b", "c"])).toEqual(P(["a"], 0));
  });
});

describe("prune", () => {
  test("ended sessions leave kept groups too", () => {
    expect(prune(P(["x"], 0, [["a", "b", "c"], ["d", "e"]]), (n) => n !== "a" && n !== "d")).toEqual(P(["x"], 0, [["b", "c"]]));
  });
  test("drops ended sessions and keeps the focused one focused", () => {
    expect(prune(P(["a", "b", "c"], 2), (n) => n !== "a")).toEqual(P(["b", "c"], 1));
  });
  test("returns the same object when nothing ended", () => {
    const p = P(["a", "b"], 0);
    expect(prune(p, () => true)).toBe(p);
  });
});

describe("dropTarget", () => {
  test("left or right half of the split under the pointer", () => {
    const s = [0.5, 0.5];
    expect(dropTarget(s, 0.1)).toEqual({ at: 0, side: "left" });
    expect(dropTarget(s, 0.3)).toEqual({ at: 0, side: "right" });
    expect(dropTarget(s, 0.6)).toEqual({ at: 1, side: "left" });
    expect(dropTarget(s, 0.99)).toEqual({ at: 1, side: "right" });
    expect(dropTarget(s, 1.2)).toEqual({ at: 1, side: "right" });
    expect(dropTarget([], 0.5)).toEqual({ at: 0, side: "left" });
  });
});

describe("moveDivider", () => {
  test("moves the line between two splits, leaving the others alone", () => {
    const s = moveDivider([1 / 3, 1 / 3, 1 / 3], 0, 0.5, 0.1);
    expect(s[0]).toBeCloseTo(0.5);
    expect(s[1]).toBeCloseTo(1 / 6);
    expect(s[2]).toBeCloseTo(1 / 3);
  });
  test("neither split gets narrower than the minimum", () => {
    const s = moveDivider([0.5, 0.5], 0, 0.99, 0.1);
    expect(s[0]).toBeCloseTo(0.9);
    expect(s[1]).toBeCloseTo(0.1);
    expect(moveDivider([0.5, 0.5], 0, -1, 0.1)[0]).toBeCloseTo(0.1);
  });
  test("equal shares", () => {
    expect(equalShares(4)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});
