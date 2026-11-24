// The Mac app updating itself from GitHub releases (Tauri's updater plugin; tauri.conf.json has
// the address of latest.json and the public key every update must be signed with), and
// blimpd on a server catching up with the app (update_server in src-tauri/src/tunnel.rs).

import { invoke } from "@tauri-apps/api/core";
import { errorText, inTauri, type Server, type ServerLink } from "./connection";
import { appVersion, compareVersions } from "./version";

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
      // Quits, then opens again once this copy is gone (src-tauri/src/relaunch.rs), so the Dock
      // keeps one icon.
      await invoke("relaunch");
    },
  };
}

// Runs the latest release's install.sh on the server. Resolves to its last lines.
export const updateServer = (server: string) => invoke<string>("update_server", { server });

// The same install.sh, on a server where blimpd isn't set up yet (it has no tunnel to update through),
// or on this Mac (install_local in src-tauri/src/local.rs). Rust asks first in a native dialog;
// false: the person chose Cancel there, which isn't an error.
export const installServer = (s: Server): Promise<boolean> =>
  (s.local ? invoke<string>("install_local") : invoke<string>("install_server", { host: s.host, user: s.user, port: s.port })).then(
    () => true,
    (e) => (errorText(e) === "Cancelled." ? false : Promise.reject(e)),
  );

export const canUpdate = inTauri;

// A connected server whose blimpd is older than this app.
export const blimpdBehind = (l: ServerLink) => l.status === "connected" && !!l.version && compareVersions(l.version, appVersion) < 0;

// Update server (the update bars, Manage servers): says how it went, and the link sees blimpd
// restart and reconnects to the new one.
export async function updateLink(l: ServerLink, notice: (msg: string) => void) {
  try {
    await updateServer(l.key);
    notice(`blimpd on ${l.name} is updated.`);
    l.retryNow();
  } catch (e) {
    notice(errorText(e));
  }
}
