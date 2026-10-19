// README screenshots, against made-up sessions. Off unless BLIMP_SHOTS=1. Run it with ZMX_DIR set
// to an empty temp folder so blimp shows only these sessions, not the real ones:
//   ZMX_DIR=$(mktemp -d /tmp/bz.XXXX) BLIMP_SHOTS=1 bun run e2e screenshots

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, killSession, openApp, startSessionPty, zmxEnv } from "./helpers";

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

// What each made-up session has on its screen, printed before blimp attaches. Plain characters
// only: the Linux fonts the screenshots are taken with lack some of Claude's symbols.
const B = "\x1b[1m", D = "\x1b[2m", R = "\x1b[0m", G = "\x1b[32m", O = "\x1b[38;5;173m";
const SCREEN = [
  `${O}✻${R} ${B}Claude Code${R}`,
  "",
  `${D}>${R} add apple pay to checkout, behind the applePay flag`,
  "",
  `${O}●${R} I'll add Apple Pay as a payment method, off unless the flag is set.`,
  "",
  `${G}●${R} ${B}Read${R}(src/checkout.ts)`,
  `  ${D}└ Read 3 lines${R}`,
  "",
  `${G}●${R} ${B}Update${R}(src/checkout.ts)`,
  `  ${D}└ Updated src/checkout.ts with 14 additions${R}`,
  "",
  `${O}✻${R} Wiring up the payment sheet… ${D}(esc to interrupt)${R}`,
  "",
  `${D}>${R} `,
].join("\r\n");

test("screenshots", async ({ page }) => {
  const fixtures = e2e().fixtures;
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

  // Outside the test blimpd's home, so it isn't in any files tree.
  const screen = join(e2e().statusDir, "..", "screen.txt");
  writeFileSync(screen, SCREEN);
  for (const [name, folder] of FAKE) await startSessionPty(name, fixtureDir(folder), ["sh", "-c", `stty -echo; cat ${screen}; exec cat`]);
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
  // Earlier conversations in webshop, for the session list's Earlier section.
  const webProj = join(claude, "projects", web.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(webProj, { recursive: true });
  for (const title of ["Fix the flaky cart test", "Move prices to cents"])
    writeFileSync(join(webProj, `${crypto.randomUUID()}.jsonl`), JSON.stringify({ type: "ai-title", aiTitle: title, cwd: web }) + "\n");
  const recent = { projects: { localhost: ["webshop", "api", "notes"].map((f, i) => ({ dir: join(fixtures, f), at: Date.now() - i * 3_600_000 })) } };

  // Light and dark, as the system setting picks.
  for (const scheme of ["light", "dark"] as const) {
    const suffix = scheme === "dark" ? "-dark" : "";
    // Reduced motion: no waiting beacon caught mid-pulse.
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    // A fresh window each time: the api tab opened below would otherwise come back.
    await page.goto("about:blank");
    await page.evaluate(() => localStorage.clear()).catch(() => {});
    await openApp(page, { dir: join(fixtures, "api"), session: "blimpe2e-api-2" });
    await expect(page.locator(".wb:not([hidden]) .tpane-terms .term:not([hidden]) .xterm-rows")).toContainText("Wiring up the payment sheet");
    // webshop in a second tab, in front, with its two sessions split side by side.
    await page.keyboard.press("Meta+k");
    await page.keyboard.type("Add Apple Pay");
    await page.keyboard.press("Enter");
    const ws = page.locator(".wb:not([hidden])");
    await expect(ws.locator(".srow", { hasText: "Checkout page loads twice on Safari" })).toBeVisible({ timeout: 10_000 });
    await expect(ws.locator(".tpane-terms .term:not([hidden]) .xterm-rows")).toContainText("Wiring up the payment sheet");
    if ((await ws.locator(".slist-fold").getAttribute("aria-expanded")) === "false") await ws.locator(".slist-fold").click();
    await expect(ws.locator(".srow-main.earlier").first()).toBeVisible();
    const row = (await ws.locator(".srow", { hasText: "Checkout page loads twice on Safari" }).boundingBox())!;
    const terms = (await ws.locator(".tpane-terms").boundingBox())!;
    await page.mouse.move(row.x + 40, row.y + row.height / 2);
    await page.mouse.down();
    await page.mouse.move(terms.x + terms.width * 0.85, terms.y + terms.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(ws.locator(".tsplit-head")).toHaveCount(2);
    await ws.locator(".tree").getByText("README.md").click();
    await expect(ws.locator(".md-view h1")).toHaveText("webshop");
    await expect(ws.locator(".ftabs-toggle")).toHaveText("Edit"); // Monaco has loaded
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `main${suffix}.png`) });

    await ws.locator(".tree").getByText("src").click();
    await ws.locator(".tree").getByText("checkout.ts").click();
    await expect(ws.locator(".monaco-editor .view-lines")).toContainText("export function total");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `editor${suffix}.png`) });

    // From the terminal: inside Monaco, ⌘K is Monaco's.
    await ws.locator(".tpane-terms .term:not([hidden]) .xterm").first().click();
    await page.keyboard.press("Meta+k");
    await page.keyboard.type("api");
    await expect(page.locator(".dialog.palette .list-item").first()).toContainText("Rate limits for the public API");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `palette${suffix}.png`) });
    await page.keyboard.press("Escape");

    // Home, with recent projects (kept on the Mac; here the browser's storage). Home reads them
    // again as it comes forward.
    await page.evaluate((r) => localStorage.setItem("blimp.recent", JSON.stringify({ ...JSON.parse(localStorage.getItem("blimp.recent") ?? "{}"), ...r })), recent);
    await page.getByRole("tab", { name: "Home", exact: true }).click();
    await expect(page.locator(".wb:not([hidden]) .welcome-recent li")).toHaveCount(3);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `home${suffix}.png`) });
  }
});
