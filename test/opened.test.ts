import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addOpened, readOpened } from "../src/opened";

const root = mkdtempSync(join(tmpdir(), "blimp-opened-"));
const file = join(root, "opened.json");
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("with no file, no folder was opened", () => {
  expect(readOpened(file)).toEqual([]);
});

test("the newest open is first, opening one again moves it to the front, at most 30 are kept, and the file is yours alone", () => {
  expect(addOpened("/w/a", 1, file)).toEqual([{ dir: "/w/a", at: 1 }]);
  expect(addOpened("/w/b", 2, file)).toEqual([{ dir: "/w/b", at: 2 }, { dir: "/w/a", at: 1 }]);
  expect(addOpened("/w/a", 3, file)).toEqual([{ dir: "/w/a", at: 3 }, { dir: "/w/b", at: 2 }]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  for (let i = 0; i < 40; i++) addOpened(`/w/n${i}`, 10 + i, file);
  const kept = readOpened(file);
  expect(kept).toHaveLength(30);
  expect(kept[0]).toEqual({ dir: "/w/n39", at: 49 });
});

test("a file that isn't a list of opened folders keeps only the entries that are", () => {
  writeFileSync(file, JSON.stringify({ dirs: [{ dir: "/w/a", at: 1 }, { dir: 5, at: 1 }, { dir: "", at: 1 }, { dir: "/w/b" }, null, "x", { dir: "/w/c", at: 2, extra: true }] }));
  expect(readOpened(file)).toEqual([{ dir: "/w/a", at: 1 }, { dir: "/w/c", at: 2 }]);
  writeFileSync(file, "not json");
  expect(readOpened(file)).toEqual([]);
});
