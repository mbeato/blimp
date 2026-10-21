// Feature 7: an HTML file shows as a page (in a sandbox: no script, not the app's origin), with
// the images and stylesheets next to it; Edit shows its text. A folder of renders shows as a
// gallery that keeps up as new ones are written.

import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cspViolations, fixtureDir, killSession, openSessionTab, startSession } from "./helpers";

const page1 = `blimpe2e-html-${process.pid}`;
const page2 = `blimpe2e-html2-${process.pid}`;
const gal = `blimpe2e-gallery-${process.pid}`;
const gal2 = `blimpe2e-gallery2-${process.pid}`;

test.afterAll(() => {
  killSession(page1);
  killSession(page2);
  killSession(gal);
  killSession(gal2);
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

const LINKS = `<!doctype html>
<html><head>
<link rel="stylesheet" href="css/bg.css">
<style>#box2 { width: 10px; height: 10px; background-image: url("img/dot.png"); }</style>
</head><body>
<p><a id="toc" href="#end">Jump to the end</a> <a id="rel" href="other.html">Other page</a> <a id="web" href="https://example.invalid/">Web</a></p>
<div id="box" style="width: 10px; height: 10px"></div>
<div id="box2"></div>
<div id="box3" style="width: 10px; height: 10px; background-image: url(img/dot.png)"></div>
<picture><source id="src" srcset="img/dot.png"><img id="pic" src="img/dot.png" alt="pic"></picture>
${'<img class="rep" src="img/dot.png" alt="rep">'.repeat(5)}
${"<p>filler</p>".repeat(300)}
<h2 id="end">The end</h2>
</body></html>
`;

test("an HTML page's links stay in the page, its CSS images come from the server, and each image is read once", async ({ page }) => {
  const dir = fixtureDir("html-links");
  mkdirSync(join(dir, "css"), { recursive: true });
  mkdirSync(join(dir, "img"), { recursive: true });
  writeFileSync(join(dir, "toc.html"), LINKS);
  writeFileSync(join(dir, "other.html"), "<!doctype html><h1>Other</h1>\n");
  // The stylesheet's url() is relative to its own folder; a "</style>" in it can't end the <style> it becomes.
  writeFileSync(join(dir, "css", "bg.css"), '#box { background-image: url(../img/dot.png); }\n#web { background-image: url(https://example.invalid/x.png); }\n/* </style><p id="escaped">out</p> */\n');
  writeFileSync(join(dir, "img", "dot.png"), PNG);
  startSession(page2, dir);

  const reads: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.endsWith("/fs/file")) reads.push(u.searchParams.get("path") ?? "");
  });
  await openSessionTab(page, dir);
  const ws = page.locator(".wb:not([hidden])");
  await ws.locator(".tree").getByText("toc.html").click();
  const doc = ws.locator("iframe.html-view").contentFrame();
  await expect(doc.locator("#toc")).toBeVisible();

  // url() in a stylesheet, a <style> and a style attribute: inlined from the server like <img>.
  for (const id of ["#box", "#box2", "#box3"]) await expect(doc.locator(id)).toHaveCSS("background-image", /^url\("data:image\/png;base64,/);
  await expect(doc.locator("#escaped")).toHaveCount(0);
  // <source> would load from the app's origin: left out, so the <img> in the <picture> shows.
  expect(await doc.locator("#src").getAttribute("srcset")).toBeNull();
  await expect(doc.locator("#pic")).toHaveAttribute("src", /^data:image\/png;base64,/);
  // The same picture, used 9 times, is read from the server once.
  expect(reads.filter((p) => p.endsWith("/img/dot.png"))).toHaveLength(1);

  // A link to a part of the page scrolls to it; the page stays.
  await expect(doc.locator("#end")).not.toBeInViewport();
  await doc.locator("#toc").click();
  await expect(doc.locator("#end")).toBeInViewport();
  await expect(doc.locator("#toc")).toHaveText("Jump to the end");
  // Links that would take the frame elsewhere do nothing.
  expect(await doc.locator("#rel").getAttribute("href")).toBeNull();
  expect(await doc.locator("#web").getAttribute("href")).toBeNull();
  await doc.locator("#rel").click();
  await doc.locator("#web").click();
  await expect(doc.locator("#toc")).toHaveText("Jump to the end");
  expect(await cspViolations(page)).toEqual([]);
});

test("a gallery keeps up when its folder is deleted and made again, and a picture that failed to load loads on the next change", async ({ page }) => {
  const dir = fixtureDir("gallery2");
  const renders = join(dir, "renders");
  rmSync(renders, { recursive: true, force: true });
  mkdirSync(renders);
  writeFileSync(join(renders, "a.png"), PNG);
  startSession(gal2, dir);

  await openSessionTab(page, dir);
  const ws = page.locator(".wb:not([hidden])");
  await ws.locator(".tree").getByText("renders").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show as Gallery" }).click();
  const tiles = ws.locator(".gallery .gallery-tile");
  await expect(tiles.locator(".gallery-name")).toHaveText(["a.png"]);

  // rm -rf renders && mkdir renders, as a render script does: the old tiles go, and new renders show up.
  rmSync(renders, { recursive: true });
  await expect(tiles).toHaveCount(0, { timeout: 5000 });
  await expect(ws.locator(".gallery .view-note")).toBeVisible();
  mkdirSync(renders);
  writeFileSync(join(renders, "b.png"), PNG);
  await expect(tiles.locator(".gallery-name")).toHaveText(["b.png"], { timeout: 5000 });
  await expect(ws.locator(".gallery .view-note")).toHaveCount(0);
  await page.waitForTimeout(500);
  writeFileSync(join(renders, "c.png"), PNG);
  await expect(tiles.locator(".gallery-name")).toHaveText(["c.png", "b.png"], { timeout: 5000 });

  // A picture whose read fails (offline, say) stays blank, and loads again on the next change.
  await page.route(/\/fs\/file\?.*d\.png/, (r) => r.abort());
  writeFileSync(join(renders, "d.png"), PNG);
  await expect(tiles.first().locator(".gallery-name")).toHaveText("d.png", { timeout: 5000 });
  await page.waitForTimeout(500);
  await expect(tiles.first().locator("img")).toHaveCount(0);
  await page.unroute(/\/fs\/file\?.*d\.png/);
  writeFileSync(join(renders, "e.txt"), "not a picture\n");
  await expect(tiles.filter({ hasText: "d.png" }).locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 5000 });
});
