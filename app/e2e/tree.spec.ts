// The files pane's right-click and keys, as VS Code's: Copy Path, Copy Relative Path, Send Path to
// Session, a row dragged onto a terminal (its path typed in), Rename (in the row), Delete (after
// asking), a row dragged onto a folder (moved, after asking), New File… in a folder, and a file
// tab's own menu with Reveal in Files.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { fixtureDir, frontTab, killSession, openSessionTab, screenText, startSession } from "./helpers";

const pid = process.pid;
const sessions = ["copy", "send", "drag", "rename", "delete", "move", "tab"].map((t) => `blimpe2e-tree${t}-${pid}`);
const [sCopy, sSend, sDrag, sRename, sDelete, sMove, sTab] = sessions;
test.afterAll(() => sessions.forEach(killSession));

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

// What cat prints back shows what was typed; no echo, so it shows once.
const CAT = ["sh", "-c", "stty -echo; exec cat"];

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
// A tree row by its name (anywhere in the tree).
const row = (page: Page, name: string) => frontTab(page).locator(`.tree .tree-row[data-path$="/${name}"]`);

async function menu(page: Page, target: Locator, item: string) {
  await target.click({ button: "right" });
  await page.getByRole("menuitem", { name: item }).click();
}

// A pointer drag from one element to another, in steps, as a hand would.
async function drag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("Copy Path and Copy Relative Path, from the right-click menu and from ⌥⌘C and ⌥⇧⌘C", async ({ page }) => {
  const dir = fixtureDir("tree-copy");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "a");
  startSession(sCopy, dir);
  await openSessionTab(page, dir);
  await row(page, "src").click();

  await menu(page, row(page, "a.ts"), "Copy Path");
  await expect.poll(() => clipboard(page)).toBe(join(dir, "src", "a.ts"));
  await menu(page, row(page, "a.ts"), "Copy Relative Path");
  await expect.poll(() => clipboard(page)).toBe("src/a.ts");
  // A folder too, and the shortcuts shown beside them.
  await row(page, "src").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy Path" })).toContainText("⌥⌘C");
  await page.getByRole("menuitem", { name: "Copy Relative Path" }).click();
  await expect.poll(() => clipboard(page)).toBe("src");

  // The keys, on the focused row.
  await row(page, "a.ts").focus();
  await page.keyboard.press("Alt+Meta+KeyC");
  await expect.poll(() => clipboard(page)).toBe(join(dir, "src", "a.ts"));
  await page.keyboard.press("Alt+Shift+Meta+KeyC");
  await expect.poll(() => clipboard(page)).toBe("src/a.ts");
});

test("Send Path to Session types the path into the session on screen, quoted when it has a space, with no Enter", async ({ page }) => {
  const dir = fixtureDir("tree-send");
  writeFileSync(join(dir, "plain.txt"), "p");
  writeFileSync(join(dir, "my notes.md"), "n");
  startSession(sSend, dir, CAT);
  const term = await openSessionTab(page, dir);

  await menu(page, row(page, "plain.txt"), "Send Path to Session");
  await menu(page, row(page, "my notes.md"), "Send Path to Session");
  // Nothing ran yet: cat prints a line only once Enter is pressed.
  await page.waitForTimeout(300);
  expect(await screenText(term)).not.toContain("plain.txt");
  await term.click();
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(term)).toContain(`${join(dir, "plain.txt")} '${join(dir, "my notes.md")}'`);

  // With the terminal hidden, no session is on screen: the item is there but off.
  await page.keyboard.press("Meta+j");
  await row(page, "plain.txt").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Send Path to Session" })).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("a file or folder dragged from the tree onto a terminal types its path there", async ({ page }) => {
  const dir = fixtureDir("tree-drag");
  mkdirSync(join(dir, "pics"), { recursive: true });
  writeFileSync(join(dir, "shot.png"), "png");
  startSession(sDrag, dir, CAT);
  const term = await openSessionTab(page, dir);
  const split = frontTab(page).locator(".tsplit").first();

  // While it's over the terminal, the terminal is lit.
  const a = (await row(page, "shot.png").boundingBox())!;
  const b = (await split.boundingBox())!;
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 8 });
  await expect(split).toHaveClass(/drop-over/);
  await expect(page.locator(".drag-ghost")).toHaveText("shot.png");
  await page.mouse.up();
  await expect(split).not.toHaveClass(/drop-over/);

  await drag(page, row(page, "pics"), split);
  await term.click();
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(term)).toContain(`${join(dir, "shot.png")} ${join(dir, "pics")}`);
  // The drag wasn't a click: the folder didn't open and no file opened.
  await expect(row(page, "pics")).toHaveAttribute("aria-expanded", "false");
  await expect(frontTab(page).locator(".ftabs .tab")).toHaveCount(0);
});

