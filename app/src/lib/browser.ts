// Browser tabs (components/PageView.tsx). In the Mac app each is a native web view over the
// tab's area (src-tauri/src/browser.rs); in a browser (development, the e2e tests) a sandboxed
// iframe, which can show only local pages and can't go back or read the page.

import { invoke } from "@tauri-apps/api/core";
import type { Port } from "./api";

export type Page = {
  key: string;
  // A server port: opened at this computer's end of its forward (`base`, lib/ports.ts).
  port?: Pick<Port, "port" | "host">;
  base: string | null;
  // What's loaded, as the view last said; null before an address is given.
  url: string | null;
  title: string;
  loading: boolean;
  error: string;
  // The native view, once open.
  label?: string;
  // Bumped to reload the iframe.
  nonce: number;
};

// What the address bar shows: a port tab's forward as the server's localhost:<port>.
export function shownUrl(page: Pick<Page, "port" | "base">, url: string | null): string {
  if (!url) return "";
  if (page.port && page.base && (url === page.base || url.startsWith(page.base + "/"))) return `localhost:${page.port.port}${url.slice(page.base.length) || "/"}`;
  return url;
}

// Where a new browser tab starts (in the Mac app), and where words typed in the bar go.
export const HOME = "https://www.google.com/";
export const searchUrl = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q.trim())}`;

// What's typed in the bar means: a full URL as is; the port tab's localhost:<port> as its
// forward; another localhost or a bare host:port over http; anything else that looks like a host
// over https; anything else at all a Google search. null: nothing typed.
export function typedUrl(page: Pick<Page, "port" | "base">, text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/\s/.test(t)) return searchUrl(t);
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/]+:\d+(\/|$)/.test(t)) return searchUrl(t);
  if (page.port && page.base) {
    const m = t.match(/^(?:localhost|127\.0\.0\.1):(\d+)(\/.*)?$/);
    if (m && Number(m[1]) === page.port.port) return page.base + (m[2] ?? "/");
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(t) || /^[^/.]+:\d+(\/|$)/.test(t)) return "http://" + t;
  if (/^[^/]+\.[^/]+/.test(t)) return "https://" + t;
  return searchUrl(t);
}

// The tab's title: the page's own, else its host, else what it's on.
export function pageTitle(page: Pick<Page, "port" | "url" | "title">): string {
  if (page.title) return page.title;
  if (page.port) return `localhost:${page.port.port}`;
  try {
    return page.url ? new URL(page.url).host : "New tab";
  } catch {
    return page.url ?? "New tab";
  }
}

// ---- native views ----

export type Rect = { x: number; y: number; w: number; h: number };
// `open`: a link in the view asked for a new window, so a new tab opens at that address.
export type ViewChange = { label: string; url?: string; title?: string; loading?: boolean; open?: string };
export type PageText = { url: string; title: string; text: string; selection: boolean };

export const view = {
  open: (url: string, rect: Rect) => invoke<string>("browser_open", { url, rect }),
  bounds: (label: string, rect: Rect) => invoke("browser_bounds", { label, rect }),
  show: (label: string, shown: boolean) => invoke("browser_show", { label, shown }),
  go: (label: string, url: string) => invoke("browser_go", { label, url }),
  nav: (label: string, action: "back" | "forward" | "reload") => invoke("browser_nav", { label, action }),
  close: (label: string) => invoke("browser_close", { label }),
  read: (label: string) => invoke<PageText>("browser_read", { label }),
};

// What the views of this window say (address, title, loading, a new tab to open). Returns the
// unlisten.
export async function onViewChange(fn: (c: ViewChange) => void): Promise<() => void> {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen<ViewChange>("browser", (e) => fn(e.payload));
}

// What Send to session uploads: a Markdown file with the page's address, title and text.
export function pageFile(p: PageText): string {
  const what = p.selection ? "Selected text" : "Text";
  return `# ${p.title || p.url}\n\n${p.url}\n\n## ${what}\n\n${p.text.trim()}\n`;
}

// A plain file name for it, from the page's host.
export function pageFileName(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/[^A-Za-z0-9.-]/g, "");
  } catch {}
  return host ? `page-${host}.md` : "page.md";
}
