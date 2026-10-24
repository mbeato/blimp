import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHidden, setHidden } from "../src/hidden";

const root = mkdtempSync(join(tmpdir(), "blimp-hidden-"));
const file = join(root, "hidden.json");
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("with no file, nothing is hidden", () => {
  expect(readHidden(file)).toEqual([]);
});

test("a folder hidden twice is listed once, shown again it leaves the list, and the file is yours alone", () => {
  expect(setHidden("/w/scratch", true, file)).toEqual(["/w/scratch"]);
  expect(setHidden("/w/scratch", true, file)).toEqual(["/w/scratch"]);
  expect(setHidden("/w/old", true, file)).toEqual(["/w/scratch", "/w/old"]);
  expect(setHidden("/w/scratch", false, file)).toEqual(["/w/old"]);
  expect(readHidden(file)).toEqual(["/w/old"]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("a file that isn't a list of folders hides only the folders in it", () => {
  writeFileSync(file, JSON.stringify({ dirs: ["/w/a", 5, null, "", "/w/b"] }));
  expect(readHidden(file)).toEqual(["/w/a", "/w/b"]);
  writeFileSync(file, "not json");
  expect(readHidden(file)).toEqual([]);
});
