import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversations, firstCwd, projectFolderName, recentFolders } from "../src/folders";

// A temp CLAUDE_CONFIG_DIR with three project folders, plus the work folders they point at.
const root = realpathSync(mkdtempSync(join(tmpdir(), "blimp-folders-")));
const claude = join(root, "claude");
const web = join(root, "work", "my.web");
const api = join(root, "work", "api");
mkdirSync(web, { recursive: true });
mkdirSync(api, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const line = (o: object) => JSON.stringify(o) + "\n";
function transcript(dir: string, id: string, mtimeSec: number, lines: string) {
  const folder = join(claude, "projects", projectFolderName(dir));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.jsonl`), lines);
  utimesSync(join(folder, `${id}.jsonl`), mtimeSec, mtimeSec);
}

const summary = line({ type: "summary", summary: "x" }); // no cwd on the first line, like real transcripts
transcript(web, "11111111-1111-1111-1111-111111111111", 1000, summary + line({ type: "user", cwd: web, message: { content: "old web" } }));
transcript(web, "22222222-2222-2222-2222-222222222222", 3000, line({ type: "user", cwd: web, message: { content: "newer web" } }) + line({ type: "custom-title", customTitle: "Web v2" }));
transcript(api, "33333333-3333-3333-3333-333333333333", 2000, line({ type: "user", cwd: api, message: { content: "api work" } }));
transcript(join(root, "gone"), "44444444-4444-4444-4444-444444444444", 4000, line({ type: "user", cwd: join(root, "gone") }));

test("projectFolderName turns every non-alphanumeric char into -", () => {
  expect(projectFolderName("/Users/max/my.web_app")).toBe("-Users-max-my-web-app");
});

test("recentFolders: newest first, only folders that still exist", () => {
  expect(recentFolders(claude)).toEqual([
    { dir: web, lastUsed: 3_000_000 },
    { dir: api, lastUsed: 2_000_000 },
  ]);
});

test("conversations: the folder's transcripts, newest first, with titles", () => {
  expect(conversations(web, claude)).toEqual([
    { sessionId: "22222222-2222-2222-2222-222222222222", title: "Web v2", updatedAt: 3_000_000 },
    { sessionId: "11111111-1111-1111-1111-111111111111", title: "old web", updatedAt: 1_000_000 },
  ]);
  expect(conversations(join(root, "nothing-here"), claude)).toEqual([]);
});

test("conversations: a path through a symlink finds the real folder's transcripts", () => {
  // Like /home/u -> /Users/u: the app may hold the symlinked path, Claude names folders after the real one.
  symlinkSync(join(root, "work"), join(root, "link"));
  expect(conversations(join(root, "link", "my.web"), claude)).toEqual(conversations(web, claude));
  expect(conversations(join(root, "link", "my.web"), claude)).toHaveLength(2);
});

test("firstCwd looks only at the first lines, and copes with huge ones", () => {
  const f = join(root, "big.jsonl");
  writeFileSync(f, line({ type: "x", blob: "é".repeat(200_000) }) + line({ cwd: "/a/b" }));
  expect(firstCwd(f)).toBe("/a/b");
  writeFileSync(f, line({ type: "x" }).repeat(50) + line({ cwd: "/late" }));
  expect(firstCwd(f)).toBeUndefined();
});
