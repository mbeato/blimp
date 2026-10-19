// Hostile files from a server can't run script in the app: Markdown goes through DOMPurify, SVG
// shows only as an <img>, HTML shows as text, PDFs run no scripts, and the content security
// policy (index.html) blocks inline script even if something slipped through.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cspViolations, e2e, fixtureDir, killSession, openSessionTab, startSession } from "./helpers";

// WebGL on here (the other specs turn it off to read the terminal's text), so xterm's WebGL
// renderer runs under the policy too. SwiftShader gives headless Chromium a software GPU.
test.use({ launchOptions: { args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] } });

const name = `blimpe2e-xss-${process.pid}`;

test.afterAll(() => killSession(name));

const MD = `# Hostile

<script>window.__pwned = "script"; alert("script")</script>

<img src="x" onerror="window.__pwned = 'img'; alert('img')">

[markdown link](javascript:window.__pwned='link';alert('link'))

<a href="javascript:window.__pwned='a';alert('a')">html link</a>

<iframe srcdoc="<script>parent.__pwned='iframe';parent.alert('iframe')</script>"></iframe>

<svg onload="window.__pwned='svg';alert('svg')"><circle r="5"/></svg>

<object data="javascript:window.__pwned='object'"></object>

![a dot](dot.png)
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="window.__pwned='svgfile';alert('svgfile')">
<script>window.__pwned='svgscript';alert('svgscript')</script>
<rect width="40" height="40" fill="teal"/>
</svg>
`;

const HTML = `<!doctype html><script>window.__pwned='html';alert('html')</script><img src=x onerror="window.__pwned='htmlimg'">\n`;

// One page, and an action that asks a viewer with scripting to run JavaScript.
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R/OpenAction<</S/JavaScript/JS(app.alert('pdf'))>>>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>endobj
4 0 obj<</Length 30>>stream
0 0 1 rg 20 20 160 60 re f
endstream endobj
trailer<</Root 1 0 R>>
%%EOF
`;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("hostile Markdown, SVG, HTML and PDF run nothing, and the CSP blocks inline script", async ({ page }) => {
  const dir = fixtureDir("xss");
  writeFileSync(join(dir, "evil.md"), MD);
  writeFileSync(join(dir, "evil.svg"), SVG);
  writeFileSync(join(dir, "evil.html"), HTML);
  writeFileSync(join(dir, "evil.pdf"), PDF);
  writeFileSync(join(dir, "dot.png"), PNG);
  startSession(name, dir);

  const dialogs: string[] = [];
  page.on("dialog", (d) => (dialogs.push(d.message()), void d.dismiss()));
  const term = await openSessionTab(page, dir);
  const url = page.url();
  // xterm's WebGL renderer draws into its own canvas.
  await expect(term.locator(".xterm canvas").first()).toBeAttached();
  const ws = page.locator(".wb:not([hidden])");
  const tree = ws.locator(".tree");

  await tree.getByText("evil.svg").click();
  const svg = ws.locator(".image-view img");
  await expect.poll(() => svg.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(40);

  await tree.getByText("evil.html").click();
  await expect(ws.locator(".monaco-editor .view-lines")).toContainText("<script>window.__pwned='html'");

  await tree.getByText("evil.pdf").click();
  await expect(ws.locator(".pdf-view canvas.pdf-page")).toBeVisible();

  // Monaco and its worker, pdf.js and its worker, xterm (WebGL) and blob images all work within the policy.
  expect(await cspViolations(page)).toEqual([]);

  await tree.getByText("evil.md").click();
  const md = ws.locator(".md-view");
  await expect(md.locator("h1")).toHaveText("Hostile");
  await expect(md.locator("script, iframe, object, embed")).toHaveCount(0);
  expect(await md.evaluate((el) => [...el.querySelectorAll("*")].flatMap((n) => n.getAttributeNames()).filter((a) => a.startsWith("on")))).toEqual([]);
  // The relative image comes from the server as a blob URL; the token stays out of the page.
  const dot = md.locator('img[alt="a dot"]');
  await expect(dot).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => dot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await md.getByText("markdown link").click();
  await md.getByText("html link").click();
  expect(page.url()).toBe(url);

  // Parsing the file (DOMPurify's inert document) trips the policy on its inline handlers; they
  // are refused and reported, and DOMPurify drops them anyway. Nothing else is refused.
  expect((await cspViolations(page)).filter((v) => !v.startsWith("script-src-attr inline "))).toEqual([]);

  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(await page.content()).not.toContain(e2e().token);

  // The policy is on: inline script injected into the page is refused and reported.
  const directive = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.addEventListener("securitypolicyviolation", (e) => resolve(e.effectiveDirective), { once: true });
        const s = document.createElement("script");
        s.textContent = "window.__pwned = 'inline'";
        document.body.append(s);
      }),
  );
  expect(directive).toBe("script-src-elem");
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
});
