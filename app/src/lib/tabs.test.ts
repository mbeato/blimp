import { describe, expect, test } from "bun:test";
import { closeTab, decodeLayout, dropHomeTabs, encodeLayout, keepServers, newLayout, openTab, releaseSession, type Layout } from "./tabs";

const two = (): Layout => openTab(newLayout("s1"), "s1", "/h/a");

describe("openTab", () => {
  test("a new folder gets a tab at the end, in front", () => {
    const l = openTab(two(), "s1", "/h/b");
    expect(l.tabs.map((t) => t.dir)).toEqual([null, "/h/a", "/h/b"]);
    expect(l.active).toBe(2);
  });
  test("an open folder's tab comes to the front instead of a second tab", () => {
    const l = openTab(openTab(two(), "s1", "/h/b"), "s1", "/h/a");
    expect(l.tabs).toHaveLength(3);
    expect(l.active).toBe(1);
  });
  test("the same folder on another server is another tab", () => {
    expect(openTab(two(), "s2", "/h/a").tabs).toHaveLength(3);
  });
  test("Home is always the first tab; opening another server's Home switches it", () => {
    const l = openTab(two(), "s2", null);
    expect(l.tabs[0]).toEqual({ server: "s2", dir: null, panes: [], focus: 0, groups: [] });
    expect(l.tabs).toHaveLength(2);
    expect(l.active).toBe(0);
  });
  test("with a session, shows it in that tab's terminal", () => {
    const l = openTab(two(), "s1", "/h/a", "x");
    expect(l.tabs[1].panes).toEqual(["x"]);
  });
});

describe("closeTab", () => {
  test("Home can't be closed", () => {
    const l = two();
    expect(closeTab(l, 0)).toBe(l);
  });
  test("closing the front tab brings the one to its right forward, or the last one", () => {
    const l = openTab(openTab(two(), "s1", "/h/b"), "s1", "/h/a"); // active 1 of [home, a, b]
    expect(closeTab(l, 1)).toMatchObject({ active: 1 });
    expect(closeTab(closeTab(l, 1), 1)).toMatchObject({ active: 0 });
  });
  test("closing a tab left of the front one keeps the same tab in front", () => {
    const l = openTab(two(), "s1", "/h/b"); // active 2
    const c = closeTab(l, 1);
    expect(c.tabs[c.active].dir).toBe("/h/b");
  });
});

describe("encode and decode", () => {
  test("round trip", () => {
    const l = { ...openTab(two(), "s1", "/h/b", "x"), show: { files: false, term: true, sessions: false } };
    expect(decodeLayout(encodeLayout(l))).toEqual(l);
  });
  test("anything malformed is null, and bad parts are dropped", () => {
    expect(decodeLayout("nope")).toBeNull();
    expect(decodeLayout(JSON.stringify({ tabs: [] }))).toBeNull();
    const l = decodeLayout(
      JSON.stringify({ tabs: [{ server: "s", dir: null, panes: ["a", 3], focus: 9 }, { server: 1 }, { server: "s", dir: "/x" }], active: 7 }),
    );
    expect(l).toEqual({
      tabs: [
        { server: "s", dir: null, panes: ["a"], focus: 0, groups: [] },
        { server: "s", dir: "/x", panes: [], focus: 0, groups: [] },
      ],
      active: 1,
      show: { files: true, term: true, sessions: true },
    });
  });
  test("kept split groups load, minus bad ones; layouts saved before them load with none", () => {
    const l = decodeLayout(JSON.stringify({ tabs: [{ server: "s", dir: null, panes: ["a"], groups: [["b", "c"], ["a", "d"], ["e"], "x", ["f", 1, "g"]] }] }));
    expect(l?.tabs[0].groups).toEqual([["b", "c"], ["f", "g"]]);
  });
  test("the session list's order loads, minus anything that isn't a name; none is none", () => {
    const l = decodeLayout(JSON.stringify({ tabs: [{ server: "s", dir: null, panes: [], order: ["b", 2, "a"] }, { server: "s", dir: "/x" }] }));
    expect(l?.tabs[0].order).toEqual(["b", "a"]);
    expect(l?.tabs[1]).not.toHaveProperty("order");
  });
  test("a folder listed twice gets one tab", () => {
    const t = { server: "s", dir: "/x", panes: [], focus: 0 };
    expect(decodeLayout(JSON.stringify({ tabs: [{ ...t, dir: null }, t, t], active: 2 }))?.tabs).toHaveLength(2);
  });
  test("a first tab that isn't Home gets a Home put in front of it", () => {
    const l = decodeLayout(JSON.stringify({ tabs: [{ server: "s", dir: "/x" }], active: 0 }));
    expect(l?.tabs.map((t) => t.dir)).toEqual([null, "/x"]);
    expect(l?.active).toBe(1);
  });
});

describe("keepServers", () => {
  test("a removed server's tabs close; Home moves to a server that's left", () => {
    let l = openTab(openTab(two(), "s2", "/h/b"), "s1", "/h/a"); // [s1 home, s1 a, s2 b], a in front
    expect(keepServers(l, ["s1", "s2"])).toBe(l);
    const k = keepServers(l, ["s2"])!;
    expect(k.tabs.map((t) => `${t.server}:${t.dir}`)).toEqual(["s2:null", "s2:/h/b"]);
    expect(k.active).toBe(0);
    expect(keepServers(l, [])).toBeNull();
  });
});

describe("dropHomeTabs", () => {
  test("a project tab for the home folder closes; Home comes forward if it was in front", () => {
    const l = openTab(openTab(two(), "s1", "/h"), "s1", "/h/b"); // [home, a, /h, b], b in front
    const d = dropHomeTabs({ ...l, active: 2 }, () => "/h");
    expect(d.tabs.map((t) => t.dir)).toEqual([null, "/h/a", "/h/b"]);
    expect(d.active).toBe(0);
    expect(dropHomeTabs(l, () => "/h").active).toBe(2);
    expect(dropHomeTabs(two(), () => "/h")).toEqual(two());
  });
});

describe("releaseSession", () => {
  test("another window keeps the session: it leaves this window's splits and kept groups, in any tab of that server", () => {
    let l = openTab(openTab(two(), "s1", "/h/a", "x"), "s1", "/h/a", "y");
    l = { ...l, tabs: l.tabs.map((t, i) => (i === 1 ? { ...t, panes: ["x", "y"], focus: 1, groups: [["x", "y"]] } : i === 0 ? { ...t, panes: ["x"] } : t)) };
    const r = releaseSession(l, "s1/x");
    expect(r.tabs[1]).toMatchObject({ panes: ["y"], focus: 0, groups: [] });
    expect(r.tabs[0].panes).toEqual([]);
    expect(releaseSession(l, "s2/x")).toBe(l);
    expect(releaseSession(l, "s1/none")).toBe(l);
  });
});
