// Ports that programs in a session listen on: listed under Ports, announced when one opens, and
// shown in a browser tab next to the files: a tab of the server's Chrome, at the server's
// localhost:<port>. Pages are checked by their titles, which blimpd lists with the tab.

import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import { cspViolations, e2e, fixtureDir, frontTab, killSession, openSessionTab, startSession } from "./helpers";

const pid = process.pid;
const first = `blimpe2e-portsa-${pid}`;
const second = `blimpe2e-portsb-${pid}`;
test.afterAll(() => [first, second].forEach(killSession));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

// A web server that answers with its name and the path asked for.
const web = (name: string, port: number) => [
  "bun",
  "-e",
  `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: (r) => new Response("<title>${name} " + new URL(r.url).pathname + "</title><h1>${name}</h1>", { headers: { "content-type": "text/html" } }) }); setInterval(() => {}, 1e9)`,
];

test("a session's port is listed, a new one is announced, and either opens in a browser tab", async ({ page }) => {
  const dir = fixtureDir("ports");
  const [p1, p2] = [await freePort(), await freePort()];
  startSession(first, dir, web("first", p1));
  await expect.poll(() => fetch(`http://127.0.0.1:${p1}/`).then((r) => r.ok, () => false), { timeout: 10_000 }).toBe(true);
  await openSessionTab(page, dir, first);
  const list = frontTab(page).locator(".slist");
  const row1 = list.locator(".port-row", { hasText: `localhost:${p1}` });
  await expect(row1).toBeVisible({ timeout: 10_000 });
  // Already open when the pane loaded: listed, not announced.
  await expect(frontTab(page).locator(".port-notice")).toHaveCount(0);

  await row1.click();
  const tabs = frontTab(page).locator(".ftabs .tab");
  const tab1 = frontTab(page).locator(".ftabs .tab.active");
  await expect(tab1).toHaveText(/first \//, { timeout: 10_000 });
  // The page itself: a frame drawn in the canvas.
  const canvas = frontTab(page).locator(".viewer:not([hidden]) .page-live canvas");
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width), { timeout: 10_000 }).toBeGreaterThan(0);

  // Another path from the address bar, then Reload.
  const address = frontTab(page).locator(".viewer:not([hidden])").getByLabel("Address");
  await expect(address).toHaveValue(`http://localhost:${p1}/`);
  await address.fill(`localhost:${p1}/about`);
  await address.press("Enter");
  await expect(tab1).toHaveText(/first \/about/, { timeout: 10_000 });
  await expect(address).toHaveValue(`http://localhost:${p1}/about`);
  await frontTab(page).locator(".viewer:not([hidden])").getByRole("button", { name: "Reload" }).click();
  await expect(tab1).toHaveText(/first \/about/);
  // Opening the port again brings its tab forward instead of another.
  await row1.click();
  await expect(tabs).toHaveCount(1);

  // A port that opens later is announced; Open shows it in a second tab.
  startSession(second, dir, web("second", p2));
  const notice = frontTab(page).locator(".port-notice");
  await expect(notice).toContainText(`Port ${p2} is open`, { timeout: 10_000 });
  await notice.getByRole("button", { name: "Open" }).click();
  await expect(notice).toHaveCount(0);
  await expect(tabs).toHaveCount(2, { timeout: 10_000 });
  await expect(frontTab(page).locator(".ftabs .tab.active")).toHaveText(/second \//, { timeout: 10_000 });

  // Closing a browser tab closes it on the server; the first one comes forward.
  await frontTab(page).getByRole("button", { name: "Close second /" }).click();
  await expect(tabs).toHaveCount(1);
  await expect(frontTab(page).locator(".ftabs .tab.active")).toHaveText(/first \/about/);
  const { base, token } = e2e();
  await expect.poll(async () => ((await (await fetch(`${base}/browser/tabs`, { headers: { Authorization: `Bearer ${token}` } })).json()) as any[]).some((t) => t.url.includes(`:${p2}/`))).toBe(false);

  // A session that ends takes its port off the list.
  killSession(second);
  await expect(list.locator(".port-row", { hasText: `localhost:${p2}` })).toHaveCount(0, { timeout: 10_000 });
  expect(await cspViolations(page)).toEqual([]);
});
