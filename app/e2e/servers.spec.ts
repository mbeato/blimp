// The Home tab's server and the server list on its chevron, Add server and Manage servers.
// The browser build reaches only the blimpd in its URL, so every server saved here is that one:
// enough for the list, its names and its states.

import { expect, test, type Page } from "@playwright/test";
import { fixtureDir, killSession, openApp, openSessionTab, startSession } from "./helpers";

const session = `blimpe2e-servers-${process.pid}`;
test.beforeAll(() => startSession(session, fixtureDir("servers")));
test.afterAll(() => killSession(session));

const switcher = (page: Page) => page.getByRole("button", { name: "Servers", exact: true });
const homeServer = (page: Page) => page.locator(".ptab.home .ptab-home-server");
// Home's server and its state (the dot's shape) as one string, e.g. "localhost, connected".
const shown = (page: Page) =>
  page.locator(".ptab.home").evaluate((t) => `${t.querySelector(".ptab-home-server")!.textContent}, ${t.querySelector(".srv-dot")!.className.replace(/.*srv-/, "")}`);
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("blimp.servers") ?? "null"));

// The saved list before the app loads; kept over a reload once the app has saved its own.
const seed = (page: Page, list: object[]) =>
  page.addInitScript((l) => localStorage.getItem("blimp.servers") ?? localStorage.setItem("blimp.servers", JSON.stringify(l)), list);

test("the Home tab shows its server; its chevron's menu lists it with its sessions, and Add server refuses one already saved", async ({ page }) => {
  const dir = fixtureDir("servers");
  await openSessionTab(page, dir);
  await expect.poll(() => shown(page)).toBe("localhost, connected");
  const home = page.locator(".ptabs").getByRole("tab", { name: "Home", exact: true });

  // The chevron opens the list and leaves the project tab in front.
  await switcher(page).click();
  await expect(switcher(page)).toHaveAttribute("aria-expanded", "true");
  await expect(home).toHaveAttribute("aria-selected", "false");
  const menu = page.getByRole("menu", { name: "Servers" });
  const row = menu.getByRole("menuitem", { name: /localhost/ });
  await expect(row).toHaveAttribute("aria-current", "true");
  await expect(row).toContainText(/\d+ sessions?$/);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(switcher(page)).toBeFocused();

  // A click outside closes it too, and doesn't go to the tab under it.
  await switcher(page).click();
  const box = (await home.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + 4);
  await expect(menu).toHaveCount(0);
  await expect(switcher(page)).toBeFocused();
  await expect(home).toHaveAttribute("aria-selected", "false");

  await switcher(page).click();
  await menu.getByRole("menuitem", { name: "Add server…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add a server" })).toBeVisible();
  await dialog.getByLabel("Host").fill("localhost");
  await dialog.getByRole("button", { name: "Add server", exact: true }).click();
  await expect(dialog.locator(".dialog-error")).toHaveText("This server is already in your list.");
  await expect(dialog).toBeVisible();
});

test("a new server is tried first, then saved under its name, and its Home comes forward", async ({ page }) => {
  await openApp(page);
  await expect.poll(() => shown(page)).toBe("localhost, connected");
  await switcher(page).click();
  await page.getByRole("menuitem", { name: "Add server…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Host").fill("second");
  await dialog.getByLabel("Name").fill("Second box");
  await dialog.getByRole("button", { name: "Add server", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => shown(page)).toBe("Second box, connected");
  expect(await saved(page)).toEqual([{ host: "localhost" }, { host: "second", name: "Second box" }]);
});

test("Manage servers: a new name shows on Home and on the tabs, the address stays; Remove asks first", async ({ page }) => {
  await seed(page, [{ host: "localhost" }, { host: "other" }]);
  const dir = fixtureDir("servers");
  await openSessionTab(page, dir);
  await expect(page.locator(".ptab.active .ptab-server")).toHaveText("localhost");

  await switcher(page).click();
  await expect(page.getByRole("menu", { name: "Servers" }).getByRole("menuitem")).toHaveCount(4);
  await page.getByRole("menuitem", { name: "Manage servers…" }).click();
  const dialog = page.locator(".dialog.servers");
  const first = dialog.locator(".srv-block").first();
  await first.getByLabel("Name").fill("Lab");
  await first.getByLabel("Name").press("Enter");
  await expect.poll(() => shown(page)).toBe("Lab, connected");
  await expect(page.locator(".ptab.active .ptab-server")).toHaveText("Lab");
  await expect(first.locator(".srv-address")).toHaveText("localhost");
  await expect(first.locator(".srv-state")).toContainText(/^connected · blimpd \S+ · \d+ sessions?$/);

  const other = dialog.locator(".srv-block").nth(1);
  await other.getByRole("button", { name: "Remove…" }).click();
  await expect(other).toContainText("Remove other? Its tabs close. Sessions on the server keep running.");
  await other.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog.locator(".srv-block")).toHaveCount(2);
  await other.getByRole("button", { name: "Remove…" }).click();
  await other.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog.locator(".srv-block")).toHaveCount(1);
  expect(await saved(page)).toEqual([{ host: "localhost", name: "Lab" }]);
  await page.keyboard.press("Escape");
  // One server left: the project tabs no longer name it, but Home does.
  await expect(page.locator(".ptab-server")).toHaveCount(0);
  await expect(homeServer(page)).toHaveText("Lab");

  await page.reload();
  await expect.poll(() => shown(page)).toBe("Lab, connected");
});

test("Manage servers: a name typed and then left with Esc or a click outside is saved", async ({ page }) => {
  await seed(page, [{ host: "localhost" }]);
  await openApp(page);
  await expect.poll(() => shown(page)).toBe("localhost, connected");
  const dialog = page.locator(".dialog.servers");
  const name = dialog.locator(".srv-block").first().getByLabel("Name");

  await switcher(page).click();
  await page.getByRole("menuitem", { name: "Manage servers…" }).click();
  await name.fill("Lab");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(homeServer(page)).toHaveText("Lab");
  expect(await saved(page)).toEqual([{ host: "localhost", name: "Lab" }]);

  await switcher(page).click();
  await page.getByRole("menuitem", { name: "Manage servers…" }).click();
  await expect(name).toHaveValue("Lab");
  await name.fill("Lab two");
  // The dimmed area around the sheet.
  await page.mouse.click(8, 450);
  await expect(dialog).toHaveCount(0);
  await expect(homeServer(page)).toHaveText("Lab two");
  expect(await saved(page)).toEqual([{ host: "localhost", name: "Lab two" }]);
});

test("with several servers saved, ⌘K says which server each session is on", async ({ page }) => {
  await seed(page, [{ host: "localhost", name: "Lab" }, { host: "other" }]);
  const dir = fixtureDir("servers");
  await openSessionTab(page, dir);
  await page.keyboard.press("Meta+k");
  const palette = page.locator(".dialog.palette");
  await expect(palette.locator(".list-side", { hasText: "Lab · ~/servers" }).first()).toBeVisible();
  await expect(palette.locator(".list-side", { hasText: "other · ~/servers" }).first()).toBeVisible();
});
