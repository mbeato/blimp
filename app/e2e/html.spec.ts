// Feature 7: an HTML file shows as a page (in a sandbox: no script, not the app's origin), with
// the images and stylesheets next to it; Edit shows its text. A folder of renders shows as a
// gallery that keeps up as new ones are written.

import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cspViolations, fixtureDir, killSession, openSessionTab, startSession } from "./helpers";

const page1 = `blimpe2e-html-${process.pid}`;
const gal = `blimpe2e-gallery-${process.pid}`;

test.afterAll(() => {
  killSession(page1);
  killSession(gal);
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const svg = (w: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}"><rect width="${w}" height="${w}" fill="teal"/></svg>`;

const HTML = `<!doctype html>
<html><head>
<link rel="stylesheet" href="css/site.css">
<link rel="stylesheet" href="https://example.invalid/far.css">
</head><body>
<h1 id="title">Render report</h1>
<img id="dot" src="img/dot.png" alt="dot">
<img id="far" src="https://example.invalid/far.png" alt="far">
</body></html>
`;

test("an HTML file shows as a sandboxed page with its own images and stylesheet; Edit shows and saves its text", async ({ page }) => {
  const dir = fixtureDir("html");
  mkdirSync(join(dir, "css"), { recursive: true });
  mkdirSync(join(dir, "img"), { recursive: true });
  writeFileSync(join(dir, "report.html"), HTML);
  writeFileSync(join(dir, "css", "site.css"), "h1 { color: rgb(255, 0, 0); }\n");
  writeFileSync(join(dir, "img", "dot.png"), PNG);
  startSession(page1, dir);

  await openSessionTab(page, dir);
  const ws = page.locator(".wb:not([hidden])");
  await ws.locator(".tree").getByText("report.html").click();

  const frame = ws.locator("iframe.html-view");
  await expect(frame).toBeVisible();
  // No allow-scripts, no allow-same-origin: nothing runs, and the page is not the app's origin.
  await expect(frame).toHaveAttribute("sandbox", "");
  const doc = frame.contentFrame();
  await expect(doc.locator("#title")).toHaveText("Render report");
  // The stylesheet next to it is inlined, so it applies.
  await expect(doc.locator("#title")).toHaveCSS("color", "rgb(255, 0, 0)");
  // The image next to it comes from the server, inlined; one on the web is left out.
  await expect(doc.locator("#dot")).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect.poll(() => doc.locator("#dot").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  expect(await doc.locator("#far").getAttribute("src")).toBeNull();
  expect(await doc.locator("link").count()).toBe(0);
  expect(await cspViolations(page)).toEqual([]);

  // Edit shows the text in the editor; an edit saves to the file, and Preview shows it.
  await ws.getByRole("button", { name: "Edit" }).click();
  const editor = ws.locator(".monaco-editor .view-lines");
  await expect(editor).toContainText('<h1 id="title">Render report</h1>');
  await expect(frame).toBeHidden();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type('<p id="added">added here</p>');
  await expect.poll(() => readFileSync(join(dir, "report.html"), "utf8"), { timeout: 5000 }).toContain('<p id="added">added here</p>');
  await ws.getByRole("button", { name: "Preview" }).click();
  await expect(doc.locator("#added")).toHaveText("added here");

  // Claude rewrites the file: the page shows the new version.
  writeFileSync(join(dir, "report.html"), "<!doctype html><h1 id=title>Second version</h1>\n");
  await expect(doc.locator("#title")).toHaveText("Second version", { timeout: 5000 });
});

test("a folder shows as a gallery of its images, newest first, that keeps up and opens one on click", async ({ page }) => {
  const dir = fixtureDir("gallery");
  const renders = join(dir, "renders");
  mkdirSync(renders, { recursive: true });
  mkdirSync(join(dir, "empty"), { recursive: true });
  const t = Date.now() / 1000;
  const put = (name: string, body: string | Buffer, ago: number) => {
    writeFileSync(join(renders, name), body);
    utimesSync(join(renders, name), t - ago, t - ago);
  };
  put("oldest.png", PNG, 3 * 3600);
  put("middle.svg", svg(30), 2 * 3600);
  put("newest.svg", svg(20), 600);
  put("notes.txt", "not a picture\n", 60);
  startSession(gal, dir);

  await openSessionTab(page, dir);
  const ws = page.locator(".wb:not([hidden])");
  await ws.locator(".tree").getByText("renders").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show as Gallery" }).click();

  await expect(ws.locator(".tab.active")).toContainText("renders");
  const tiles = ws.locator(".gallery .gallery-tile");
  await expect(tiles.locator(".gallery-name")).toHaveText(["newest.svg", "middle.svg", "oldest.png"]);
  await expect(tiles.first().locator(".gallery-time")).toHaveText("10m ago");
  // Thumbnails come from the server as blob URLs (the token stays out of the page).
  await expect(tiles.first().locator("img")).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => tiles.nth(1).locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(30);

  // A new render shows up first, without a reload.
  writeFileSync(join(renders, "fresh.png"), PNG);
  await expect(tiles.locator(".gallery-name")).toHaveText(["fresh.png", "newest.svg", "middle.svg", "oldest.png"], { timeout: 5000 });

  // A click opens the image in its own tab.
  await tiles.filter({ hasText: "middle.svg" }).click();
  await expect(ws.locator(".tab.active")).toContainText("middle.svg");
  await expect.poll(() => ws.locator(".image-view img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(30);

  // Back to the gallery, then close it.
  await ws.locator(".tab", { hasText: "renders" }).click();
  await expect(tiles).toHaveCount(4);
  await ws.getByRole("button", { name: "Close gallery renders" }).click();
  await expect(ws.locator(".tab", { hasText: "renders" })).toHaveCount(0);
  await expect(ws.locator(".tab.active")).toContainText("middle.svg");

  // A folder with no images says so.
  await ws.locator(".tree").getByText("empty").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show as Gallery" }).click();
  await expect(ws.locator(".gallery .empty")).toContainText("No images in empty");
  expect(await cspViolations(page)).toEqual([]);
});
