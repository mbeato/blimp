// What blimpd answers for /visuals/<key>/<rest> once the key checks out (server.ts): a visual's page, a file that
// came with it, or a file of blimp's kit. The page's headers lock it down (docs/superpowers/specs/
// 2026-10-26-visuals-design.md, 2026-11-15-visuals-3d-design.md): it may run its own scripts, load the kit and read
// the files of its own copy, and nothing else; no other requests, no frames, no forms; and `sandbox` gives it an
// origin of its own, so it can't read cookies or storage, open windows or move the page around it.

import { extname } from "node:path";
import { kitFile } from "./kit";
import { visualFile, visualPage } from "./store";

// The policy with no folder named: the page runs and loads the kit, and reads no files.
export const PAGE_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";

// The policy for the visual `id` asked for at `host` with `key`: scripts from its own folder and the kit, images and
// requests from its own folder (and blob:, which three.js reads a model's textures through). Each is written with
// both schemes: WebKit matches no source without one under `sandbox`, and blimpd can't tell whether a proxy added
// TLS. A Host that isn't a plain host and port names nothing, so the page gets the policy above.
export function pageCsp(host: string | null, key: string, id: string): string {
  if (!host || !/^[A-Za-z0-9.:\[\]-]+$/.test(host)) return PAGE_CSP;
  const both = (path: string) => `http://${host}/visuals/${key}/${path} https://${host}/visuals/${key}/${path}`;
  const own = both(`${id}/`);
  return `default-src 'none'; script-src 'unsafe-inline' ${own} ${both("kit/")}; style-src 'self' 'unsafe-inline'; img-src data: blob: ${own}; font-src data:; connect-src ${own} blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts`;
}

const SAME = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
// The page's origin is `null` (from `sandbox`), so its modules and requests are cross-origin: the kit and a copy's
// files say anyone may read them. The address holds the visual key, so only what already has the key can ask.
const OPEN = { "Access-Control-Allow-Origin": "*" };
// A copy never changes. The kit changes with blimpd and its paths carry no version, so it's kept an hour: the Mac's
// web view keeps its cache on disk, and an updated blimpd's kit reaches it within the hour.
const PAGE_CACHE = "private, max-age=2592000, immutable";
const KIT_CACHE = "private, max-age=3600";

const HTML = "text/html; charset=utf-8";
const TYPES: Record<string, string> = {
  ".html": HTML,
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".gltf": "model/gltf+json",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

export async function visualResponse(key: string, rest: string, req: Request): Promise<Response> {
  if (rest.startsWith("kit/")) {
    const f = await kitFile(rest.slice(4));
    if (!f) return notFound();
    const gzip = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
    return new Response(gzip ? f.gzipped : f.bytes, { headers: { ...SAME, ...OPEN, "Cache-Control": KIT_CACHE, "Content-Type": f.type, ...(gzip && { "Content-Encoding": "gzip" }) } });
  }
  // <id> (an app from before a visual could be a folder) and <id>/ are the page; <id>/<path> is a file beside it.
  const [, id, slash, path] = /^([0-9a-f]{12})(\/?)(.*)$/.exec(rest) ?? [];
  if (!id || (path && !slash)) return notFound();
  const headers = { ...SAME, "Cache-Control": PAGE_CACHE, "Content-Security-Policy": pageCsp(req.headers.get("host"), key, id) };
  if (!path) {
    const page = visualPage(id);
    return page ? new Response(page, { headers: { ...headers, "Content-Type": HTML } }) : notFound();
  }
  // The page's kit/... paths land in its folder; every visual shares the one kit, and its one cached copy.
  if (path.startsWith("kit/")) return new Response(null, { status: 307, headers: { ...SAME, ...OPEN, Location: `/visuals/${key}/${path}` } });
  let file: string | undefined;
  try {
    file = visualFile(id, decodeURIComponent(path));
  } catch {} // not percent-encoding
  if (!file) return notFound();
  return new Response(Bun.file(file), { headers: { ...headers, ...OPEN, "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" } });
}
