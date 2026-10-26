// Visuals' copies and the visual key (src/visuals/store.ts): what blimp's show tool keeps, and what reads it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cleanVisuals, isKept, isVisualId, KEEP_MS, makeVisual, MAX_PAGE, visualKey, visualPage, visualsDir } from "../src/visuals/store";

const sock = mkdtempSync(join(tmpdir(), "blimp-visuals-"));
// Pages must be under the real home, as every file route's are.
const project = realpathSync(mkdtempSync(join(homedir(), ".blimptest-visuals-")));
const before = process.env.BLIMPD_SOCKET;
beforeAll(() => (process.env.BLIMPD_SOCKET = join(sock, "blimpd.sock")));
afterAll(() => {
  if (before === undefined) delete process.env.BLIMPD_SOCKET;
  else process.env.BLIMPD_SOCKET = before;
  rmSync(sock, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const PAGE = "<!doctype html><h1>Hello</h1>\n";

test("a copy of the page, as it was, with what it is beside it; both readable only by you", () => {
  writeFileSync(join(project, "chart.html"), PAGE);
  const v = makeVisual("blimp-1", project, "chart.html", "  Test results  ", 1_800_000_000_000);
  expect(isVisualId(v.id)).toBe(true);
  expect(v).toEqual({ id: v.id, title: "Test results", session: "blimp-1", dir: project, source: join(project, "chart.html"), at: 1_800_000_000_000 });
  writeFileSync(join(project, "chart.html"), "changed later");
  expect(visualPage(v.id)?.toString()).toBe(PAGE);
  expect(JSON.parse(readFileSync(join(visualsDir(), `${v.id}.json`), "utf8"))).toEqual(v);
  expect(statSync(join(visualsDir(), `${v.id}.html`)).mode & 0o777).toBe(0o600);
  expect(statSync(join(visualsDir(), `${v.id}.json`)).mode & 0o777).toBe(0o600);
  expect(isKept(v.id)).toBe(true);
  // An absolute path works too; each call is a new copy.
  const again = makeVisual("blimp-1", project, join(project, "chart.html"), "Again");
  expect(again.id).not.toBe(v.id);
  expect(visualPage(again.id)?.toString()).toBe("changed later");
});

test("refused, with a reason Claude can act on", () => {
  writeFileSync(join(project, "ok.html"), PAGE);
  const refused = (path: string, title = "T") => {
    try {
      makeVisual("s", project, path, title);
    } catch (e: any) {
      return [e.status, e.message];
    }
    return "made";
  };
  expect(refused("missing.html")).toEqual([404, "no such file: missing.html"]);
  expect(refused("/tmp")).toEqual([403, "outside your home folder"]);
  mkdirSync(join(project, "folder"), { recursive: true });
  expect(refused("folder")).toEqual([400, "not a file: folder"]);
  writeFileSync(join(project, "big.html"), "x".repeat(MAX_PAGE + 1));
  expect(refused("big.html")[0]).toBe(413);
  writeFileSync(join(project, "bin.html"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  expect(refused("bin.html")).toEqual([400, "the page isn't UTF-8 text"]);
  expect(refused("ok.html", "   ")).toEqual([400, "a title is required"]);
  expect(refused("ok.html", "t".repeat(81))).toEqual([400, "the title must be at most 80 characters"]);
});

test("a title's control characters become spaces", () => {
  writeFileSync(join(project, "t.html"), PAGE);
  expect(makeVisual("s", project, "t.html", "Two\nlines\t here").title).toBe("Two lines  here");
});

test("only ids blimpd makes are read; missing ones aren't kept", () => {
  expect(isVisualId("0123456789ab")).toBe(true);
  for (const bad of ["0123456789AB", "0123456789a", "../../token", "kit"]) expect(isVisualId(bad)).toBe(false);
  expect(visualPage("../../token")).toBeUndefined();
  expect(visualPage("000000000000")).toBeUndefined();
  expect(isKept("000000000000")).toBe(false);
});

test("copies older than 30 days go", () => {
  writeFileSync(join(project, "old.html"), PAGE);
  const old = makeVisual("s", project, "old.html", "Old");
  const fresh = makeVisual("s", project, "old.html", "Fresh");
  const now = Date.now();
  const past = (now - KEEP_MS - 60_000) / 1000;
  for (const ext of ["html", "json"]) utimesSync(join(visualsDir(), `${old.id}.${ext}`), past, past);
  cleanVisuals(now);
  expect(isKept(old.id)).toBe(false);
  expect(isKept(fresh.id)).toBe(true);
});

test("the visual key: HMAC-SHA256 of the token with the text 'blimp visuals'; none without a token", () => {
  expect(visualKey("beef".repeat(16))).toBe(new Bun.CryptoHasher("sha256", "beef".repeat(16)).update("blimp visuals").digest("hex"));
  expect(visualKey("beef".repeat(16))).toMatch(/^[0-9a-f]{64}$/);
  expect(visualKey("a")).not.toBe(visualKey("b"));
  expect(visualKey("")).toBe("");
});
