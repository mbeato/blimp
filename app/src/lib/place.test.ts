import { expect, test } from "bun:test";
import { placeFromQuery, placeQuery } from "./place";
import { addRecent, dropRecent } from "./recent";

test("a place round-trips through a query and keeps the browser build's own keys", () => {
  const p = { server: "max@box:2222", dir: "/home/max/a b&c", session: "a-1" };
  expect(placeFromQuery(placeQuery(p))).toEqual(p);
  const q = placeQuery({ server: "s" }, "blimpd=http%3A%2F%2F127.0.0.1%3A9&token=t&dir=/old");
  expect(placeFromQuery(q)).toEqual({ server: "s" });
  expect(new URLSearchParams(q).get("token")).toBe("t");
  expect(new URLSearchParams(q).get("blimpd")).toBe("http://127.0.0.1:9");
});

test("recent projects: newest first, no repeats, at most 20", () => {
  let list = addRecent([], "/a", 1);
  list = addRecent(list, "/b", 2);
  list = addRecent(list, "/a", 3);
  expect(list).toEqual([
    { dir: "/a", at: 3 },
    { dir: "/b", at: 2 },
  ]);
  for (let i = 0; i < 30; i++) list = addRecent(list, `/p${i}`, 10 + i);
  expect(list.length).toBe(20);
  expect(list[0].dir).toBe("/p29");
  expect(dropRecent(list, "/p29")[0].dir).toBe("/p28");
});
