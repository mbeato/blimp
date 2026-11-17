// The server browser's Chrome (src/browser/chrome.ts): finding it, its flags, and a real launch
// over the debugging pipe. The live tests skip when the server has no Chrome or Chromium.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromeArgs, chromeHint, findChrome, launchChrome, phoneUserAgentFor, userAgentFor, type Chrome } from "../src/browser/chrome";

const tmp = mkdtempSync(join(tmpdir(), "blimp-chrome-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("sites see a normal Chrome of the same version", () => {
  expect(userAgentFor("Chromium 156.0.8078.4", "linux")).toBe("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36");
  // On a Mac, a Mac's: the rest of what Chrome tells a site says macOS.
  expect(userAgentFor("Google Chrome 157.0.8103.79", "darwin")).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36");
  expect(userAgentFor("Google Chrome 141.0.7390.54 \n")).toContain(" Chrome/141.0.0.0 ");
  expect(userAgentFor("nonsense")).toContain(" Chrome/140.0.0.0 ");
});

test("a phone sees a phone's Chrome of the same version", () => {
  expect(phoneUserAgentFor("HeadlessChrome/156.0.8078.4")).toBe("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36");
  expect(phoneUserAgentFor("nonsense")).toContain(" Chrome/140.0.0.0 Mobile ");
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
  expect(findChrome(home, (n) => (n === "chromium" ? "/usr/bin/chromium" : null), "")).toBe("/usr/bin/chromium");
  expect(findChrome(home, () => null, "", "linux")).toBe(join(home, ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome"));
  expect(findChrome(join(tmp, "empty"), () => null, "", "linux")).toBeNull();
  // Where PLAYWRIGHT_BROWSERS_PATH says.
  expect(findChrome(join(tmp, "empty"), () => null, join(home, ".cache", "ms-playwright"), "linux")).toBe(join(home, ".cache/ms-playwright/chromium-1248/chrome-linux64/chrome"));
});

test("which Chrome on a Mac: one on PATH, else Google Chrome's app (everyone's, then yours), else Playwright's newest", () => {
  const home = join(tmp, "mac");
  const apps = join(tmp, "Applications");
  const make = (p: string) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, ""), p);
  const find = (which: (n: string) => string | null = () => null, browsers = "") => findChrome(home, which, browsers, "darwin", apps);
  expect(find()).toBeNull();
  const cache = join(home, "Library", "Caches", "ms-playwright");
  const build = (v: string) => join(cache, `chromium-${v}`, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  make(build("1200"));
  make(build("1248"));
  expect(find()).toBe(build("1248"));
  expect(findChrome(join(tmp, "empty"), () => null, cache, "darwin", apps)).toBe(build("1248"));
  const yours = make(join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"));
  expect(find()).toBe(yours);
  const everyones = make(join(apps, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"));
  expect(find()).toBe(everyones);
  expect(find((n) => (n === "chromium" ? "/opt/homebrew/bin/chromium" : null))).toBe("/opt/homebrew/bin/chromium");
  // None of these is looked for on Linux.
  expect(findChrome(home, () => null, "", "linux", apps)).toBeNull();
});

test("what to install when there's none", () => {
  expect(chromeHint("linux")).toBe("npx playwright install chromium");
  expect(chromeHint("darwin")).toBe("Google Chrome in /Applications, or npx playwright install chromium");
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
  // The first Chrome launch on a fresh CI runner takes 8 to over 20 s (cold start; 0.4 s warm). The 5 s
  // race on the page load above is what catches a keyring hang, so this long budget doesn't weaken it.
}, 60_000);

live("text past a pipe chunk keeps its accents; calls to a Chrome that's gone answer with an error", async () => {
  const chrome = launchChrome(path!, join(tmp, "profile-2"));
  try {
    const { result } = await chrome.call("Target.createTarget", { url: "about:blank" });
    const s = (await chrome.call("Target.attachToTarget", { targetId: result.targetId, flatten: true })).result.sessionId;
    // 200 000 two-byte characters, odd-aligned: chunk ends fall inside characters.
    const r = await chrome.call("Runtime.evaluate", { expression: "'x' + 'é'.repeat(200000)", returnByValue: true }, s);
    expect(r.result.result.value).toBe("x" + "é".repeat(200000));
  } finally {
    chrome.kill();
    await chrome.exited;
  }
  const after = await Promise.race([chrome.call("Browser.getVersion"), Bun.sleep(2000).then(() => "hung")]);
  expect(after).toMatchObject({ error: { message: "Chrome exited" } });
}, 20_000);
