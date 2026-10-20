// The server browser's Chrome (src/browser/chrome.ts): finding it, its flags, and a real launch
// over the debugging pipe. The live tests skip when the server has no Chrome or Chromium.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeArgs, findChrome, launchChrome, userAgentFor, type Chrome } from "../src/browser/chrome";

const tmp = mkdtempSync(join(tmpdir(), "blimp-chrome-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("sites see a normal Chrome of the same version", () => {
  expect(userAgentFor("Chromium 156.0.8078.4")).toBe("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36");
  expect(userAgentFor("Google Chrome 141.0.7390.54 \n")).toContain(" Chrome/141.0.0.0 ");
  expect(userAgentFor("nonsense")).toContain(" Chrome/140.0.0.0 ");
});

test("flags: headless over a pipe, no keyring, not marked as automated", () => {
  const a = chromeArgs("/p", "UA");
  for (const f of ["--headless=new", "--remote-debugging-pipe", "--password-store=basic", "--no-first-run", "--user-data-dir=/p", "--disable-blink-features=AutomationControlled", "--user-agent=UA"])
    expect(a).toContain(f);
  expect(a).not.toContain("--enable-automation");
  expect(a.some((f) => f.startsWith("--remote-debugging-port"))).toBe(false);
});

test("which Chrome: one on PATH first, else Playwright's newest, else none", () => {
  const home = join(tmp, "home");
  for (const v of ["1200", "1248"]) {
    const d = join(home, ".cache", "ms-playwright", `chromium-${v}`, "chrome-linux64");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "chrome"), "");
  }
  expect(findChrome(home, (n) => (n === "chromium" ? "/usr/bin/chromium" : null))).toBe("/usr/bin/chromium");
  expect(findChrome(home, () => null)).toBe(join(home, ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome"));
  expect(findChrome(join(tmp, "empty"), () => null)).toBeNull();
});

const path = findChrome();
const live = path ? test : test.skip;
if (!path) console.log("no Chrome or Chromium on this server: skipping the live Chrome tests");

live("a launched Chrome answers over the pipe, loads a page, and passes for a normal browser", async () => {
  const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<title>t</title>hi", { headers: { "content-type": "text/html" } }) });
  let chrome: Chrome | undefined;
  try {
    chrome = launchChrome(path!, join(tmp, "profile"));
    const v = await chrome.call("Browser.getVersion");
    expect(v.result.product).toMatch(/Chrom/);
    const { result } = await chrome.call("Target.createTarget", { url: "about:blank" });
    const att = await chrome.call("Target.attachToTarget", { targetId: result.targetId, flatten: true });
    const s = att.result.sessionId;
    const loaded = new Promise<void>((done) => chrome!.onMessage((m) => m.method === "Page.loadEventFired" && m.sessionId === s && done()));
    await chrome.call("Page.enable", {}, s);
    await chrome.call("Page.navigate", { url: `http://127.0.0.1:${site.port}/` }, s);
    // Without --password-store=basic this never comes: Chrome waits on a keyring there's none of.
    await Promise.race([loaded, Bun.sleep(5000).then(() => Promise.reject(new Error("the page never loaded")))]);
    const ua = await chrome.call("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true }, s);
    expect(ua.result.result.value).not.toContain("Headless");
    const wd = await chrome.call("Runtime.evaluate", { expression: "navigator.webdriver", returnByValue: true }, s);
    expect(wd.result.result.value).toBe(false);
  } finally {
    chrome?.kill();
    await chrome?.exited;
    site.stop();
  }
}, 20_000);