test("Rename… and Enter rename in the row, a file's name selected without its extension; an open tab follows", async ({ page }) => {
  const dir = fixtureDir("tree-rename");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "notes.md"), "# notes\n");
  writeFileSync(join(dir, "taken.md"), "taken");
  writeFileSync(join(dir, "docs", "inner.txt"), "inner");
  startSession(sRename, dir);
  await openSessionTab(page, dir);
  const ws = frontTab(page);

  await row(page, "notes.md").click();
  await expect(ws.locator(".ftabs .tab.active")).toHaveText(/notes\.md/);
  await menu(page, row(page, "notes.md"), "Rename…");
  const box = ws.getByLabel("New name for notes.md");
  await expect(box).toBeFocused();
  expect(await box.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe("notes");
  // A name that's there is refused in the row.
  await page.keyboard.type("taken");
  await page.keyboard.press("Enter");
  await expect(ws.locator(".tree-create-error")).toHaveText("taken.md is already there.");
  await box.fill("journal.md");
  await box.press("Enter");
  await expect(row(page, "journal.md")).toBeVisible();
  expect(existsSync(join(dir, "notes.md"))).toBe(false);
  expect(readFileSync(join(dir, "journal.md"), "utf8")).toBe("# notes\n");
  await expect(ws.locator(".ftabs .tab.active")).toHaveText(/journal\.md/);
  await expect(row(page, "journal.md")).toBeFocused();

  // Enter on a focused folder renames it too; Esc leaves it as it was.
  await row(page, "docs").focus();
  await page.keyboard.press("Enter");
  await expect(ws.getByLabel("New name for docs")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row(page, "docs")).toBeFocused();
  await page.keyboard.press("F2");
  await ws.getByLabel("New name for docs").fill("papers");
  await page.keyboard.press("Enter");
  await expect(row(page, "papers")).toBeVisible();
  expect(readFileSync(join(dir, "papers", "inner.txt"), "utf8")).toBe("inner");
});

test("Delete asks first, naming it; a folder goes with everything in it, by ⌘⌫ too; an open tab closes", async ({ page }) => {
  const dir = fixtureDir("tree-delete");
  mkdirSync(join(dir, "old", "deep"), { recursive: true });
  writeFileSync(join(dir, "old", "deep", "x.txt"), "x");
  writeFileSync(join(dir, "gone.txt"), "bye");
  startSession(sDelete, dir);
  await openSessionTab(page, dir);
  const ws = frontTab(page);
  await row(page, "gone.txt").click();
  await expect(ws.locator(".ftabs .tab")).toHaveCount(1);

  await menu(page, row(page, "gone.txt"), "Delete");
  const ask = page.locator(".dialog.ask");
  await expect(ask).toContainText("Delete gone.txt from the server? You can't undo this.");
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(existsSync(join(dir, "gone.txt"))).toBe(true);

  await menu(page, row(page, "gone.txt"), "Delete");
  await ask.getByRole("button", { name: "Delete" }).click();
  await expect(row(page, "gone.txt")).toHaveCount(0);
  expect(existsSync(join(dir, "gone.txt"))).toBe(false);
  await expect(ws.locator(".ftabs .tab")).toHaveCount(0);

  await row(page, "old").focus();
  await page.keyboard.press("Meta+Backspace");
  await expect(ask).toContainText("Delete the folder old and everything in it from the server?");
  await page.keyboard.press("Enter");
  await expect(row(page, "old")).toHaveCount(0);
  expect(existsSync(join(dir, "old"))).toBe(false);
});

