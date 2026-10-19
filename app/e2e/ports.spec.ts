// Ports that programs in a session listen on: listed under Ports, announced when one opens, and
// shown in a browser tab next to the files. (The browser build runs on the server's machine, so it
// uses the port as it is; the Mac app forwards one over SSH: e2e-native.)

import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import { cspViolations, fixtureDir, frontTab, killSession, openSessionTab, startSession } from "./helpers";

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
  `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: (r) => new Response("<h1>${name} " + new URL(r.url).pathname + "</h1>", { headers: { "content-type": "text/html" } }) }); setInterval(() => {}, 1e9)`,
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
  const tab1 = frontTab(page).locator(".ftabs .tab.active");
  await expect(tab1).toHaveText(/localhost:\d+/);
  const frame = frontTab(page).locator(".viewer:not([hidden]) iframe.page-frame");
  await expect(frame.contentFrame().locator("h1")).toHaveText("first /");

  // Another path from the address bar, then Reload.
  const path = frontTab(page).getByLabel("Path");
  await path.fill("/about");
  await path.press("Enter");
  await expect(frame.contentFrame().locator("h1")).toHaveText("first /about");
  await frontTab(page).getByRole("button", { name: "Reload" }).click();
  await expect(frame.contentFrame().locator("h1")).toHaveText("first /about");

  // A port that opens later is announced; Open shows it in a second tab.
  startSession(second, dir, web("second", p2));
  const notice = frontTab(page).locator(".port-notice");
  await expect(notice).toContainText(`Port ${p2} is open`, { timeout: 10_000 });
  await notice.getByRole("button", { name: "Open" }).click();
  await expect(notice).toHaveCount(0);
  await expect(frontTab(page).locator(".ftabs .tab")).toHaveCount(2);
  await expect(frontTab(page).locator(".viewer:not([hidden]) iframe.page-frame").contentFrame().locator("h1")).toHaveText("second /");

  // Closing a browser tab; the first one comes forward, as it was.
  await frontTab(page).getByRole("button", { name: `Close localhost:${p2}` }).click();
  await expect(frontTab(page).locator(".ftabs .tab")).toHaveCount(1);
  await expect(frame.contentFrame().locator("h1")).toHaveText("first /about");

  // A session that ends takes its port off the list.
  killSession(second);
  await expect(list.locator(".port-row", { hasText: `localhost:${p2}` })).toHaveCount(0, { timeout: 10_000 });
  expect(await cspViolations(page)).toEqual([]);
});
