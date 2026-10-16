// The HTTP + WebSocket API (docs/DESIGN.md). It listens only on a unix socket that only you can open;
// the app reaches it through `ssh -L`. The forwarded port on the Mac is open to anything there,
// web pages included, so every request also needs the token.

import { timingSafeEqual, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Server } from "bun";
import pkg from "../package.json";
import { closeEvents, type EventsData, eventsData, eventsMessage, openEvents } from "./events";
import { guard, HttpError, listDir, listFiles, readFile, realHome, writeFile } from "./files";
import { conversations, recentFolders } from "./folders";
import { claudeDir, listSessions, sessionExists, socketPath, startSession, zmxListAsync } from "./sessions";
import { type AttachData, attachMessage, closeAttach, openAttach, termSize } from "./terminal";

type WsData = AttachData | EventsData;

// <socket dir>/token, made once: 32 random bytes as hex, readable only by you.
export function loadToken(dir: string): string {
  const file = join(dir, "token");
  let token = "";
  try {
    token = readFileSync(file, "utf8").trim();
  } catch {}
  if (!token) writeFileSync(file, (token = randomBytes(32).toString("hex")), { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

function authorized(req: Request, url: URL, token: string): boolean {
  // HTTP sends a Bearer header; WebSockets can't, so they send ?token=.
  const h = req.headers.get("authorization");
  const given = Buffer.from(h?.startsWith("Bearer ") ? h.slice(7) : (url.searchParams.get("token") ?? ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const error = (status: number, message: string, extra = {}) => Response.json({ error: message, ...extra }, { status });

function errorResponse(e: any): Response {
  if (e instanceof HttpError) return error(e.status, e.message, e.extra);
  if (e?.code === "ENOENT") return error(404, "not found");
  if (e?.code === "ENOTDIR" || e?.code === "EISDIR") return error(400, "not a folder, or not a file");
  if (e?.code === "EACCES" || e?.code === "EPERM") return error(403, "permission denied");
  if (e instanceof SyntaxError || e instanceof URIError) return error(400, "bad request");
  return error(500, e?.message ?? String(e));
}

const isDir = (p: string) => statSync(p).isDirectory();

async function route(req: Request, url: URL, server: Server): Promise<Response | undefined> {
  const { pathname: path, searchParams: q } = url;
  const get = req.method === "GET";

  if (path === "/health" && get) return Response.json({ version: pkg.version, home: realHome() });

  if (path === "/sessions" && get) return Response.json(listSessions(claudeDir(), await zmxListAsync()));
  if (path === "/sessions" && req.method === "POST") {
    const { dir, name, resume } = (await req.json()) as Record<string, unknown>;
    if (typeof dir !== "string") throw new HttpError(400, "dir is required");
    if (name !== undefined && typeof name !== "string") throw new HttpError(400, "name must be a string");
    if (resume !== undefined && (typeof resume !== "string" || !/^[0-9a-f-]{36}$/.test(resume)))
      throw new HttpError(400, "resume must be a conversation id");
    const real = guard(dir);
    if (!isDir(real)) throw new HttpError(400, `not a folder: ${dir}`);
    return Response.json({ name: startSession(real, name || undefined, resume) }, { status: 201 });
  }

  const attach = path.match(/^\/sessions\/([^/]+)\/attach$/);
  if (attach && get) {
    const name = decodeURIComponent(attach[1]);
    // `zmx attach` would create a missing session, so check first.
    if (!(await sessionExists(name))) throw new HttpError(404, `no session named ${name}`);
    const data: AttachData = { kind: "attach", name, ...termSize(q.get("cols"), q.get("rows")) };
    if (server.upgrade(req, { data })) return;
    throw new HttpError(400, "expected a WebSocket");
  }

  if (path === "/events" && get) {
    if (server.upgrade(req, { data: eventsData() })) return;
    throw new HttpError(400, "expected a WebSocket");
  }

  if (path === "/folders/recent" && get) return Response.json(recentFolders());
  if (path === "/conversations" && get) {
    const dir = q.get("dir");
    if (!dir) throw new HttpError(400, "dir is required");
    return Response.json(conversations(dir));
  }

  if (path === "/fs/list" && get) {
    const p = q.get("path");
    return Response.json({ ...listDir(guard(p)), path: resolve(p!) });
  }
  if (path === "/fs/file" && get) return readFile(guard(q.get("path")));
  if (path === "/fs/file" && req.method === "PUT") {
    const real = guard(q.get("path"));
    const base = q.get("baseMtime");
    if (base !== null && !Number.isFinite(Number(base))) throw new HttpError(400, "baseMtime must be a number");
    const body = new Uint8Array(await req.arrayBuffer());
    return Response.json(writeFile(real, body, base === null ? undefined : Number(base)));
  }
  if (path === "/fs/files" && get) {
    const root = guard(q.get("root"));
    if (!isDir(root)) throw new HttpError(400, "root must be a folder");
    return Response.json(listFiles(root));
  }

  return error(404, "not found");
}

export function serve(): Server {
  const sock = socketPath();
  mkdirSync(dirname(sock), { recursive: true });
  chmodSync(dirname(sock), 0o700);
  rmSync(sock, { force: true });
  const token = loadToken(dirname(sock));
  const server = Bun.serve<WsData>({
    unix: sock,
    async fetch(req, server) {
      // Preflights carry no token. `*` is safe because the token isn't a cookie.
      if (req.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
          },
        });
      const url = new URL(req.url);
      let res: Response | undefined;
      if (!authorized(req, url, token)) res = error(401, "wrong or missing token");
      else {
        try {
          res = await route(req, url, server);
        } catch (e) {
          res = errorResponse(e);
        }
      }
      res?.headers.set("Access-Control-Allow-Origin", "*");
      return res;
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "attach") openAttach(ws as any);
        else openEvents(ws as any, server);
      },
      message(ws, msg) {
        if (ws.data.kind === "attach") attachMessage(ws as any, msg);
        else eventsMessage(ws as any, msg);
      },
      close(ws) {
        if (ws.data.kind === "attach") closeAttach(ws as any);
        else closeEvents(ws as any);
      },
    },
  });
  chmodSync(sock, 0o600);
  console.log(`blimpd ${pkg.version} listening on ${sock}`);
  return server;
}
