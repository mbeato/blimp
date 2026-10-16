// README screenshots, against made-up sessions. Off unless BLIMP_SHOTS=1. Run it with ZMX_DIR set
// to an empty temp folder so the sidebar shows only these sessions, not the real ones:
//   ZMX_DIR=$(mktemp -d) BLIMP_SHOTS=1 bun run e2e screenshots

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, killSession, openApp, startSession, zmxEnv } from "./helpers";

test.skip(!process.env.BLIMP_SHOTS || !process.env.ZMX_DIR, "set BLIMP_SHOTS=1 and ZMX_DIR");

const out = join(import.meta.dirname, "../../docs/screenshots");

// name, folder, title, Claude status, minutes since last activity
const FAKE = [
  ["blimpe2e-web-1", "webshop", "Checkout page loads twice on Safari", "waiting", 1],
  ["blimpe2e-web-2", "webshop", "Add Apple Pay to checkout", "busy", 0],
  ["blimpe2e-api-1", "api", "Rate limits for the public API", "idle", 14],
  ["blimpe2e-api-2", "api", "Postgres slow query on /orders", "busy", 3],
  ["blimpe2e-notes-1", "notes", "Q4 planning notes", "idle", 95],
] as const;

test.afterAll(() => FAKE.forEach(([name]) => killSession(name)));

test("screenshots", async ({ page }) => {
  const claude = process.env.BLIMP_E2E_CLAUDE!;
  mkdirSync(join(claude, "sessions"), { recursive: true });
  const web = fixtureDir("webshop");
  mkdirSync(join(web, "src"), { recursive: true });
  writeFileSync(
    join(web, "README.md"),
    "# webshop\n\nThe storefront.\n\n## Checkout\n\n- Cart totals are computed on the server\n- Apple Pay is behind the `applePay` flag\n\n```ts\nexport const applePay = false;\n```\n",
  );
  writeFileSync(join(web, "src", "checkout.ts"), "export function total(items: { price: number }[]) {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n");
  writeFileSync(join(web, "package.json"), '{ "name": "webshop" }\n');

  for (const [name, folder, , ,] of FAKE) startSession(name, fixtureDir(folder), ["sh", "-c", "printf '\\033[1mClaude Code\\033[0m\\n\\n> what would you like to do?\\n'; exec cat"]);
  const list = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8" });
  for (const [name, , title, status, mins] of FAKE) {
    const pid = list.match(new RegExp(`name=${name}\\tpid=(\\d+)`))![1];
    const sid = crypto.randomUUID();
    const at = Date.now() - mins * 60_000;
    writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ sessionId: sid, status, updatedAt: at, statusUpdatedAt: at }));
    const proj = join(claude, "projects", "fake");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, `${sid}.jsonl`), JSON.stringify({ type: "ai-title", aiTitle: title }) + "\n");
  }

  await openApp(page);
  await expect(page.getByText("Checkout page loads twice on Safari").first()).toBeVisible({ timeout: 10_000 });
  await page.getByText("Add Apple Pay to checkout").first().click();
  await expect(page.locator(".term:not([hidden]) .xterm")).toBeVisible();
  const ws = page.locator(".workspace:not([hidden])");
  await ws.locator(".tree").getByText("README.md").click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, "main.png") });

  await ws.locator(".tree").getByText("src").click();
  await ws.locator(".tree").getByText("checkout.ts").click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, "editor.png") });

  await page.keyboard.press("Meta+k");
  await page.keyboard.type("api");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, "palette.png") });
  expect(e2e().base).toBeTruthy();
});
