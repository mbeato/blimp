// ⌘C on a selection that spans wrapped rows: one line for what was one line (lib/copy.ts).
import { expect, test, type Page } from "@playwright/test";
import { fixtureDir, frontTerm, killSession, openSessionTab, screenText, startSessionPty } from "./helpers";

const pid = process.pid;
const sessions = ["redraw", "claude", "link"].map((t) => `blimpe2e-copy${t}-${pid}`);
const [sRedraw, sClaude, sLink] = sessions;
test.afterAll(() => sessions.forEach(killSession));

// Drags from the first row's start to the end of row `last`, then ⌘C, and reads the clipboard.
async function copyRows(page: Page, last: number) {
  const rows = frontTerm(page).locator(".xterm-rows > div");
  const a = (await rows.nth(0).boundingBox())!;
  const b = (await rows.nth(last).boundingBox())!;
  await page.mouse.move(a.x + 1, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Meta+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe("");
  return page.evaluate(() => navigator.clipboard.readText());
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("a long line the terminal wrapped copies as one line, also after a reattach redrew it; real newlines stay", async ({ page }) => {
  const dir = fixtureDir("copy-redraw");
  const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
  // On Enter, at the attached terminal's width: a line longer than it, and two real lines.
  await startSessionPty(sRedraw, dir, ["sh", "-c", `stty -echo; read x; clear; printf '%s\\n' '${words}'; printf 'AAA one two\\n  three four\\n'; exec cat`]);
  await openSessionTab(page, dir);
  await frontTerm(page).click();
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(frontTerm(page))).toContain("three four");
  const live = await copyRows(page, 6);
  expect(live).toContain(words);
  expect(live).toContain("AAA one two\n  three four");
  // Reattached: zmx redraws the screen row by row, and xterm no longer knows the long line wrapped.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.reload();
  await expect.poll(() => screenText(frontTerm(page))).toContain("three four");
  const redrawn = await copyRows(page, 6);
  expect(redrawn).toContain(words);
  expect(redrawn).toContain("AAA one two\n  three four");
});

test("text a program wrapped to the width itself, Claude Code's way, copies as one line", async ({ page }) => {
  const dir = fixtureDir("copy-claude");
  const para = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  // On Enter: the paragraph wrapped to the terminal's width the way Claude Code draws a reply.
  const script = `stty -echo; read x; cols=$(stty size | cut -d' ' -f2); clear; printf '%s' '${para}' | fold -s -w $((cols - 2)) | sed '1s/^/* /; 2,$s/^/  /'; echo; echo END; exec cat`;
  await startSessionPty(sClaude, dir, ["sh", "-c", script]);
  await openSessionTab(page, dir);
  await frontTerm(page).click();
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(frontTerm(page))).toContain("END");
  const lines = (await screenText(frontTerm(page))).split("\n").filter((l) => l.trim());
  const endRow = lines.findIndex((l) => l.includes("END"));
  expect(endRow).toBeGreaterThan(1); // it did wrap
  const text = await copyRows(page, endRow - 1);
  expect(text.trim()).toBe(`* ${para}`);
});

test("a link Claude Code broke at the edge copies whole, by ⌘C and by the Edit menu's Copy", async ({ page }) => {
  const dir = fixtureDir("copy-link");
  const url = `https://example.com/${Array.from({ length: 30 }, (_, i) => `seg${i}`).join("/")}?q=1`;
  // On Enter: the link cut at the edge, its rows indented, the way Claude Code draws a reply.
  const script = `stty -echo; read x; cols=$(stty size | cut -d' ' -f2); clear; printf '%s' '${url}' | fold -w $((cols - 2)) | sed '1s/^/* /; 2,$s/^/  /'; echo; echo END; exec cat`;
  await startSessionPty(sLink, dir, ["sh", "-c", script]);
  await openSessionTab(page, dir);
  await frontTerm(page).click();
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(frontTerm(page))).toContain("END");
  const lines = (await screenText(frontTerm(page))).split("\n").filter((l) => l.trim());
  const endRow = lines.findIndex((l) => l.includes("END"));
  expect(endRow).toBeGreaterThan(1); // it did wrap
  expect((await copyRows(page, endRow - 1)).trim()).toBe(`* ${url}`);
  // The Edit menu's Copy: the copy event, with the selection still there.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.evaluate(() => document.execCommand("copy"));
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`* ${url}`);
});
