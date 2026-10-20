// Browser tabs (components/PageView.tsx): tabs of the server's Chrome, shown live
// (lib/serverview.ts). What's typed in the address bar, and addresses as labels.

// Where a new browser tab starts, and where words typed in the bar go.
export const HOME = "https://www.google.com/";
export const searchUrl = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q.trim())}`;

// What's typed in the bar means: a full URL as is; localhost or a bare host:port over http (the
// server's own, since the browser runs there); anything else that looks like a host over https;
// anything else at all a Google search. null: nothing typed.
export function typedUrl(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/\s/.test(t)) return searchUrl(t);
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/]+:\d+(\/|$)/.test(t)) return searchUrl(t);
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(t) || /^[^/.]+:\d+(\/|$)/.test(t)) return "http://" + t;
  if (/^[^/]+\.[^/]+/.test(t)) return "https://" + t;
  return searchUrl(t);
}

// The server's localhost:<port> reaches this Mac only through a forward (Open in Browser); any
// other address works as it is.
export function serverTabTarget(url: string): { port: number } | { url: string } {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.port) return { port: Number(u.port) };
  } catch {}
  return { url };
}

// An address's host, for a short label; the address itself if it isn't one.
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
