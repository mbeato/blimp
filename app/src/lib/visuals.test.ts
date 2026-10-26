import { expect, test } from "bun:test";
import { isVisualTab, visualFrom, visualTab } from "./visuals";

test("a visual's tab key is its page's path behind a prefix no file path has", () => {
  expect(visualTab("/home/u/p/chart.html")).toBe("visual:/home/u/p/chart.html");
  expect(isVisualTab("visual:/home/u/p/chart.html")).toBe(true);
  expect(isVisualTab("/home/u/p/chart.html")).toBe(false);
  expect(isVisualTab("gallery:/home/u/p")).toBe(false);
  expect(isVisualTab("tab:ABC")).toBe(false);
  expect(isVisualTab(null)).toBe(false);
});

test("a visual event gives what the tab needs, or nothing", () => {
  const m = { type: "visual", id: "0123456789ab", title: "Runs", session: "blimp-1", dir: "/home/u/p", source: "/home/u/p/chart.html", at: 5 };
  expect(visualFrom(m)).toEqual({ id: "0123456789ab", title: "Runs", session: "blimp-1", dir: "/home/u/p", source: "/home/u/p/chart.html", at: 5 });
  expect(visualFrom({ ...m, at: undefined })?.at).toBe(0);
  for (const bad of [{ ...m, type: "fs" }, { ...m, id: "../../token" }, { ...m, id: "0123456789AB" }, { ...m, title: 3 }, { ...m, dir: undefined }, { ...m, source: null }, { ...m, session: 1 }, null, "visual"])
    expect(visualFrom(bad)).toBeNull();
});
