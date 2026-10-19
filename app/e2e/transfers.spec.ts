// Files between the computer and the server: right-click Download (a folder as .tar.gz), files
// dropped from the computer onto a tree folder (a name already there asks first), Upload…, and a
// file dropped on a terminal (uploaded to ~/.blimp/uploads, its path typed in).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { e2e, fixtureDir, frontTab, killSession, openSessionTab, screenText, startSession } from "./helpers";

const pid = process.pid;
// One session per test: each test has its own folder.
const sessions = ["down", "up", "pick", "term"].map((t) => `blimpe2e-xfer${t}-${pid}`);
const [sDown, sUp, sPick, sTerm] = sessions;
test.afterAll(() => sessions.forEach(killSession));

// Drags files in from the computer and lets go over `target`, as the OS would (HTML drag and
// drop: the browser build; the Mac app gets Tauri's drag-drop event instead).
async function dropFiles(page: Page, target: Locator, files: { name: string; text: string }[], opts: { hoverOnly?: boolean } = {}) {
  await target.evaluate(
    (el, { files, hoverOnly }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([f.text], f.name));
      const r = el.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, clientX: r.x + Math.min(20, r.width / 2), clientY: r.y + r.height / 2, dataTransfer: dt };
      el.dispatchEvent(new DragEvent("dragover", at));
      if (!hoverOnly) el.dispatchEvent(new DragEvent("drop", at));
    },
    { files, hoverOnly: !!opts.hoverOnly },
  );
}

test("right-click Download: a file comes down as it is, a folder as .tar.gz", async ({ page }) => {
  const dir = fixtureDir("xfer-down");
  mkdirSync(join(dir, "pics"), { recursive: true });
  writeFileSync(join(dir, "notes.md"), "# notes\n");
  writeFileSync(join(dir, "pics", "a.txt"), "a");
  startSession(sDown, dir);
  await openSessionTab(page, dir);
  const tree = frontTab(page).locator(".tree");

  await tree.getByText("notes.md").click({ button: "right" });
  let wait = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download" }).click();
  let d = await wait;
  expect(d.suggestedFilename()).toBe("notes.md");
  expect(readFileSync(await d.path(), "utf8")).toBe("# notes\n");
  await expect(page.locator(".transfer.done")).toContainText("notes.md");

  await tree.getByText("pics").click({ button: "right" });
  wait = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download as .tar.gz" }).click();
  d = await wait;
  expect(d.suggestedFilename()).toBe("pics.tar.gz");
  expect(execFileSync("tar", ["-tzf", await d.path()], { encoding: "utf8" })).toContain("pics/a.txt");

  // The open file's tab has Download too.
  await tree.getByText("notes.md").click();
  await frontTab(page).locator(".ftabs .tab", { hasText: "notes.md" }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Download" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("files dropped on a tree folder upload into it; a name already there asks: Keep both, Replace, Skip", async ({ page }) => {
  const dir = fixtureDir("xfer-up");
  mkdirSync(join(dir, "inbox"), { recursive: true });
  startSession(sUp, dir);
  await openSessionTab(page, dir);
  const tree = frontTab(page).locator(".tree");
  const inbox = tree.locator('.tree-row[data-kind="dir"]', { hasText: "inbox" });

  // While a file is dragged over it, the folder is lit.
  await dropFiles(page, inbox, [{ name: "x.txt", text: "x" }], { hoverOnly: true });
  await expect(inbox).toHaveClass(/drop-over/);

  await dropFiles(page, inbox, [
    { name: "one.txt", text: "first" },
    { name: "two.txt", text: "second" },
  ]);
  await expect.poll(() => existsSync(join(dir, "inbox", "two.txt"))).toBe(true);
  expect(readFileSync(join(dir, "inbox", "one.txt"), "utf8")).toBe("first");
  await expect(inbox).not.toHaveClass(/drop-over/);
  await expect(tree.getByText("two.txt")).toBeVisible();

  // Again: one question for the name that's there.
  await dropFiles(page, inbox, [{ name: "one.txt", text: "newer" }]);
  const ask = page.locator(".dialog.ask");
  await expect(ask).toContainText("one.txt is already in inbox");
  await ask.getByRole("button", { name: "Keep both" }).click();
  await expect.poll(() => existsSync(join(dir, "inbox", "one 2.txt"))).toBe(true);
  expect(readFileSync(join(dir, "inbox", "one.txt"), "utf8")).toBe("first");

  await dropFiles(page, inbox, [{ name: "one.txt", text: "replaced" }]);
  await ask.getByRole("button", { name: "Replace" }).click();
  await expect.poll(() => readFileSync(join(dir, "inbox", "one.txt"), "utf8")).toBe("replaced");

  await dropFiles(page, inbox, [{ name: "one.txt", text: "skipped" }]);
  await ask.getByRole("button", { name: "Skip" }).click();
  await page.waitForTimeout(300);
  expect(readFileSync(join(dir, "inbox", "one.txt"), "utf8")).toBe("replaced");

  // Dropped on a file: into that file's folder.
  await dropFiles(page, tree.getByText("two.txt"), [{ name: "three.txt", text: "3" }]);
  await expect.poll(() => existsSync(join(dir, "inbox", "three.txt"))).toBe(true);
});

test("Upload… in a folder's right-click menu", async ({ page }) => {
  const dir = fixtureDir("xfer-pick");
  mkdirSync(join(dir, "docs"), { recursive: true });
  startSession(sPick, dir);
  await openSessionTab(page, dir);
  await frontTab(page).locator(".tree").getByText("docs").click({ button: "right" });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Upload…" }).click();
  await (await chooser).setFiles([{ name: "picked.txt", mimeType: "text/plain", buffer: Buffer.from("picked") }]);
  await expect.poll(() => existsSync(join(dir, "docs", "picked.txt"))).toBe(true);
  expect(readFileSync(join(dir, "docs", "picked.txt"), "utf8")).toBe("picked");
});

test("a file dropped on a terminal goes to ~/.blimp/uploads under a plain name, and its path is typed in", async ({ page }) => {
  const dir = fixtureDir("xfer-term");
  startSession(sTerm, dir, ["sh", "-c", "stty -echo; exec cat"]);
  const term = await openSessionTab(page, dir);
  await dropFiles(page, frontTab(page).locator(".tsplit").first(), [{ name: "Screen Shot 1.png", text: "png!" }]);
  const want = join(e2e().fixtures, ".blimp", "uploads", "Screen-Shot-1.png");
  await expect.poll(() => existsSync(want)).toBe(true);
  expect(readFileSync(want, "utf8")).toBe("png!");
  // Typed in as a paste; Enter so cat prints it back.
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(term)).toContain(want);
});
