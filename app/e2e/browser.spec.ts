// Browser tabs next to the file tabs: tabs of the server's Chrome, shown live. The page is drawn
// in a canvas, so it's checked through what blimpd knows of it (the tab's title, over GET
// /browser/tabs and the tab strip); clicks and typing go to it as a person's would. Send to
// session pastes the tab's title and address into a session.

import { createServer, type Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { cspViolations, e2e, fixtureDir, frontTab, killSession, openSessionTab, screenText, startSession } from "./helpers";

const sess = `blimpe2e-browser-${process.pid}`;
let server: Server;
let port = 0;
// A button at 10,10 (100x40) that retitles the page, and a form below it that puts what's typed in
// the title.
const PAGE = `<!doctype html><title>Form page</title>
<style>body{margin:0} button{position:absolute;left:10px;top:10px;width:100px;height:40px} form{position:absolute;left:10px;top:80px} input{width:200px;height:30px}</style>
<button onclick="document.title='clicked'">b</button>
<form onsubmit="event.preventDefault();document.title='sent:'+this.q.value"><input name="q"></form>
<p style="position:absolute;left:10px;top:140px;margin:0;font:20px sans-serif">pickme</p>`;

test.beforeAll(async () => {
  server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
test.afterAll(() => {
  server.close();
  killSession(sess);
});

// The globe at the top right: New browser tab while the folder has none, else Hide or Show browser tabs.
const globe = (page: Page, name: string) => page.locator(".layout-toggles").getByRole("button", { name }).click();

// A tab dragged by the mouse to x (in steps, so the drag starts as a person's would).
async function drag(page: Page, tab: ReturnType<Page["locator"]>, x: number) {
  const b = (await tab.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("a browser tab is the server's Chrome, live: clicks and typing reach the page; Send to session; closed on the server", async ({ page }) => {
  const dir = fixtureDir("browser");
  startSession(sess, dir, ["sh", "-c", "stty -echo; exec cat"]);
  const term = await openSessionTab(page, dir);
  const { base, token } = e2e();
  const tabsOnServer = async () => (await (await fetch(`${base}/browser/tabs`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { id: string; url: string; title: string; folder: string }[];

  await globe(page, "New browser tab");
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
    await globe(page, "New browser tab");
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
  await globe(page, "New browser tab");
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

// Copy out of the page as the Mac's Edit menu (and its ⌘C) does: the copy command on the field
// that has focus, there and then, with nothing to wait for. The field holds the page's selection.
test("text selected in the page copies to the clipboard with the Edit menu's Copy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const dir = fixtureDir("browser-copy");
  startSession(`${sess}-c`, dir, ["sh", "-c", "exec cat"]);
  await openSessionTab(page, dir);
  await globe(page, "New browser tab");
  const tab = frontTab(page).locator(".ftabs .tab.active");
  const viewer = frontTab(page).locator(".viewer:not([hidden])");
  const address = viewer.getByLabel("Address");
  await expect(address).toBeFocused({ timeout: 10_000 });
  await address.fill(`127.0.0.1:${port}/form`);
  await address.press("Enter");
  await expect(tab).toHaveText(/Form page/, { timeout: 10_000 });
  await page.evaluate(() => navigator.clipboard.writeText("before"));
  await viewer.locator(".page-live canvas").dblclick({ position: { x: 30, y: 150 } });
  await expect.poll(async () => {
    await page.evaluate(() => document.execCommand("copy"));
    return page.evaluate(() => navigator.clipboard.readText());
  }).toBe("pickme");
  // Cut: typed text, selected with ⌘A, leaves the field and lands on the clipboard.
  await viewer.locator(".page-live canvas").click({ position: { x: 60, y: 95 } });
  await page.keyboard.type("cutme");
  await page.keyboard.press("Meta+a");
  // Once the server has said what's selected (before that, Cut has nothing to cut).
  await expect(viewer.getByLabel("Type into the page")).toHaveValue("cutme");
  await page.evaluate(() => document.execCommand("cut"));
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("cutme");
  await page.keyboard.press("Enter");
  await expect(tab).toHaveText(/sent:(?!cutme)/, { timeout: 10_000 });
  killSession(`${sess}-c`);
});

// The globe opens a browser tab while the folder has none, then hides and shows them. Hidden
// browsers stream nothing: their tabs leave the strip and the view socket closes, but the
// page stays open on the server; showing them brings the tab back, live. A window that can't be
// seen (minimized, or behind other apps) closes it too, until it's seen again.
test("the globe hides the browser tabs, and that and a hidden window stop the stream; the page stays open on the server", async ({ page }) => {
  const dir = fixtureDir("browser-hide");
  startSession(`${sess}-h`, dir, ["sh", "-c", "exec cat"]);
  const views: { closed: boolean }[] = [];
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/browser/tabs/")) return;
    const v = { closed: false };
    views.push(v);
    ws.on("close", () => (v.closed = true));
  });
  const live = () => views.filter((v) => !v.closed).length;
  await openSessionTab(page, dir);
  await globe(page, "New browser tab");
  const tab = frontTab(page).locator(".ftabs .page-tab");
  const address = frontTab(page).locator(".viewer:not([hidden])").getByLabel("Address");
  await expect(address).toBeFocused({ timeout: 10_000 });
  await address.fill(`127.0.0.1:${port}/form`);
  await address.press("Enter");
  await expect(tab).toHaveText(/Form page/, { timeout: 10_000 });
  await expect.poll(live).toBe(1);

  await globe(page, "Hide browser tabs");
  await expect(tab).toHaveCount(0);
  await expect.poll(live).toBe(0);
  const { base, token } = e2e();
  const onServer = async () => ((await (await fetch(`${base}/browser/tabs`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { url: string }[]).some((t) => t.url.includes(`:${port}/form`));
  expect(await onServer()).toBe(true);

  await globe(page, "Show browser tabs");
  await expect(frontTab(page).locator(".ftabs .page-tab.active")).toHaveText(/Form page/);
  await expect.poll(live).toBe(1);

  // The window hidden, then seen again.
  const visibility = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, "hidden", { value: h, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: h ? "hidden" : "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await visibility(true);
  await expect.poll(live).toBe(0);
  await visibility(false);
  await expect.poll(live).toBe(1);

  // Opening a browser tab while they're hidden shows them again.
  await globe(page, "Hide browser tabs");
  await expect(tab).toHaveCount(0);
  await page.keyboard.press("Meta+t");
  await expect(frontTab(page).locator(".ftabs .page-tab")).toHaveCount(2, { timeout: 10_000 });
  killSession(`${sess}-h`);
});

// Browser tabs drag into another order, kept with the window's layout (a reload keeps it).
test("browser tabs drag into another order, and keep it", async ({ page }) => {
  const dir = fixtureDir("browser-order");
  startSession(`${sess}-o`, dir, ["sh", "-c", "exec cat"]);
  await openSessionTab(page, dir);
  const strip = frontTab(page).locator(".ftabs");
  for (const name of ["one", "two", "three"]) {
    await page.keyboard.press("Meta+t");
    const address = frontTab(page).locator(".viewer:not([hidden])").getByLabel("Address");
    await expect(address).toBeFocused({ timeout: 10_000 });
    await address.fill(`127.0.0.1:${port}/${name}`);
    await address.press("Enter");
    await expect(strip.locator(".page-tab.active")).toHaveText(/Form page/, { timeout: 10_000 });
  }
  // Told apart by their addresses (each tab's tooltip).
  const ids = async () => (await strip.locator(".page-tab").evaluateAll((els) => els.map((e) => e.getAttribute("title")))).map((t) => t!.split("\n")[0]);
  expect((await ids()).map((u) => u.split("/").pop())).toEqual(["one", "two", "three"]);
  // The last one dragged to the start.
  const first = (await strip.locator(".page-tab").first().boundingBox())!;
  await drag(page, strip.locator(".page-tab").last(), first.x + 2);
  await expect.poll(async () => (await ids()).map((u) => u.split("/").pop())).toEqual(["three", "one", "two"]);
  // A plain click is still a click: it picks the tab, and the order stays.
  await strip.locator(".page-tab").nth(1).click();
  await expect(strip.locator(".page-tab").nth(1)).toHaveClass(/active/);
  await page.reload();
  await expect.poll(async () => (await ids()).map((u) => u.split("/").pop()), { timeout: 10_000 }).toEqual(["three", "one", "two"]);
  killSession(`${sess}-o`);
});
