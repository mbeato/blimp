// Visuals' copies and the visual key (src/visuals/store.ts): what blimp's show tool keeps, and what reads it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_CSP, pageCsp } from "../src/visuals/http";
import { cleanVisuals, isKept, isVisualId, KEEP_MS, makeVisual, MAX_FILES, MAX_FOLDER, MAX_PAGE, trimVisuals, visualFile, visualKey, visualPage, visualsDir } from "../src/visuals/store";

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
const readdirNames = () => readdirSync(visualsDir());

test("a copy of the page, as it was, with what it is beside it; both readable only by you", () => {
  writeFileSync(join(project, "chart.html"), PAGE);
  const v = makeVisual("blimp-1", project, "chart.html", "  Test results  ", 1_800_000_000_000);
  expect(isVisualId(v.id)).toBe(true);
  expect(v).toEqual({ id: v.id, title: "Test results", session: "blimp-1", dir: project, source: join(project, "chart.html"), at: 1_800_000_000_000 });
  writeFileSync(join(project, "chart.html"), "changed later");
  expect(visualPage(v.id)?.toString()).toBe(PAGE);
  expect(JSON.parse(readFileSync(join(visualsDir(), `${v.id}.json`), "utf8"))).toEqual(v);
  expect(statSync(join(visualsDir(), v.id)).mode & 0o777).toBe(0o700);
  expect(statSync(join(visualsDir(), v.id, "index.html")).mode & 0o777).toBe(0o600);
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
  expect(refused("folder")).toEqual([400, "no index.html in folder: a folder's page is its index.html"]);
  writeFileSync(join(project, "big.html"), "x".repeat(MAX_PAGE + 1));
  expect(refused("big.html")[0]).toBe(413);
  writeFileSync(join(project, "bin.html"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  expect(refused("bin.html")).toEqual([400, "the page isn't UTF-8 text"]);
  expect(refused("ok.html", "   ")).toEqual([400, "a title is required"]);
  expect(refused("ok.html", "t".repeat(81))).toEqual([400, "the title must be at most 80 characters"]);
});

const refusal = (path: string) => {
  try {
    makeVisual("s", project, path, "T");
  } catch (e: any) {
    return [e.status, e.message];
  }
  return "made";
};

test("a folder is copied whole, with its page as index.html; dot names are left out", () => {
  const dir = join(project, "render");
  mkdirSync(join(dir, "models", "deep"), { recursive: true });
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "index.html"), PAGE);
  writeFileSync(join(dir, "models", "couch.glb"), Buffer.from([0x67, 0x6c, 0x54, 0x46, 0xff, 0x00]));
  writeFileSync(join(dir, "models", "deep", "wall.jpg"), "jpg");
  writeFileSync(join(dir, ".DS_Store"), "x");
  writeFileSync(join(dir, ".git", "config"), "x");
  const v = makeVisual("blimp-1", project, "render", "The flat");
  expect(v.source).toBe(dir);
  expect(visualPage(v.id)?.toString()).toBe(PAGE);
  const glb = visualFile(v.id, "models/couch.glb")!;
  expect(glb).toBe(join(visualsDir(), v.id, "models", "couch.glb"));
  expect(readFileSync(glb)).toEqual(Buffer.from([0x67, 0x6c, 0x54, 0x46, 0xff, 0x00]));
  expect(statSync(glb).mode & 0o777).toBe(0o600);
  expect(readFileSync(visualFile(v.id, "models/deep/wall.jpg")!, "utf8")).toBe("jpg");
  expect(visualFile(v.id, "index.html")).toBe(join(visualsDir(), v.id, "index.html"));
  expect(existsSync(join(visualsDir(), v.id, ".DS_Store"))).toBe(false);
  expect(existsSync(join(visualsDir(), v.id, ".git"))).toBe(false);
  // The copy is as it was: a file changed or added later isn't in it.
  writeFileSync(join(dir, "models", "couch.glb"), "changed");
  writeFileSync(join(dir, "later.png"), "x");
  expect(readFileSync(glb).length).toBe(6);
  expect(visualFile(v.id, "later.png")).toBeUndefined();
});

