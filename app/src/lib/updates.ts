// The Mac app updating itself from GitHub releases (Tauri's updater plugin; tauri.conf.json has
// the address of latest.json and the public key every update must be signed with), and
// blimpd on a server catching up with the app (update_server in src-tauri/src/tunnel.rs).

import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./connection";

export type AppUpdate = { version: string; install: (progress: (done: number, total: number) => void) => Promise<void> };

// null: no newer version (or not the Mac app).
export async function checkForUpdate(): Promise<AppUpdate | null> {
  if (!inTauri()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const u = await check();
  if (!u) return null;
  return {
    version: u.version,
    install: async (progress) => {
      let total = 0;
      let done = 0;
      await u.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") progress((done += e.data.chunkLength), total);
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

// blimp > Check for Updates… in the menu bar.
export async function onCheckForUpdates(fn: () => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen("check-updates", () => fn());
}

// Runs the latest release's install.sh on the server. Resolves to its last lines.
export const updateServer = (server: string) => invoke<string>("update_server", { server });

export const canUpdate = inTauri;
