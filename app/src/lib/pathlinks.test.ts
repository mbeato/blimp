import { expect, test } from "bun:test";
import { ExistsCache, findPaths, resolveAgainst } from "./pathlinks";

const texts = (line: string) => findPaths(line).map((m) => m.text);

test("finds paths Claude prints, with line and column", () => {
  expect(findPaths("⏺ Update(src/app.ts)")).toEqual([{ start: 9, end: 19, text: "src/app.ts" }]);
  const [m] = findPaths("see src/app.ts:42:7 for it");
  expect(m).toEqual({ start: 4, end: 19, text: "src/app.ts", line: 42, col: 7 });
  expect(findPaths("README.md:3")[0]).toMatchObject({ text: "README.md", line: 3, end: 11 });
  expect(texts("Read ~/notes/todo.md and ./run.sh, then /etc/hosts.")).toEqual(["~/notes/todo.md", "./run.sh", "/etc/hosts"]);
});

test("skips plain words, bare slashes and anything inside a URL", () => {
  expect(texts("hello world, it works")).toEqual([]);
  expect(texts("a / b and ~ alone")).toEqual([]);
  expect(texts("open https://example.com/a/b.html now")).toEqual([]);
  expect(texts("docs at https://x.dev/y and src/y.ts")).toEqual(["src/y.ts"]);
});

test("a trailing full stop isn't part of the name", () => {
  expect(findPaths("I changed app.ts.")[0]).toMatchObject({ text: "app.ts", start: 10, end: 16 });
});

test("resolves against the session's folder and home", () => {
  expect(resolveAgainst("src/a.ts", "/home/u/p", "/home/u")).toBe("/home/u/p/src/a.ts");
  expect(resolveAgainst("../b.md", "/home/u/p", "/home/u")).toBe("/home/u/b.md");
  expect(resolveAgainst("~/c.txt", "/home/u/p", "/home/u")).toBe("/home/u/c.txt");
  expect(resolveAgainst("/etc/hosts", "/home/u/p", "/home/u")).toBe("/etc/hosts");
});

test("ExistsCache lists each folder once and only says yes for files", async () => {
  const calls: string[] = [];
  const api = {
    fsList: async (dir: string) => {
      calls.push(dir);
      if (dir === "/gone") throw new Error("404");
      return { path: dir, entries: [{ name: "a.ts", kind: "file" }, { name: "lib", kind: "dir" }] };
    },
  } as any;
  const c = new ExistsCache(() => api);
  expect(await c.isFile("/p/a.ts")).toBe(true);
  expect(await c.isFile("/p/lib")).toBe(false);
  expect(await c.isFile("/p/b.ts")).toBe(false);
  expect(await c.isFile("/gone/x")).toBe(false);
  expect(calls).toEqual(["/p", "/gone"]);
});
