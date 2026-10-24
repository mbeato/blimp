import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversations, firstCwd, projectFolderName, recentFolders, resumedKind, tempRoots } from "../src/folders";

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
  // These folders are in the system's temporary folder, which recentFolders leaves out by default.
  expect(recentFolders(claude, [])).toEqual([
    { dir: web, lastUsed: 3_000_000 },
    { dir: api, lastUsed: 2_000_000 },
  ]);
});

test("recentFolders: none in or under a temporary folder", () => {
  expect(recentFolders(claude, [api])).toEqual([{ dir: web, lastUsed: 3_000_000 }]);
  expect(recentFolders(claude, [join(root, "work")])).toEqual([]);
  // A folder whose name only starts the same isn't under it.
  expect(recentFolders(claude, [join(root, "work", "ap")]).map((f) => f.dir)).toEqual([web, api]);
  expect(recentFolders(claude).map((f) => f.dir)).toEqual([]);
  expect(tempRoots()).toContain("/tmp");
});

test("recentFolders: none you hid, left out before the list is cut to 30", () => {
  expect(recentFolders(claude, [], new Set([web]))).toEqual([{ dir: api, lastUsed: 2_000_000 }]);
});

test("conversations: the folder's transcripts, newest first, with titles", () => {
  expect(conversations(web, claude)).toEqual([
    { sessionId: "22222222-2222-2222-2222-222222222222", title: "Web v2", updatedAt: 3_000_000, unread: false },
    { sessionId: "11111111-1111-1111-1111-111111111111", title: "old web", updatedAt: 1_000_000, unread: false },
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

test("resumedKind: a conversation resumes in the kind it started on", () => {
  const said = (model: string, extra = {}) => line({ type: "assistant", ...extra, message: { role: "assistant", model, content: [{ type: "text", text: "hi" }] } });
  const glm = "55555555-5555-5555-5555-555555555555";
  transcript(api, glm, 5000, line({ type: "user", cwd: api, message: { content: "on glm" } }) + said("GLM-5.3-Flash", { isSidechain: true }) + said("GLM-5.3") + line({ type: "system" }));
  expect(resumedKind(api, glm, claude)).toBe("claude-glm");
  // A model blimp's GLM kind was set to (kinds.json glm.model) counts too
  const custom = "66666666-6666-6666-6666-666666666666";
  transcript(api, custom, 5000, said("my-zai-model"));
  expect(resumedKind(api, custom, claude, { model: "my-zai-model" })).toBe("claude-glm");
  // Started on GLM, then resumed in Claude Code by mistake: still GLM
  const mixed = "99999999-9999-9999-9999-999999999999";
  transcript(api, mixed, 5000, said("GLM-5.3") + said("claude-opus-5-5"));
  expect(resumedKind(api, mixed, claude)).toBe("claude-glm");
  // No reply yet: the first main-thread request says which model
  const asked = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  transcript(api, asked, 5000, line({ type: "api-request", querySource: "sdk", params: { model: "claude-haiku-4-5" } }) + line({ type: "api-request", querySource: "repl_main_thread", params: { model: "GLM-5.3" } }));
  expect(resumedKind(api, asked, claude)).toBe("claude-glm");
  // Claude's own models (a side task on GLM-Flash doesn't count), and anything unknown: Claude Code, as before
  const opus = "77777777-7777-7777-7777-777777777777";
  transcript(api, opus, 5000, said("GLM-5.3-Flash", { isSidechain: true }) + said("claude-opus-5-5") + said("GLM-5.3"));
  expect(resumedKind(api, opus, claude)).toBe("claude");
  expect(resumedKind(api, "33333333-3333-3333-3333-333333333333", claude)).toBe("claude");
  expect(resumedKind(api, "88888888-8888-8888-8888-888888888888", claude)).toBe("claude");
});
