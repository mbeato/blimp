// The window layout: Home, Open Folder (with New folder), the tree's New file and New folder, the
// terminal pane's session list (Shell from the chevron, trash, Earlier), ⌘-click on a path, and ⌘K to another
// folder. Sessions blimpd starts here are named after their folder, so the folders are named
// blimpe2e-* and only those sessions are ever ended.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  e2e,
  fixtureDir,
  frontTab,
  frontTerm,
  killSession,
  killTestSessions,
  openApp,
  openSessionTab,
  projectTab,
  screenText,
  sessionRow,
  startSession,
  startSessionPty,
  zmxEnv,
} from "./helpers";

const pid = process.pid;
const pathSession = `blimpe2e-wbpath-${pid}`;
const other = `blimpe2e-wbother-${pid}`;
const listed = `blimpe2e-wblisted-${pid}`;
const treeSession = `blimpe2e-wbtree-${pid}`;
const jumpA = `blimpe2e-wbjumpa-${pid}`;
const jumpB = `blimpe2e-wbjumpb-${pid}`;

test.afterAll(async () => {
  killSession(pathSession);
  killSession(other);
  for (const n of [listed, treeSession, jumpA, jumpB]) killSession(n);
  await killTestSessions();
});

const zmxNames = () =>
  execFileSync("zmx", ["list", "--short"], { env: zmxEnv(), encoding: "utf8", timeout: 10_000 }).split("\n").filter(Boolean);

test("Home: the tree shows home, Open Folder makes a new folder and opens it, and it shows in Recent", async ({ page }) => {
  const { fixtures } = e2e();
  fixtureDir("wbhome-existing");
  await openApp(page);
  const ws = frontTab(page);
  await expect(ws.locator(".welcome-page h1")).toHaveText("blimp");
  await expect(ws.locator(".tree").getByText("wbhome-existing")).toBeVisible();
  await expect(page.locator(".ptab")).toHaveCount(1);
  await expect(projectTab(page, "Home")).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Meta+o");
  const dialog = page.locator(".dialog");
  await dialog.getByRole("tab", { name: "Browse" }).click();
  await expect(dialog.locator(".browse-path")).toHaveText("~");
  await dialog.getByRole("button", { name: "New folder" }).click();
  await dialog.getByLabel("New folder name").fill("wbhome-made");
  await dialog.getByLabel("New folder name").press("Enter");
  await expect(dialog.locator(".browse-path")).toHaveText("~/wbhome-made");
  expect(statSync(join(fixtures, "wbhome-made")).isDirectory()).toBe(true);
  await dialog.getByRole("button", { name: "Open", exact: true }).click();

  // A new tab, in front.
  await expect(projectTab(page, "wbhome-made")).toHaveAttribute("aria-selected", "true");
  await expect(projectTab(page, "wbhome-made")).toHaveAttribute("title", "~/wbhome-made");
  await expect(ws.locator(".pane-head .pane-title").first()).toHaveText("wbhome-made");
  await expect(ws.locator(".welcome-page")).toHaveCount(0);
  // An empty folder: the terminal pane offers to start something.
  await expect(ws.locator(".tpane-terms").getByRole("button", { name: "New shell" })).toBeVisible();

  await projectTab(page, "Home").click();
  await expect(ws.locator(".welcome-recent")).toContainText("wbhome-made");
  // Opening it again brings its tab forward rather than a second one.
  await ws.locator(".welcome-recent").getByRole("button", { name: "wbhome-made" }).click();
  await expect(projectTab(page, "wbhome-made")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".ptab")).toHaveCount(2);
});

