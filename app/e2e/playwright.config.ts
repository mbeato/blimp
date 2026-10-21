// E2E tests: the UI in Chromium against a real blimpd, reached the way the Mac app reaches it
// (an `ssh -N -L` tunnel to its unix socket). Needs bun, zmx and key-based `ssh localhost`
// (or BLIMP_E2E_HOST). Run with `bun run e2e` in app/.

import { defineConfig } from "@playwright/test";

// Not 5173: `tauri dev` holds that one. BLIMP_E2E_PORT: another, for runs side by side.
const PORT = Number(process.env.BLIMP_E2E_PORT) || 5188;

export default defineConfig({
  testDir: ".",
  globalSetup: "./setup.ts",
  // One at a time: the specs share one blimpd, and M3 times how fast "waiting" shows.
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  outputDir: "../test-results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    viewport: { width: 1400, height: 900 },
    // No WebGL, so xterm draws with its DOM renderer and the terminal's text can be read.
    launchOptions: { args: ["--disable-3d-apis"] },
  },
  webServer: {
    command: `bun x vite --port ${PORT} --strictPort`,
    cwd: "..",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
  },
});
