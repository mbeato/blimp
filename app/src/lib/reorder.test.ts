import { describe, expect, test } from "bun:test";
import { byOrder, dropIndex, moved, replaced } from "./reorder";

describe("dropIndex", () => {
  // The other tabs' middles, left to right: the dragged tab goes before the first one right of the pointer.
  test("counts the middles left of the pointer", () => {
    expect(dropIndex([10, 30, 50], 0)).toBe(0);
    expect(dropIndex([10, 30, 50], 31)).toBe(2);
    expect(dropIndex([10, 30, 50], 99)).toBe(3);
  });
});

describe("moved", () => {
  test("takes the item out and puts it at its new place", () => {
    expect(moved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moved(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moved(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

describe("byOrder", () => {
  test("the dragged order first, then the rest as they came (a new tab at the end)", () => {
    const items = ["a", "b", "c", "new"];
    expect(byOrder(items, (x) => x, ["c", "a", "b"])).toEqual(["c", "a", "b", "new"]);
    expect(byOrder(items, (x) => x, ["gone", "b"])).toEqual(["b", "a", "c", "new"]);
    expect(byOrder(items, (x) => x, undefined)).toEqual(items);
  });
});

describe("replaced", () => {
  // A woken browser tab has a new id, at the old one's place in the dragged order.
  test("the new id where the old was; an order without the old one stays", () => {
    expect(replaced(["a", "b", "c"], "b", "x")).toEqual(["a", "x", "c"]);
    const order = ["a"];
    expect(replaced(order, "b", "x")).toBe(order);
    expect(replaced(undefined, "b", "x")).toBeUndefined();
  });
});