test("the tree makes new files and folders where you last clicked", async ({ page }) => {
  const dir = fixtureDir("wbtree");
  mkdirSync(join(dir, "sub"), { recursive: true });
  startSession(treeSession, dir);
  await openSessionTab(page, dir);
  const ws = frontTab(page);
  const tree = ws.locator(".tree");

  // A folder clicked: new things go in it.
  await tree.getByText("sub").click();
  await ws.getByRole("button", { name: "New folder" }).click();
  await ws.getByLabel("New folder name").fill("inner");
  await ws.getByLabel("New folder name").press("Enter");
  await expect(tree.getByText("inner")).toBeVisible();
  expect(statSync(join(dir, "sub/inner")).isDirectory()).toBe(true);

  // New file goes in the new folder (it became the target) and opens in a tab.
  await ws.getByRole("button", { name: "New file" }).click();
  await ws.getByLabel("New file name").fill("hello.txt");
  await ws.getByLabel("New file name").press("Enter");
  await expect(ws.locator(".ftabs .tab.active")).toHaveText(/hello\.txt/);
  expect(existsSync(join(dir, "sub/inner/hello.txt"))).toBe(true);

  // Taken names and slashes are refused, inline.
  await ws.getByRole("button", { name: "New file" }).click();
  await ws.getByLabel("New file name").fill("hello.txt");
  await ws.getByLabel("New file name").press("Enter");
  await expect(ws.locator(".tree-create-error")).toHaveText("hello.txt already exists.");
  await ws.getByLabel("New file name").fill("a/b");
  await ws.getByLabel("New file name").press("Enter");
  await expect(ws.locator(".tree-create-error")).toContainText("can't contain /");
  await ws.getByLabel("New file name").press("Escape");
  await expect(ws.locator(".tree-create")).toHaveCount(0);
  expect(readdirSync(join(dir, "sub/inner"))).toEqual(["hello.txt"]);
});

