// Give a Secret (a Claude session's right-click): the value goes to the server once, in a request
// body, and Claude is told where it is. It's never in a URL, in localStorage or on the terminal.
// Settings > Models lists the saved names with Remove.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, killSession, openSessionTab, screenText, sessionRow, startSession, zmxEnv } from "./helpers";

const name = `blimpe2e-secret-${process.pid}`;
const VALUE = "sk-e2e-do-not-show-0123456789";

test.afterAll(() => killSession(name));

test("Give a Secret saves the value on the server and tells Claude where it is, never showing it", async ({ page }) => {
  const dir = fixtureDir("secret");
  startSession(name, dir, ["sh", "-c", "exec cat -v", "claude"]);
  // A Claude that blimpd knows (its status file names a conversation): only those get the item.
  const claude = process.env.BLIMP_E2E_CLAUDE!;
  const pid = execFileSync("zmx", ["list"], { env: zmxEnv(), encoding: "utf8" }).match(new RegExp(`name=${name}\\tpid=(\\d+)`))![1];
  mkdirSync(join(claude, "sessions"), { recursive: true });
  writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ sessionId: crypto.randomUUID(), status: "idle" }));
  const secrets = join(dirname(e2e().statusDir), "secrets");

  const urls: string[] = [];
  const bodies: string[] = [];
  page.on("request", (r) => (urls.push(r.url()), bodies.push(`${r.method()} ${new URL(r.url()).pathname} ${r.postData() ?? ""}`)));

  const term = await openSessionTab(page, dir, name);
  await sessionRow(page, name).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Give a Secret…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading")).toContainText("Give a secret to");
  const send = dialog.getByRole("button", { name: "Save and Tell Claude" });
  await expect(send).toBeDisabled();
  await dialog.getByLabel("Name").fill("my-key");
  await expect(dialog.getByText("A name is a letter, then letters, digits or _ (like API_KEY).")).toBeVisible();
  await dialog.getByLabel("Name").fill("API_KEY");
  await dialog.getByLabel("Value").fill(VALUE);
  await expect(dialog.getByLabel("Value")).toHaveAttribute("type", "password");
  await send.click();
  await expect(dialog).toHaveCount(0);

  await expect.poll(() => screenText(term)).toContain("The secret API_KEY is saved in");
  expect(readFileSync(join(secrets, "API_KEY"), "utf8")).toBe(VALUE);
  expect(await screenText(term)).not.toContain(VALUE);
  expect(urls.filter((u) => u.includes(VALUE))).toEqual([]);
  // Sent once, in the body of the PUT; the tell carries only the session.
  expect(bodies.filter((b) => b.includes(VALUE))).toEqual([`PUT /secrets/API_KEY ${JSON.stringify({ value: VALUE })}`]);
  expect(bodies.some((b) => b === `POST /secrets/API_KEY/tell ${JSON.stringify({ session: name })}`)).toBe(true);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain(VALUE);

  // Again: the saved name is offered, and with no value it only tells Claude.
  const notes = async () => (await screenText(term)).split("The secret API_KEY is saved in").length - 1;
  const before = await notes();
  await sessionRow(page, name).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Give a Secret…" }).click();
  await expect(dialog.locator("datalist option")).toHaveAttribute("value", "API_KEY");
  await dialog.getByLabel("Name").fill("API_KEY");
  await expect(dialog.getByLabel("Value")).toHaveValue("");
  await dialog.getByRole("button", { name: "Tell Claude", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(notes).toBeGreaterThan(before);

  // Settings > Models: the name, and Remove takes the file away.
  await page.keyboard.press("Meta+,");
  const settings = page.locator(".dialog.settings");
  await expect(settings.locator(".secrets")).toContainText("API_KEY");
  await settings.getByRole("button", { name: "Remove API_KEY" }).click();
  await expect(settings.locator(".secrets")).toContainText("None yet");
  expect(existsSync(join(secrets, "API_KEY"))).toBe(false);
  expect(await settings.innerText()).not.toContain(VALUE);
});
