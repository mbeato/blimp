import { describe, expect, test } from "bun:test";
import { dropAt, dropTarget, equalShares, moveDivider, prune, removePane, show } from "./panes";

describe("show", () => {
  test("an empty terminal shows the session", () => {
    expect(show({ panes: [], focus: 0 }, "a")).toEqual({ panes: ["a"], focus: 0 });
  });
  test("a session already in a split gets the focus there", () => {
    expect(show({ panes: ["a", "b"], focus: 0 }, "b")).toEqual({ panes: ["a", "b"], focus: 1 });
  });
  test("otherwise it replaces the focused split", () => {
    expect(show({ panes: ["a", "b"], focus: 1 }, "c")).toEqual({ panes: ["a", "c"], focus: 1 });
  });
});

describe("dropAt", () => {
  test("onto an empty terminal", () => {
    expect(dropAt({ panes: [], focus: 0 }, "a", 0, "left")).toEqual({ panes: ["a"], focus: 0 });
  });
  test("right of a split", () => {
    expect(dropAt({ panes: ["a"], focus: 0 }, "b", 0, "right")).toEqual({ panes: ["a", "b"], focus: 1 });
  });
  test("left of a split", () => {
    expect(dropAt({ panes: ["a", "b"], focus: 1 }, "c", 1, "left")).toEqual({ panes: ["a", "c", "b"], focus: 1 });
  });
  test("a session already shown moves instead of showing twice", () => {
    expect(dropAt({ panes: ["a", "b", "c"], focus: 0 }, "a", 2, "right")).toEqual({ panes: ["b", "c", "a"], focus: 2 });
    expect(dropAt({ panes: ["a", "b", "c"], focus: 0 }, "c", 0, "left")).toEqual({ panes: ["c", "a", "b"], focus: 0 });
  });
  test("onto itself changes nothing", () => {
    const p = { panes: ["a", "b"], focus: 1 };
    expect(dropAt(p, "a", 0, "right")).toBe(p);
    expect(dropAt(p, "a", 0, "left")).toBe(p);
    // Right of a, which is already where b sits (left of b).
    expect(dropAt(p, "a", 1, "left")).toBe(p);
  });
});

describe("removePane", () => {
  test("focus stays on the same session, or moves to the neighbour", () => {
    expect(removePane({ panes: ["a", "b", "c"], focus: 2 }, 0)).toEqual({ panes: ["b", "c"], focus: 1 });
    expect(removePane({ panes: ["a", "b", "c"], focus: 1 }, 1)).toEqual({ panes: ["a", "c"], focus: 1 });
    expect(removePane({ panes: ["a", "b"], focus: 1 }, 1)).toEqual({ panes: ["a"], focus: 0 });
    expect(removePane({ panes: ["a"], focus: 0 }, 0)).toEqual({ panes: [], focus: 0 });
  });
});

describe("prune", () => {
  test("drops ended sessions and keeps the focused one focused", () => {
    expect(prune({ panes: ["a", "b", "c"], focus: 2 }, (n) => n !== "a")).toEqual({ panes: ["b", "c"], focus: 1 });
  });
  test("returns the same object when nothing ended", () => {
    const p = { panes: ["a", "b"], focus: 0 };
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
