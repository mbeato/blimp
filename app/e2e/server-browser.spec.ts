// The server browser, step 1: a folder's tabs in the server's Chrome are listed under Browser in
// the session list, marked when a session opened them, and open in a tab here. (Opened here
// through the API; sessions opening them through the gate is tested on the server side.)

import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { cspViolations, e2e, fixtureDir, frontTab, killSession, openSessionTab, startSession } from "./helpers";

const sess = `blimpe2e-serverbrowser-${process.pid}`;
let server: Server;
let port = 0;
test.beforeAll(async () => {
  server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<title>Server page</title><h1>served ${req.url}</h1>`));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
test.afterAll(() => {
  server.close();
  killSession(sess);
});

test("a folder's server browser tabs are listed, and one opens in a tab here", async ({ page }) => {
  const dir = fixtureDir("serverbrowser");
  startSession(sess, dir);
  const { base, token } = e2e();
  const r = await fetch(`${base}/browser/tabs`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ dir, url: `http://127.0.0.1:${port}/x` }) });
  test.skip(r.status === 503, "no Chrome or Chromium on this server");
  expect(r.status).toBe(201);
  const { id } = await r.json();

  await openSessionTab(page, dir, sess);
  const list = frontTab(page).locator(".slist");
  await expect(list.locator(".slist-label", { hasText: "Browser" })).toBeVisible({ timeout: 10_000 });
  // Its own title comes in within a few seconds (the server asks Chrome every 2 s).
  const row = list.locator(".port-row", { hasText: "Server page" });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText(`127.0.0.1:${port}`);

  await row.click();
  const frame = frontTab(page).locator(".viewer:not([hidden]) iframe.page-frame");
  await expect(frame.contentFrame().locator("h1")).toHaveText("served /");

  // Closed on the server: gone from the list.
  expect((await fetch(`${base}/browser/tabs/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })).status).toBe(204);
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  expect(await cspViolations(page)).toEqual([]);
});
