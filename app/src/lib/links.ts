// Web links from the terminal and the Markdown preview open in the system browser, and only web
// links: a link Claude prints or a file contains could be anything (file:, javascript:, a custom
// app scheme).

import { inTauri } from "./connection";

// The link as an http or https URL, or null for anything else.
export function webUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

export function openWebLink(href: string) {
  const url = webUrl(href);
  if (!url) return;
  if (inTauri()) void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(url)).catch(() => {});
  else window.open(url, "_blank", "noopener");
}

const isMac = () => typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

// As in the VS Code terminal, a terminal link opens on ⌘-click (Ctrl-click off the Mac), so a
// plain click near a link can still select text.
export const followsLink = (e: { metaKey: boolean; ctrlKey: boolean }, mac = isMac()) => (mac ? e.metaKey : e.ctrlKey);