test("a row dragged onto a folder moves there after asking; never a folder into itself; New File… in a folder", async ({ page }) => {
  const dir = fixtureDir("tree-move");
  mkdirSync(join(dir, "inbox"), { recursive: true });
  mkdirSync(join(dir, "archive"), { recursive: true });
  writeFileSync(join(dir, "todo.md"), "todo");
  startSession(sMove, dir);
  await openSessionTab(page, dir);
  const ws = frontTab(page);
  await row(page, "todo.md").click();

  await drag(page, row(page, "todo.md"), row(page, "archive"));
  const ask = page.locator(".dialog.ask");
  await expect(ask).toContainText("Move todo.md into archive?");
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect(existsSync(join(dir, "todo.md"))).toBe(true);

  await drag(page, row(page, "todo.md"), row(page, "archive"));
  await ask.getByRole("button", { name: "Move" }).click();
  await expect.poll(() => existsSync(join(dir, "archive", "todo.md"))).toBe(true);
  expect(existsSync(join(dir, "todo.md"))).toBe(false);
  // The folder opens to show it, and its open tab follows.
  await expect(row(page, "todo.md")).toBeVisible();
  await expect(ws.locator(".ftabs .tab.active")).toHaveAttribute("title", /archive\/todo\.md$/);

  // A folder onto itself: nothing lit, nothing asked.
  await drag(page, row(page, "inbox"), row(page, "inbox"));
  await expect(ask).toHaveCount(0);
  // A folder into another.
  await drag(page, row(page, "inbox"), row(page, "archive"));
  await ask.getByRole("button", { name: "Move" }).click();
  await expect.poll(() => existsSync(join(dir, "archive", "inbox"))).toBe(true);

  // New File… in a folder's menu makes it there.
  await menu(page, row(page, "archive"), "New File…");
  await ws.getByLabel("New file name").fill("made.txt");
  await ws.getByLabel("New file name").press("Enter");
  await expect.poll(() => existsSync(join(dir, "archive", "made.txt"))).toBe(true);
});

test("a file tab's right-click: Copy Path, Copy Relative Path, Send Path to Session, Reveal in Files", async ({ page }) => {
  const dir = fixtureDir("tree-tab");
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "a", "b", "deep.ts"), "deep");
  startSession(sTab, dir, CAT);
  const term = await openSessionTab(page, dir);
  const ws = frontTab(page);
  await row(page, "a").click();
  await row(page, "b").click();
  await row(page, "deep.ts").click();
  const tab = ws.locator(".ftabs .tab", { hasText: "deep.ts" });

  await menu(page, tab, "Copy Path");
  await expect.poll(() => clipboard(page)).toBe(join(dir, "a", "b", "deep.ts"));
  await menu(page, tab, "Copy Relative Path");
  await expect.poll(() => clipboard(page)).toBe("a/b/deep.ts");
  await menu(page, tab, "Send Path to Session");
  await term.click();
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(term)).toContain(join(dir, "a", "b", "deep.ts"));

  // Collapsed and the files hidden: Reveal in Files shows them, opens the folders, selects the file.
  await ws.getByRole("button", { name: "Collapse folders" }).click();
  await expect(row(page, "deep.ts")).toHaveCount(0);
  await page.keyboard.press("Meta+b");
  await expect(ws.locator(".wb-tree")).toBeHidden();
  await menu(page, tab, "Reveal in Files");
  await expect(row(page, "deep.ts")).toBeFocused();
  await expect(row(page, "deep.ts")).toHaveClass(/selected/);
});
