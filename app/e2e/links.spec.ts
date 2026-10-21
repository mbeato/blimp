// Links: a terminal link opens only on ⌘-click (Ctrl-click off the Mac), as in the VS Code
// terminal; a Markdown web link opens on a plain click. Both go to the system browser (here the
// browser build's window.open, recorded), http and https only, and nothing navigates the app.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fixtureDir, frontTab, killSession, openSessionTab, startSession, startSessionPty } from "./helpers";

const term = `blimpe2e-linkterm-${process.pid}`;
const md = `blimpe2e-linkmd-${process.pid}`;
const osc = `blimpe2e-linkosc-${process.pid}`;
const menuSess = `blimpe2e-linkmenu-${process.pid}`;

test.afterAll(() => {
  killSession(term);
  killSession(md);
  killSession(osc);
  killSession(menuSess);
});

async function recordOpens(page: Page) {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as any).__opened = opened;
    window.open = (url?: string | URL) => (opened.push(String(url)), null);
  });
}
const opened = (page: Page) => page.evaluate(() => (window as any).__opened as string[]);

const URL_TEXT = "https://example.com/blimp-e2e";

test("a terminal link opens on ⌘-click (Ctrl-click off the Mac), not on a plain click", async ({ page }) => {
  const dir = fixtureDir("linkterm");
  await startSessionPty(term, dir, ["sh", "-c", `printf '${URL_TEXT}\\n'; exec cat`]);
  await recordOpens(page);
  const t = await openSessionTab(page, dir);
  const text = t.locator(".xterm-rows span", { hasText: URL_TEXT }).first();
  await expect(text).toBeVisible();
  // xterm's screen layer takes the mouse, so click it over the middle of the link's text.
  const screen = t.locator(".xterm-screen");
  const [tb, sb] = [(await text.boundingBox())!, (await screen.boundingBox())!];
  const position = { x: tb.x - sb.x + tb.width / 2, y: tb.y - sb.y + tb.height / 2 };

  // The link is found on hover (the pointer cursor), then a plain click does nothing.
  await screen.hover({ position });
  await expect(t.locator(".xterm-cursor-pointer")).toHaveCount(1);
  await screen.click({ position });
  await page.waitForTimeout(300);
  expect(await opened(page)).toEqual([]);

  // ControlOrMeta is ⌘ on a Mac and Ctrl elsewhere, matching the app's check.
  await screen.click({ position, modifiers: ["ControlOrMeta"] });
  await expect.poll(() => opened(page)).toEqual([URL_TEXT]);
});

test("a right-click on a terminal link offers the server's browser, the system browser and Copy Link", async ({ page }) => {
  const dir = fixtureDir("linkmenu");
  await startSessionPty(menuSess, dir, ["sh", "-c", `printf '${URL_TEXT}\\n'; exec cat`]);
  await recordOpens(page);
  const t = await openSessionTab(page, dir);
  const text = t.locator(".xterm-rows span", { hasText: URL_TEXT }).first();
  await expect(text).toBeVisible();
  const screen = t.locator(".xterm-screen");
  const [tb, sb] = [(await text.boundingBox())!, (await screen.boundingBox())!];
  const position = { x: tb.x - sb.x + tb.width / 2, y: tb.y - sb.y + tb.height / 2 };
  const menu = page.locator(".context-menu");

  // Off the link: no menu of ours.
  await screen.click({ position: { x: 5, y: sb.height - 5 }, button: "right" });
  await expect(menu).toHaveCount(0);

  await screen.hover({ position });
  await expect(t.locator(".xterm-cursor-pointer")).toHaveCount(1);
  await screen.click({ position, button: "right" });
  await menu.getByRole("menuitem", { name: "Open in Default Browser" }).click();
  await expect.poll(() => opened(page)).toEqual([URL_TEXT]);
  await expect(menu).toHaveCount(0);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await screen.hover({ position });
  await screen.click({ position, button: "right" });
  await menu.getByRole("menuitem", { name: "Copy Link" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(URL_TEXT);

  // A tab of the server's Chrome, in this folder, in front.
  await screen.hover({ position });
  await screen.click({ position, button: "right" });
  await menu.getByRole("menuitem", { name: "Open in Blimp Browser" }).click();
  await expect(frontTab(page).locator(".viewer:not([hidden])").getByLabel("Address")).toHaveValue(URL_TEXT, { timeout: 10_000 });
  expect(await opened(page)).toEqual([URL_TEXT]);
});

test("an OSC 8 terminal link (hidden URL behind any text) follows the same rule", async ({ page }) => {
  const dir = fixtureDir("linkosc");
  await startSessionPty(osc, dir, ["sh", "-c", "read x; printf '\\033]8;;https://example.com/osc8\\033\\\\click here\\033]8;;\\033\\\\\\n'; exec cat"]);
  await recordOpens(page);
  let dialogs = 0;
  page.on("dialog", (d) => (dialogs++, void d.dismiss()));
  const t = await openSessionTab(page, dir);
  const url = page.url();
  // Printed after attaching (Enter), since zmx's screen replay on attach drops OSC 8 links.
  await t.locator(".xterm").click();
  await page.keyboard.press("Enter");
  const text = t.locator(".xterm-rows span", { hasText: "click here" }).first();
  await expect(text).toBeVisible();
  const screen = t.locator(".xterm-screen");
  const [tb, sb] = [(await text.boundingBox())!, (await screen.boundingBox())!];
  const position = { x: tb.x - sb.x + tb.width / 2, y: tb.y - sb.y + tb.height / 2 };

  // A plain click: no confirm(), nothing opened, the app stays put.
  await screen.hover({ position });
  await expect(t.locator(".xterm-cursor-pointer")).toHaveCount(1);
  await screen.click({ position });
  await page.waitForTimeout(300);
  expect(dialogs).toBe(0);
  expect(await opened(page)).toEqual([]);
  expect(page.url()).toBe(url);

  await screen.click({ position, modifiers: ["ControlOrMeta"] });
  await expect.poll(() => opened(page)).toEqual(["https://example.com/osc8"]);
  expect(dialogs).toBe(0);
});

const MD = `# Links

[web link](https://example.com/from-md)

[other file](other.md)

[js link](javascript:window.__pwned='js')

<a href="file:///etc/passwd">file link</a>

<a href="data:text/html,hi">data link</a>
`;

test("Markdown: a web link opens in the browser, a relative link opens the file, other schemes do nothing", async ({ page }) => {
  const dir = fixtureDir("linkmd");
  writeFileSync(join(dir, "links.md"), MD);
  writeFileSync(join(dir, "other.md"), "# Other\n");
  startSession(md, dir);
  await recordOpens(page);
  await openSessionTab(page, dir);
  const url = page.url();
  const ws = page.locator(".wb:not([hidden])");
  await ws.locator(".tree").getByText("links.md").click();
  const view = ws.locator(".md-view");
  await expect(view.locator("h1")).toHaveText("Links");

  for (const text of ["js link", "file link", "data link"]) await view.getByText(text).click();
  await page.waitForTimeout(300);
  expect(await opened(page)).toEqual([]);
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();

  await view.getByText("web link").click();
  await expect.poll(() => opened(page)).toEqual(["https://example.com/from-md"]);
  expect(page.url()).toBe(url);

  await view.getByText("other file").click();
  await expect(ws.locator(".ftabs .tab.active")).toHaveText(/other\.md/);
  await expect(ws.locator(".md-view h1")).toHaveText("Other");
  expect(await opened(page)).toEqual(["https://example.com/from-md"]);
});