test("the session list: only this folder's sessions; New shell; trash ends a session after asking; Earlier", async ({ page }) => {
  const dir = fixtureDir(`blimpe2e-wblist-${pid}`);
  const sub = fixtureDir(`blimpe2e-wblist-${pid}/sub`);
  startSession(listed, dir);
  startSession(other, sub);
  // An earlier conversation in this folder, as Claude keeps it.
  const projects = join(process.env.BLIMP_E2E_CLAUDE!, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(projects, { recursive: true });
  writeFileSync(
    join(projects, "0d3e5c1a-1111-4222-8333-944455556666.jsonl"),
    JSON.stringify({ type: "user", cwd: dir, message: { role: "user", content: "an earlier chat about tests" } }) + "\n",
  );

  await openSessionTab(page, dir);
  await expect(sessionRow(page, listed)).toBeVisible();
  // Started in a subfolder: not listed here, as `claude --resume` wouldn't.
  await expect(sessionRow(page, other)).toHaveCount(0);
  // Earlier is folded at first, and unfolds with a click (kept over a reload).
  const fold = frontTab(page).locator(".slist-fold");
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(fold).toContainText("1");
  await expect(page.locator(".srow-main.earlier")).toHaveCount(0);
  await fold.click();
  await expect(page.locator(".srow-main.earlier")).toContainText("an earlier chat about tests");
  // + is New Claude session itself; the chevron beside it has the other kinds.
  await expect(frontTab(page).getByRole("button", { name: "New Claude session", exact: true })).toBeVisible();

  // Shell from the chevron's kinds: listed with its name, shown in the terminal.
  const before = zmxNames();
  await page.getByRole("button", { name: "More kinds of session" }).click();
  await page.getByRole("menuitem", { name: "Shell", exact: true }).click();
  await expect.poll(() => zmxNames().filter((n) => !before.includes(n)).length).toBe(1);
  const shell = zmxNames().find((n) => !before.includes(n))!;
  expect(shell.startsWith(`blimpe2e-wblist-${pid}-`)).toBe(true);
  const row = sessionRow(page, shell);
  await expect(row).toHaveClass(/selected/);
  await expect(row.locator(".srow-title")).toHaveText(shell);
  const term = frontTerm(page);
  await term.locator(".xterm").click();
  await page.keyboard.type("echo shell-$((40+2))\n");
  await expect.poll(() => term.locator(".xterm-rows").innerText()).toContain("shell-42");

  // Trash on a shell asks first; End ends it on the server.
  await row.hover();
  await row.getByRole("button", { name: `End ${shell}` }).click();
  await row.getByRole("button", { name: "End", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(zmxNames()).not.toContain(shell);
  // The pane moves on to the folder's other session.
  await expect(sessionRow(page, listed)).toHaveClass(/selected/);
  killSession(other);
});

test("⌘-click on a path in the terminal opens the file at that line", async ({ page }) => {
  const dir = fixtureDir("wbpath");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/app.ts"), Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n") + "\n");
  await startSessionPty(pathSession, dir, ["sh", "-c", "printf 'Update(src/app.ts:12) and missing/nope.ts:3\\n'; exec cat"]);
  const term = await openSessionTab(page, dir);
  const text = term.locator(".xterm-rows span", { hasText: "src/app.ts" }).first();
  await expect(text).toBeVisible();
  const screen = term.locator(".xterm-screen");
  // The middle of the needle's text on screen, relative to the screen layer (which takes the mouse).
  const at = async (needle: string) => {
    const box = await term.evaluate((el, needle) => {
      const walker = document.createTreeWalker(el.querySelector(".xterm-rows")!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(needle);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + needle.length);
        const b = r.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      return null;
    }, needle);
    const sb = (await screen.boundingBox())!;
    return { x: box!.x - sb.x, y: box!.y - sb.y };
  };

  // A file that exists is a link (pointer cursor); one that doesn't isn't.
  const missing = await at("missing/nope.ts");
  await screen.hover({ position: missing });
  await page.waitForTimeout(300);
  await expect(term.locator(".xterm-cursor-pointer")).toHaveCount(0);
  const position = await at("src/app.ts");
  await screen.hover({ position });
  await expect(term.locator(".xterm-cursor-pointer")).toHaveCount(1);
  // A plain click doesn't open it.
  await screen.click({ position });
  await page.waitForTimeout(300);
  await expect(page.locator(".ftabs .tab")).toHaveCount(0);

  await screen.click({ position, modifiers: ["ControlOrMeta"] });
  await expect(page.locator(".ftabs .tab.active")).toHaveText(/app\.ts/);
  await expect(page.locator(".monaco-editor .active-line-number")).toHaveText("12");
});

test("⌘K to a session in another folder opens it in a tab, and back to the first tab's session", async ({ page }) => {
  const a = fixtureDir("wbjump-a");
  const b = fixtureDir("wbjump-b");
  startSession(jumpA, a);
  startSession(jumpB, b);
  const termA = await openSessionTab(page, a);
  await termA.locator(".xterm").click();
  await page.keyboard.type("kept-in-a\n");
  await expect.poll(() => screenText(termA)).toContain("kept-in-a");

  const jump = async (name: string) => {
    await page.keyboard.press("Meta+k");
    await page.getByPlaceholder("Jump to a session").fill(name);
    await page.keyboard.press("Enter");
  };
  await jump(jumpB);
  await expect(projectTab(page, "wbjump-b")).toHaveAttribute("aria-selected", "true");
  await expect(sessionRow(page, jumpB)).toHaveClass(/selected/);
  const layout = JSON.parse(new URL(page.url()).searchParams.get("layout")!);
  expect(layout.tabs.map((t: { dir: string | null }) => t.dir)).toEqual([null, a, b]);
  expect(layout.tabs[2].panes).toEqual([jumpB]);

  // Back to a: its tab, not a new one, with its terminal as it was.
  await jump(jumpA);
  await expect(page.locator(".ptab")).toHaveCount(3);
  await expect(projectTab(page, "wbjump-a")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => screenText(frontTerm(page))).toContain("kept-in-a");
});
