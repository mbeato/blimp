// What blimpd answers for /visuals/<key>/<rest> once the key checks out (server.ts): a visual's page, or a file of
// blimp's kit. The page's headers lock it down (docs/superpowers/specs/2026-10-26-visuals-design.md): it may run its
// own scripts and load the kit from here, and nothing else; no requests, no frames, no forms; and `sandbox` gives
// it an origin of its own, so it can't read cookies or storage, open windows or move the page around it.

import { kitFile } from "./kit";
import { visualPage } from "./store";

export const PAGE_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

const SAME = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
// A copy never changes. The kit changes with blimpd and its paths carry no version, so it's kept an hour: the Mac's
// web view keeps its cache on disk, and an updated blimpd's kit reaches it within the hour.
const PAGE_CACHE = "private, max-age=2592000, immutable";
const KIT_CACHE = "private, max-age=3600";

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

export async function visualResponse(rest: string, req: Request): Promise<Response> {
  if (rest.startsWith("kit/")) {
    const f = await kitFile(rest.slice(4));
    if (!f) return notFound();
    const gzip = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
    return new Response(gzip ? f.gzipped : f.bytes, { headers: { ...SAME, "Cache-Control": KIT_CACHE, "Content-Type": f.type, ...(gzip && { "Content-Encoding": "gzip" }) } });
  }
  const page = visualPage(rest);
  if (!page) return notFound();
  return new Response(page, { headers: { ...SAME, "Cache-Control": PAGE_CACHE, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP } });
}
