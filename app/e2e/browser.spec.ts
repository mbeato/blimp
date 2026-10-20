// Browser tabs next to the file tabs: tabs of the server's Chrome, shown live. The page is drawn
// in a canvas, so it's checked through what blimpd knows of it (the tab's title, over GET
// /browser/tabs and the tab strip); clicks and typing go to it as a person's would. Send to
// session pastes the tab's title and address into a session.

import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { cspViolations, e2e, fixtureDir, frontTab, killSession, openSessionTab, screenText, startSession } from "./helpers";

const sess = `blimpe2e-browser-${process.pid}`;
let server: Server;
let port = 0;
// A button at 10,10 (100x40) that retitles the page, and a form below it that puts what's typed in
// the title.
const PAGE = `<!doctype html><title>Form page</title>
<style>body{margin:0} button{position:absolute;left:10px;top:10px;width:100px;height:40px} form{position:absolute;left:10px;top:80px} input{width:200px;height:30px}</style>
<button onclick="document.title='clicked'">b</button>
<form onsubmit="event.preventDefault();document.title='sent:'+this.q.value"><input name="q"></form>`;

test.beforeAll(async () => {
  server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
test.afterAll(() => {
  server.close();
  killSession(sess);
});

test("a browser tab is the server's Chrome, live: clicks and typing reach the page; Send to session; closed on the server", async ({ page }) => {
  const dir = fixtureDir("browser");
  startSession(sess, dir, ["sh", "-c", "stty -echo; exec cat"]);
  const term = await openSessionTab(page, dir);
  const { base, token } = e2e();
  const tabsOnServer = async () => (await (await fetch(`${base}/browser/tabs`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { id: string; url: string; title: string; folder: string }[];

  await page.locator(".layout-toggles").getByRole("button", { name: "New browser tab" }).click();
  const tab = frontTab(page).locator(".ftabs .tab.active");
  await expect(tab).toBeVisible({ timeout: 10_000 });
  const viewer = frontTab(page).locator(".viewer:not([hidden])");
  const address = viewer.getByLabel("Address");
  await expect(address).toBeFocused();
  // On the server, in this folder.
  await expect.poll(async () => (await tabsOnServer()).filter((t) => t.folder === dir).length).toBe(1);

  await address.fill(`127.0.0.1:${port}/form`);
  await address.press("Enter");
  await expect(tab).toHaveText(/Form page/, { timeout: 10_000 });
  await expect(address).toHaveValue(`http://127.0.0.1:${port}/form`);
  const canvas = viewer.locator(".page-live canvas");
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);

  // A click on the page's button.
  await canvas.click({ position: { x: 50, y: 30 } });
  await expect(tab).toHaveText(/clicked/, { timeout: 10_000 });
  // Typing into its field, then Enter.
  await canvas.click({ position: { x: 60, y: 95 } });
  await page.keyboard.type("héllo");
  await page.keyboard.press("Enter");
  await expect(tab).toHaveText(/sent:héllo/, { timeout: 10_000 });
  // Reload brings the page back as served.
  await viewer.getByRole("button", { name: "Reload" }).click();
  await expect(tab).toHaveText(/Form page/, { timeout: 10_000 });

  // Send to session: the tab's title and address, pasted on one line.
  await viewer.getByRole("button", { name: "Send to session" }).click();
  await viewer.locator(".send-menu").getByRole("menuitem").first().click();
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(term)).toContain(`Browser tab "Form page" http://127.0.0.1:${port}/form`);

  // The + in the tab strip opens another; closing one closes it on the server too.
  await frontTab(page).locator(".ftabs").getByRole("button", { name: "New browser tab" }).click();
  await expect(frontTab(page).locator(".ftabs .tab")).toHaveCount(2, { timeout: 10_000 });
  // A tab not in front shows its × on hover.
  await frontTab(page).locator(".ftabs .tab", { hasText: "Form page" }).hover();
  await frontTab(page).getByRole("button", { name: "Close Form page" }).click();
  await expect(frontTab(page).locator(".ftabs .tab")).toHaveCount(1);
  await expect.poll(async () => (await tabsOnServer()).some((t) => t.url.includes(`:${port}/form`))).toBe(false);
  expect(await cspViolations(page)).toEqual([]);
});

// On a Retina screen the server's Chrome still sends pictures at the page's own size (headless
// Chrome's screencast ignores the device scale), so the picture is drawn at the page's size, not
// the frame's pixels halved, and fills the tab.
test.describe("Retina", () => {
  test.use({ deviceScaleFactor: 2 });
  test("the picture fills the tab, and a click lands where the page shows it", async ({ page }) => {
    const dir = fixtureDir("browser-retina");
    startSession(`${sess}-r`, dir, ["sh", "-c", "exec cat"]);
    await openSessionTab(page, dir);
    await page.locator(".layout-toggles").getByRole("button", { name: "New browser tab" }).click();
    const tab = frontTab(page).locator(".ftabs .tab.active");
    const viewer = frontTab(page).locator(".viewer:not([hidden])");
    const address = viewer.getByLabel("Address");
    await expect(address).toBeFocused({ timeout: 10_000 });
    await address.fill(`127.0.0.1:${port}/form`);
    await address.press("Enter");
    await expect(tab).toHaveText(/Form page/, { timeout: 10_000 });
    const area = viewer.locator(".page-live");
    const canvas = area.locator("canvas");
    await expect.poll(async () => Math.round((await canvas.boundingBox())?.width ?? 0)).toBe(Math.round((await area.boundingBox())!.width));
    // Down to the window's bottom: the terminal covers the rest (see below).
    const box = (await canvas.boundingBox())!;
    const right = (await frontTab(page).locator(".wb-right").boundingBox())!;
    expect(Math.round(box.height)).toBe(Math.round(right.y + right.height - (await area.boundingBox())!.y));
    await canvas.click({ position: { x: 50, y: 30 } });
    await expect(tab).toHaveText(/clicked/, { timeout: 10_000 });
    killSession(`${sess}-r`);
  });
});

// The page is laid out at the window's height, whatever the terminal below takes of it: the
// terminal covers the page's bottom instead of resizing it, and can be dragged up to cover it all.
test("the terminal covers a browser tab rather than resizing its page, all the way up", async ({ page }) => {
  const dir = fixtureDir("browser-term");
  startSession(`${sess}-t`, dir, ["sh", "-c", "exec cat"]);
  await openSessionTab(page, dir);
  await page.locator(".layout-toggles").getByRole("button", { name: "New browser tab" }).click();
  const tab = frontTab(page).locator(".ftabs .tab.active");
  const viewer = frontTab(page).locator(".viewer:not([hidden])");
  const address = viewer.getByLabel("Address");
  await expect(address).toBeFocused({ timeout: 10_000 });
  await address.fill(`127.0.0.1:${port}/form`);
  await address.press("Enter");
  await expect(tab).toHaveText(/Form page/, { timeout: 10_000 });
  const canvas = viewer.locator(".page-live canvas");
  const height = async () => Math.round((await canvas.boundingBox())?.height ?? 0);
  const right = (await frontTab(page).locator(".wb-right").boundingBox())!;
  const top = (await viewer.locator(".page-live").boundingBox())!.y;
  // Down to the window's bottom, under the terminal.
  await expect.poll(height).toBe(Math.round(right.y + right.height - top));
  const full = await height();
  // The divider dragged to the top: the terminal covers the tab; the page keeps its size.
  const sash = frontTab(page).getByRole("separator", { name: "Resize terminal" });
  const s = (await sash.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2, right.y - 50, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await frontTab(page).locator(".wb-editor").boundingBox())?.height ?? 0)).toBe(0);
  await page.waitForTimeout(500);
  expect(await height()).toBe(full);
  // And back down part way.
  const s2 = (await sash.boundingBox())!;
  await page.mouse.move(s2.x + s2.width / 2, s2.y + s2.height / 2);
  await page.mouse.down();
  await page.mouse.move(s2.x + s2.width / 2, right.y + right.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500);
  expect(await height()).toBe(full);
  killSession(`${sess}-t`);
});
