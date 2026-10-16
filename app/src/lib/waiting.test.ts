import { expect, test } from "bun:test";
import type { Session } from "./api";
import { WaitWatcher, type Focus } from "./waiting";

const s = (name: string, state: Session["state"]): Session => ({
  name,
  pid: 1,
  clients: 0,
  created: 1,
  dir: "/home/u/proj",
  cmd: "claude",
  title: `Title ${name}`,
  status: "",
  state,
});

function setup(focus: Focus = { focused: false, activeTab: null }) {
  const calls: [string, string][] = [];
  const w = new WaitWatcher((t, b) => calls.push([t, b]), () => focus);
  return { w, calls, focus };
}

test("no notification on first load, even for sessions already waiting", () => {
  const { w, calls } = setup();
  w.update("srv", "/home/u", [s("a", "waiting"), s("b", "working")]);
  expect(calls).toEqual([]);
});

test("notifies when a session becomes waiting, once", () => {
  const { w, calls } = setup();
  w.update("srv", "/home/u", [s("a", "working")]);
  w.update("srv", "/home/u", [s("a", "waiting")]);
  w.update("srv", "/home/u", [s("a", "waiting")]);
  expect(calls).toEqual([["Title a is waiting for you", "~/proj"]]);
});

test("a new session that appears already waiting is announced", () => {
  const { w, calls } = setup();
  w.update("srv", "/home/u", []);
  w.update("srv", "/home/u", [s("n", "waiting")]);
  expect(calls).toHaveLength(1);
});

test("waiting again after working notifies again", () => {
  const { w, calls } = setup();
  w.update("srv", "/home/u", [s("a", "working")]);
  w.update("srv", "/home/u", [s("a", "waiting")]);
  w.update("srv", "/home/u", [s("a", "working")]);
  w.update("srv", "/home/u", [s("a", "waiting")]);
  expect(calls).toHaveLength(2);
});

test("silent when the window is focused on that session's tab", () => {
  const { w, calls, focus } = setup({ focused: true, activeTab: "srv/a" });
  w.update("srv", "/home/u", [s("a", "working"), s("b", "working")]);
  w.update("srv", "/home/u", [s("a", "waiting"), s("b", "waiting")]);
  expect(calls.map((c) => c[0])).toEqual(["Title b is waiting for you"]);
  // Same tab but the window is in the background: notify.
  focus.focused = false;
  w.update("srv", "/home/u", [s("a", "working")]);
  w.update("srv", "/home/u", [s("a", "waiting")]);
  expect(calls).toHaveLength(2);
});

test("servers are tracked separately", () => {
  const { w, calls } = setup({ focused: true, activeTab: "one/a" });
  w.update("one", "/home/u", [s("a", "working")]);
  w.update("two", "/home/u", [s("a", "waiting")]); // first load of "two"
  expect(calls).toEqual([]);
  w.update("two", "/home/u", [s("a", "working")]);
  w.update("two", "/home/u", [s("a", "waiting")]);
  expect(calls).toHaveLength(1); // two/a is not the active tab
});