test("a copy's files are read only inside it", () => {
  const dir = join(project, "inside");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "index.html"), PAGE);
  writeFileSync(join(dir, "sub", "a.png"), "a");
  const v = makeVisual("s", project, "inside", "T");
  const other = makeVisual("s", project, "inside", "T");
  for (const bad of ["", "sub", "sub/", "nope.png", "../" + other.id + "/index.html", "sub/../../" + v.id + ".json", "/etc/hostname", "sub/a.png\0.html"]) expect(visualFile(v.id, bad)).toBeUndefined();
  expect(visualFile("../" + v.id, "index.html")).toBeUndefined();
  expect(visualFile(v.id, "sub/../sub/a.png")).toBe(join(visualsDir(), v.id, "sub", "a.png"));
  // A copy from before visuals could be folders is one file: the page, and no files beside it.
  writeFileSync(join(visualsDir(), "0123456789ab.html"), PAGE);
  expect(visualPage("0123456789ab")?.toString()).toBe(PAGE);
  expect(isKept("0123456789ab")).toBe(true);
  expect(visualFile("0123456789ab", "index.html")).toBeUndefined();
  rmSync(join(visualsDir(), "0123456789ab.html"));
});

test("a folder is refused, with a reason Claude can act on", () => {
  const dir = (name: string) => {
    mkdirSync(join(project, name), { recursive: true });
    return join(project, name);
  };
  writeFileSync(join(dir("big-page"), "index.html"), "x".repeat(MAX_PAGE + 1));
  expect(refusal("big-page")[0]).toBe(413);
  expect(refusal("big-page")[1]).toContain("over 2 MB");
  writeFileSync(join(dir("bin-page"), "index.html"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  expect(refusal("bin-page")).toEqual([400, "the page isn't UTF-8 text"]);

  writeFileSync(join(dir("linked"), "index.html"), PAGE);
  mkdirSync(join(project, "linked", "models"));
  symlinkSync("/etc/hostname", join(project, "linked", "models", "host.txt"));
  expect(refusal("linked")).toEqual([400, "a link can't be shown, only files: models/host.txt"]);
  // A link to a folder isn't followed either.
  writeFileSync(join(dir("linked-dir"), "index.html"), PAGE);
  symlinkSync(project, join(project, "linked-dir", "up"));
  expect(refusal("linked-dir")).toEqual([400, "a link can't be shown, only files: up"]);

  writeFileSync(join(dir("own-kit"), "index.html"), PAGE);
  mkdirSync(join(project, "own-kit", "kit"));
  expect(refusal("own-kit")).toEqual([400, "the folder has its own kit: that name is blimp's, so call yours something else"]);
  // Only at the top: the page's kit/ paths are the only ones that go to blimp's.
  writeFileSync(join(dir("deep-kit"), "index.html"), PAGE);
  mkdirSync(join(project, "deep-kit", "js", "kit"), { recursive: true });
  writeFileSync(join(project, "deep-kit", "js", "kit", "a.js"), "1");
  expect(refusal("deep-kit")).toBe("made");

  writeFileSync(join(dir("heavy"), "index.html"), PAGE);
  writeFileSync(join(project, "heavy", "a.glb"), "");
  truncateSync(join(project, "heavy", "a.glb"), MAX_FOLDER);
  expect(refusal("heavy")).toEqual([413, "the folder is over 100 MB: show a folder with only what the page loads"]);
  truncateSync(join(project, "heavy", "a.glb"), 0);

  writeFileSync(join(dir("many"), "index.html"), PAGE);
  for (let i = 0; i < MAX_FILES; i++) writeFileSync(join(project, "many", `f${i}.txt`), "");
  expect(refusal("many")).toEqual([413, "the folder has over 500 files: show a folder with only what the page loads"]);
  rmSync(join(project, "many", "f0.txt"));
  expect(refusal("many")).toBe("made");
  // Nothing half-made is left behind by a refusal.
  for (const n of readdirNames()) expect(existsSync(join(visualsDir(), n.replace(/\.json$/, ""), "index.html")) || n.endsWith(".html")).toBe(true);
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

test("copies older than 30 days go, a folder's and an earlier single file's", () => {
  writeFileSync(join(project, "old.html"), PAGE);
  const old = makeVisual("s", project, "old.html", "Old");
  const fresh = makeVisual("s", project, "old.html", "Fresh");
  const now = Date.now();
  const past = (now - KEEP_MS - 60_000) / 1000;
  for (const n of [old.id, `${old.id}.json`, join(old.id, "index.html")]) utimesSync(join(visualsDir(), n), past, past);
  writeFileSync(join(visualsDir(), "0123456789ab.html"), PAGE);
  writeFileSync(join(visualsDir(), "0123456789ab.json"), "{}");
  for (const ext of ["html", "json"]) utimesSync(join(visualsDir(), `0123456789ab.${ext}`), past, past);
  cleanVisuals(now);
  expect(isKept(old.id)).toBe(false);
  expect(readdirNames().filter((n) => n.startsWith(old.id) || n.startsWith("0123456789ab"))).toEqual([]);
  expect(isKept(fresh.id)).toBe(true);
});

test("over the cap in all, the oldest copies go first, never the one just made", () => {
  for (const n of readdirNames()) rmSync(join(visualsDir(), n), { recursive: true, force: true });
  const dir = join(project, "capped");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), PAGE);
  writeFileSync(join(dir, "a.bin"), "x".repeat(1000));
  const made = [0, 1, 2].map((i) => {
    const v = makeVisual("s", project, "capped", `V${i}`);
    const at = Date.now() / 1000 - (3 - i) * 100;
    for (const n of [v.id, `${v.id}.json`]) utimesSync(join(visualsDir(), n), at, at);
    return v;
  });
  // Each is a little over 1000 bytes: room for two.
  trimVisuals(undefined, 2600);
  expect(made.map((v) => isKept(v.id))).toEqual([false, true, true]);
  expect(readdirNames().some((n) => n.startsWith(made[0].id))).toBe(false);
  // The one just made stays even when it alone is over.
  trimVisuals(made[1].id, 500);
  expect(made.map((v) => isKept(v.id))).toEqual([false, true, false]);
});

test("the visual key: HMAC-SHA256 of the token with the text 'blimp visuals'; none without a token", () => {
  expect(visualKey("beef".repeat(16))).toBe(new Bun.CryptoHasher("sha256", "beef".repeat(16)).update("blimp visuals").digest("hex"));
  expect(visualKey("beef".repeat(16))).toMatch(/^[0-9a-f]{64}$/);
  expect(visualKey("a")).not.toBe(visualKey("b"));
  expect(visualKey("")).toBe("");
});

test("the page's policy names its own folder and the kit at the host asked, in both schemes; a Host that isn't one names nothing", () => {
  const key = "k".repeat(64);
  const own = `http://mac.tail.ts.net:4873/visuals/${key}/0123456789ab/ https://mac.tail.ts.net:4873/visuals/${key}/0123456789ab/`;
  const kit = `http://mac.tail.ts.net:4873/visuals/${key}/kit/ https://mac.tail.ts.net:4873/visuals/${key}/kit/`;
  expect(pageCsp("mac.tail.ts.net:4873", key, "0123456789ab")).toBe(
    `default-src 'none'; script-src 'unsafe-inline' ${own} ${kit}; style-src 'self' 'unsafe-inline'; img-src data: blob: ${own}; font-src data:; connect-src ${own} blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts`,
  );
  expect(PAGE_CSP).toBe(
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts",
  );
  for (const host of [null, "", "evil.example; script-src *", "a b", "x/y", "'self'", "a,b", "h\nx"]) expect(pageCsp(host, key, "0123456789ab")).toBe(PAGE_CSP);
});
