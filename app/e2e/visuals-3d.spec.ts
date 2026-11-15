// Visuals in 3D: a folder a session showed (its page as index.html, a model and a data file beside it) opens in the
// same locked-down frame; its page draws with the kit's three.js and reads the files it came with, and nothing else:
// not blimpd, not a website, not another visual.

import { cpSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { cspViolations, e2e, fixtureDir, frontTab, killSession, openSessionTab, startSession } from "./helpers";

// The other specs run with no WebGL, so the terminal's text can be read (playwright.config.ts). This one draws.
test.use({ launchOptions: { args: [] } });

const name = `blimpe2e-visual3d-${process.pid}`;
test.afterAll(() => killSession(name));

// What the show tool does for a session (visuals/mcp.ts): POST /visuals with the Mac's token.
async function show(session: string, path: string, title: string) {
  const { base, token } = e2e();
  const r = await fetch(`${base}/visuals`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session, path, title }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

test("a folder's page draws in 3D with the kit's three.js and reads its own files, and no other visual's", async ({ page }) => {
  const dir = fixtureDir("visuals-3d");
  cpSync(join(import.meta.dirname, "../../test/fixtures/visual-3d"), join(dir, "flat"), { recursive: true });
  startSession(name, dir);
  await openSessionTab(page, dir);
  const other = await show(name, join(dir, "flat"), "Another flat");
  const id = await show(name, join(dir, "flat"), "The flat in 3D");
  const wb = frontTab(page);
  await expect(wb.locator(".visual-tab")).toHaveText(/The flat in 3D/);
  const frame = wb.locator("iframe.visual-view");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("src", new RegExp(`/visuals/[0-9a-f]{64}/${id}/$`));
  const doc = frame.contentFrame();
  await expect(doc.locator("h1")).toHaveText("3D fixture");
  // three.js loaded as modules and drew the box; the model and the data file beside the page were read; blimpd, a
  // website, a path beside its folder and a script from one were not.
  await expect(doc.locator("#out")).toHaveText('{"three":"187","scene":"drawn","model":"3 points, textured","file":"2 rooms","others":"rejected,rejected,rejected,rejected"}', {
    timeout: 20_000,
  });
  // Another visual's files are there to read with the same key, and are refused to this page.
  const inner = page.frames().find((f) => f.url().endsWith(`/${id}/`))!;
  const read = (path: string) => inner.evaluate((p) => fetch(p).then((r) => `read ${r.status}`, () => "refused"), path);
  expect(await read("data.json")).toBe("read 200");
  expect(await read("models/triangle.glb")).toBe("read 200");
  expect(await read(`../${other}/data.json`)).toBe("refused");
  expect(await read(`../${other}/`)).toBe("refused");
  expect(await inner.evaluate((p) => import(p).then(() => "ran", () => "refused"), `../${other}/data.json`)).toBe("refused");
  expect(await cspViolations(page)).toEqual([]);
});
