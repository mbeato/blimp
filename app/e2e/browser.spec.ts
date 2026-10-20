// Browser tabs next to the file tabs (any address), and Send to session. The browser build shows
// a page in a sandboxed iframe, which can't read the page's text or history; the Mac app's
// native view (title, text, Back/Forward) is checked in e2e-native.

import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cspViolations, e2e, fixtureDir, frontTab, killSession, openSessionTab, screenText, startSession } from "./helpers";

const pid = process.pid;
const sess = `blimpe2e-browser-${pid}`;
let server: Server;
let port = 0;

test.beforeAll(async () => {
  server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<title>Test page</title><h1>page ${req.url}</h1>`));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
test.afterAll(() => {
  server.close();
  killSession(sess);
});

test("a new browser tab opens any address next to the files; Send to session uploads it and pastes its path", async ({ page }) => {
  const dir = fixtureDir("browser");
  startSession(sess, dir, ["sh", "-c", "stty -echo; exec cat"]);
  const term = await openSessionTab(page, dir);
  const uploads = join(e2e().fixtures, ".blimp", "uploads");
  const before = existsSync(uploads) ? readdirSync(uploads) : [];

  await page.locator(".layout-toggles").getByRole("button", { name: "New browser tab" }).click();
  const tab = frontTab(page).locator(".ftabs .tab.active");
  await expect(tab).toHaveText(/New tab/);
  const address = frontTab(page).getByLabel("Address");
  await expect(address).toBeFocused();
  await address.fill(`127.0.0.1:${port}/hello`);
  await address.press("Enter");
  const frame = frontTab(page).locator(".viewer:not([hidden]) iframe.page-frame");
  await expect(frame.contentFrame().locator("h1")).toHaveText("page /hello");
  await expect(address).toHaveValue(`http://127.0.0.1:${port}/hello`);
  await expect(tab).toHaveText(new RegExp(`127.0.0.1:${port}`));

  // Send to session: the folder's sessions; the file has the address, and its path is pasted.
  await frontTab(page).getByRole("button", { name: "Send to session" }).click();
  await frontTab(page).locator(".send-menu").getByRole("menuitem").first().click();
  await expect.poll(() => (existsSync(uploads) ? readdirSync(uploads).filter((f) => !before.includes(f)) : [])).toHaveLength(1);
  const [name] = readdirSync(uploads).filter((f) => !before.includes(f));
  expect(name).toBe("page-127.0.0.1.md");
  expect(readFileSync(join(uploads, name), "utf8")).toContain(`http://127.0.0.1:${port}/hello`);
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(term)).toContain(`Page http://127.0.0.1:${port}/hello: ${join(uploads, name)}`);

  // The + in the tab strip opens another; closing one brings the other forward.
  await frontTab(page).locator(".ftabs").getByRole("button", { name: "New browser tab" }).click();
  await expect(frontTab(page).locator(".ftabs .tab")).toHaveCount(2);
  await frontTab(page).getByRole("button", { name: "Close New tab" }).click();
  await expect(frontTab(page).locator(".ftabs .tab")).toHaveCount(1);
  await expect(frame.contentFrame().locator("h1")).toHaveText("page /hello");
  expect(await cspViolations(page)).toEqual([]);
});
