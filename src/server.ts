// The HTTP + WebSocket API (docs/DESIGN.md). It listens only on a unix socket that only you can open;
// the app reaches it through `ssh -L`. The forwarded port on the Mac is open to anything there,
// web pages included, so every request also needs the token.

import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import pkg from "../package.json";
import { answerOnce } from "./answer";
import { newScan, readLast } from "./chat";
import { browserTabs, closeTab, hasTab, onBrowserChange, openTab, startBrowserGate, viewTab } from "./browser/service";
import { type ChatData, chatData, chatMessage, closeChat, openChat } from "./chatsocket";
import { browserMessage, closeEvents, type EventsData, eventsData, eventsMessage, openEvents } from "./events";
import { createFile, download, guard, guardFile, HttpError, listDir, listFiles, makeDir, MAX_UPLOAD, readFile, realHome, upload, writeFile } from "./files";
import { conversations, projectFolderName, recentFolders, resumedKind } from "./folders";
import { CLAUDE_KINDS, installed, launchFor, listKinds, readKindsFile, removeZaiKey, setZaiKey, zaiKey } from "./kinds";
import { askHandoff, startHandoffs } from "./handoff";
import { startNaming } from "./names";
import { startDigests } from "./digests";
import { startNotes } from "./notes";
import { sessionPorts } from "./ports";
import { cleanText } from "./prompt";
import { checkCommand, sendResult, startRun } from "./runs";
import { markSeen, startSeen } from "./seen";
import {
  checkZmxDir,
  claudeDir,
  isSafeName,
  killSession,
  listSessions,
  parseZmxList,
  realDir,
  sessionExists,
  socketPath,
  startSession,
  transcriptPath,
  transcriptTitles,
  zmxListAsync,
} from "./sessions";
import { type AttachData, attachMessage, closeAttach, openAttach, termSize } from "./terminal";

// A live view of a server browser tab (browser/view.ts): input waits in queue until it's open.
type ViewData = { kind: "view"; id: string; view?: Awaited<ReturnType<typeof viewTab>>; queue: string[]; gone?: boolean };
// `phone`: the phone token a socket came in with. It is closed once that token is gone (see serve).
type WsData = (AttachData | EventsData | ChatData | ViewData) & { phone?: string };

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

// <socket dir>/phone-token, made by `blimpd pair` and deleted by `blimpd pair --revoke`. Read on every
// request, so a revoke takes effect at once. Missing or empty: "", which matches nothing.
export function readPhoneToken(dir: string): string {
  try {
    return readFileSync(join(dir, "phone-token"), "utf8").trim();
  } catch {
    return "";
  }
}

const same = (given: Buffer, token: string) => {
  const want = Buffer.from(token);
  return token !== "" && given.length === want.length && timingSafeEqual(given, want);
};

// Which token the request carries: the Mac's, the phone's (its value), or neither (undefined).
function authorized(req: Request, url: URL, token: string, dir: string): "mac" | { phone: string } | undefined {
  // HTTP sends a Bearer header; WebSockets can't, so they send ?token=.
  const h = req.headers.get("authorization");
  const given = Buffer.from(h?.startsWith("Bearer ") ? h.slice(7) : (url.searchParams.get("token") ?? ""));
  const phone = readPhoneToken(dir);
  // Both compared every time, so the answer takes as long whichever matched.
  const [mac, ph] = [same(given, token), same(given, phone)];
  return mac ? "mac" : ph ? { phone } : undefined;
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

async function bodyPath(req: Request): Promise<string> {
  const { path } = (await req.json()) as Record<string, unknown>;
  if (typeof path !== "string") throw new HttpError(400, "path is required");
  return path;
}

async function route(req: Request, url: URL, server: Server, phone?: string): Promise<Response | undefined> {
  const { pathname: path, searchParams: q } = url;
  const get = req.method === "GET";
  const upgrade = (data: WsData) => server.upgrade(req, { data: Object.assign(data, { phone }) });

  if (path === "/health" && get) return Response.json({ version: pkg.version, home: realHome() });

  if (path === "/sessions" && get) return Response.json(listSessions(claudeDir(), await zmxListAsync()));
  if (path === "/sessions" && req.method === "POST") {
    const { dir, name, resume, shell, kind, prompt } = (await req.json()) as Record<string, unknown>;
    if (typeof dir !== "string") throw new HttpError(400, "dir is required");
    if (name !== undefined && typeof name !== "string") throw new HttpError(400, "name must be a string");
    if (resume !== undefined && (typeof resume !== "string" || !/^[0-9a-f-]{36}$/.test(resume)))
      throw new HttpError(400, "resume must be a conversation id");
    if (shell !== undefined && typeof shell !== "boolean") throw new HttpError(400, "shell must be true or false");
    if (kind !== undefined && typeof kind !== "string") throw new HttpError(400, "kind must be a string");
    if (shell && kind !== undefined && kind !== "shell") throw new HttpError(400, "shell: true and a kind other than shell");
    if (prompt !== undefined && (typeof prompt !== "string" || prompt.length > 100_000 || !cleanText(prompt).trim()))
      throw new HttpError(400, "prompt must be text of at most 100 000 characters");
    const real = guard(dir);
    if (!isDir(real)) throw new HttpError(400, `not a folder: ${dir}`);
    // shell: true is what the app sent before kinds. A resume without a kind goes on in the one it ran in.
    const k = shell ? "shell" : (kind ?? (resume ? resumedKind(real, resume, claudeDir(), readKindsFile().glm) : "claude"));
    if (resume && !CLAUDE_KINDS.includes(k)) throw new HttpError(400, "only Claude Code can resume a conversation");
    if (prompt !== undefined && !CLAUDE_KINDS.includes(k)) throw new HttpError(400, "only Claude Code takes a first message");
    const run = await launchFor(k, resume);
    // Claude's first message, as an argument after "--", so one that starts with "-" isn't taken for an option.
    if (typeof prompt === "string") run.args.push("--", cleanText(prompt));
    return Response.json({ name: await startSession(real, { name: name || undefined, kind: k, run }) }, { status: 201 });
  }

  // Run a command Claude handed over, in a session of its own beside Claude's; then its result back to Claude.
  if (path === "/runs" && req.method === "POST") {
    const { session, command } = ((await req.json()) ?? {}) as Record<string, unknown>;
    if (typeof session !== "string") throw new HttpError(400, "session is required");
    const cmd = checkCommand(command);
    const parent = listSessions(claudeDir(), await zmxListAsync()).find((s) => s.name === session);
    if (!parent) throw new HttpError(404, `no session named ${session}`);
    return Response.json({ name: await startRun(parent, cmd) }, { status: 201 });
  }
  const runSend = path.match(/^\/runs\/([^/]+)\/send$/);
  if (runSend && req.method === "POST") {
    const name = decodeURIComponent(runSend[1]);
    if (!isSafeName(name)) throw new HttpError(404, `no run named ${name}`);
    await sendResult(name);
    return new Response(null, { status: 204 });
  }

  if (path === "/kinds" && get) return Response.json(listKinds(await installed()));
  // Keys go in, never out: GET /keys only says whether there is one.
  if (path === "/keys" && get) return Response.json({ zai: !!zaiKey() });
  if (path === "/keys/zai" && req.method === "PUT") {
    setZaiKey(((await req.json()) as Record<string, unknown> | null)?.key);
    return new Response(null, { status: 204 });
  }
  if (path === "/keys/zai" && req.method === "DELETE") {
    removeZaiKey();
    return new Response(null, { status: 204 });
  }

  const one = path.match(/^\/sessions\/([^/]+)$/);
  if (one && req.method === "DELETE") {
    const name = decodeURIComponent(one[1]);
    if (!isSafeName(name) || !(await sessionExists(name))) throw new HttpError(404, `no session named ${name}`);
    await killSession(name);
    return new Response(null, { status: 204 });
  }

  // Continue in a new session: Claude writes a handoff, then a new session reads it (handoff.ts).
  const handoff = path.match(/^\/sessions\/([^/]+)\/handoff$/);
  if (handoff && req.method === "POST") return Response.json(await askHandoff(decodeURIComponent(handoff[1])), { status: 202 });

  const attach = path.match(/^\/sessions\/([^/]+)\/attach$/);
  if (attach && get) {
    const name = decodeURIComponent(attach[1]);
    // `zmx attach` would create a missing session, so check first.
    if (!(await sessionExists(name))) throw new HttpError(404, `no session named ${name}`);
    const data: AttachData = { kind: "attach", name, ...termSize(q.get("cols"), q.get("rows")) };
    if (upgrade(data)) return;
    throw new HttpError(400, "expected a WebSocket");
  }

  const chat = path.match(/^\/sessions\/([^/]+)\/chat$/);
  if (chat && get) {
    const name = decodeURIComponent(chat[1]);
    if (!isSafeName(name) || !(await sessionExists(name))) throw new HttpError(404, `no session named ${name}`);
    if (upgrade(chatData(name))) return;
    throw new HttpError(400, "expected a WebSocket");
  }

  // Answering what Claude asks without a chat socket (answer.ts): the chat's answer {at, pick, label} or
  // {at, answers, labels}, {stop: true[, at]} for its interrupt, {deny: true, at, text} for no and why.
  // An id makes a retry safe: one already typed is answered again without typing.
  const ans = path.match(/^\/sessions\/([^/]+)\/answer$/);
  if (ans && req.method === "POST") {
    const name = decodeURIComponent(ans[1]);
    const b = (await req.json()) as any;
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "expected an answer");
    if (b.id !== undefined && (typeof b.id !== "string" || !b.id || b.id.length > 100)) throw new HttpError(400, "id must be a string of 1 to 100 characters");
    if (!isSafeName(name)) throw new HttpError(404, `no session named ${name}`);
    if (b.stop !== true && b.deny !== true && !Number.isInteger(b.pick) && !Array.isArray(b.answers))
      throw new HttpError(400, "expected an answer: pick, answers, stop or deny");
    const id: string = b.id ?? randomUUID();
    await answerOnce(name, id, b.stop === true ? { type: "interrupt", at: b.at } : b.deny === true ? { type: "deny", at: b.at, text: b.text } : { ...b, type: "answer" });
    return Response.json({ id });
  }

  if (path === "/events" && get) {
    if (upgrade(eventsData())) return;
    throw new HttpError(400, "expected a WebSocket");
  }

  // The server browser's tabs (browser/service.ts): all of them, or one folder's.
  if (path === "/browser/tabs" && get) {
    const dir = q.get("dir");
    const real = dir === null ? null : guard(dir);
    return Response.json(browserTabs().filter((t) => real === null || t.folder === real));
  }
  if (path === "/browser/tabs" && req.method === "POST") {
    const { dir, url } = (await req.json()) as Record<string, unknown>;
    if (typeof dir !== "string") throw new HttpError(400, "dir is required");
    if (typeof url !== "string" || !/^https?:\/\/[^/\s]+/i.test(url)) throw new HttpError(400, "url must be an http or https address");
    const real = guard(dir);
    if (!isDir(real)) throw new HttpError(400, `not a folder: ${dir}`);
    return Response.json({ id: await openTab(real, url) }, { status: 201 });
  }
  const view = path.match(/^\/browser\/tabs\/([^/]+)\/view$/);
  if (view && get) {
    const id = decodeURIComponent(view[1]);
    if (!hasTab(id)) throw new HttpError(404, "no such browser tab");
    // Through upgrade(), so a view the phone opened closes when its token is revoked.
    if (upgrade({ kind: "view", id, queue: [] })) return;
    throw new HttpError(400, "expected a WebSocket");
  }
  const tab = path.match(/^\/browser\/tabs\/([^/]+)$/);
  if (tab && req.method === "DELETE") {
    await closeTab(decodeURIComponent(tab[1]));
    return new Response(null, { status: 204 });
  }

  if (path === "/ports" && get) return Response.json(await sessionPorts(parseZmxList(await zmxListAsync())));
  if (path === "/folders/recent" && get) return Response.json(recentFolders());
  if (path === "/conversations" && get) {
    const dir = q.get("dir");
    if (!dir) throw new HttpError(400, "dir is required");
    return Response.json(conversations(dir));
  }
  // A past conversation's messages, as the chat's history, without starting Claude.
  const past = path.match(/^\/conversations\/([0-9a-f-]{36})\/messages$/);
  if (past && get) {
    const dir = q.get("dir");
    if (!dir) throw new HttpError(400, "dir is required");
    const real = realDir(guard(dir));
    const file = join(claudeDir(), "projects", projectFolderName(real), `${past[1]}.jsonl`);
    if (!existsSync(file)) throw new HttpError(404, "no such conversation in that folder");
    return Response.json(await readLast(file, newScan(real), 200));
  }
  // The conversation was on screen in an app: its replies so far are seen, in both apps.
  if (path === "/seen" && req.method === "POST") {
    const { sessionId } = ((await req.json()) ?? {}) as Record<string, unknown>;
    if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(sessionId)) throw new HttpError(400, "sessionId must be a conversation id");
    const file = transcriptPath(claudeDir(), sessionId);
    const replied = file ? transcriptTitles(file)?.replied : undefined;
    if (replied) markSeen(sessionId, replied);
    return new Response(null, { status: 204 });
  }

  if (path === "/fs/list" && get) {
    const p = q.get("path");
    return Response.json({ ...listDir(guard(p)), path: resolve(p!) });
  }
  if (path === "/fs/file" && get) return readFile(guardFile(q.get("path")));
  if (path === "/fs/file" && req.method === "PUT") {
    const real = guardFile(q.get("path"));
    const base = q.get("baseMtime");
    if (base !== null && !Number.isFinite(Number(base))) throw new HttpError(400, "baseMtime must be a number");
    const body = new Uint8Array(await req.arrayBuffer());
    return Response.json(writeFile(real, body, base === null ? undefined : Number(base)));
  }
  if (path === "/fs/download" && get) return download(guardFile(q.get("path")), req.signal);
  if (path === "/fs/upload" && req.method === "PUT") {
    const r = await upload(guardFile(q.get("path")), req.body, q.get("mode") ?? "new", Number(req.headers.get("content-length") ?? 0));
    return Response.json(r, { status: 201 });
  }
  if (path === "/fs/mkdir" && req.method === "POST") return Response.json(makeDir(guard(await bodyPath(req))), { status: 201 });
  if (path === "/fs/create" && req.method === "POST") return Response.json(createFile(guardFile(await bodyPath(req))), { status: 201 });
  if (path === "/fs/files" && get) {
    const root = guard(q.get("root"));
    if (!isDir(root)) throw new HttpError(400, "root must be a folder");
    return Response.json(await listFiles(root));
  }

  return error(404, "not found");
}

function openViewSocket(ws: ServerWebSocket<ViewData>) {
  Promise.resolve()
    .then(() => viewTab(ws.data.id, { send: (d) => void ws.send(d), close: (code, reason) => ws.close(code, reason) }))
    .then(
      (v) => {
        if (ws.data.gone) return v.close();
        ws.data.view = v;
        for (const m of ws.data.queue.splice(0)) v.message(m);
      },
      (e) => ws.close(1011, String((e as Error).message).slice(0, 120)),
    );
}

export function serve(): Server {
  checkZmxDir(); // refuse to start, rather than fail every zmx call later
  const sock = socketPath();
  mkdirSync(dirname(sock), { recursive: true });
  chmodSync(dirname(sock), 0o700);
  rmSync(sock, { force: true });
  const dir = dirname(sock);
  const token = loadToken(dir);
  startSeen();
  // Sockets opened with the phone token close within a second of `blimpd pair --revoke` (or a new pair).
  const phoneSockets = new Set<ServerWebSocket<WsData>>();
  setInterval(() => {
    if (!phoneSockets.size) return;
    const now = readPhoneToken(dir);
    for (const ws of phoneSockets) if (ws.data.phone !== now) ws.close(4001, "token revoked");
  }, 1000);
  const server = Bun.serve<WsData>({
    unix: sock,
    // Uploads stream to disk; the cap itself is checked as they go (files.ts).
    maxRequestBodySize: MAX_UPLOAD + 1024 * 1024,
    async fetch(req, server) {
      // Preflights carry no token. `*` is safe because the token isn't a cookie.
      if (req.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          },
        });
      const url = new URL(req.url);
      // No CORS header on a 401: any web page could read it and learn that this port is blimp.
      const who = authorized(req, url, token, dir);
      if (!who) return error(401, "wrong or missing token");
      let res: Response | undefined;
      try {
        res = await route(req, url, server, who === "mac" ? undefined : who.phone);
      } catch (e) {
        res = errorResponse(e);
      }
      res?.headers.set("Access-Control-Allow-Origin", "*");
      return res;
    },
    websocket: {
      open(ws) {
        if (ws.data.phone) phoneSockets.add(ws);
        if (ws.data.kind === "attach") openAttach(ws as any);
        else if (ws.data.kind === "chat") openChat(ws as any);
        else if (ws.data.kind === "view") openViewSocket(ws as any);
        else openEvents(ws as any, server);
      },
      message(ws, msg) {
        if (ws.data.kind === "attach") attachMessage(ws as any, msg);
        else if (ws.data.kind === "chat") chatMessage(ws as any, msg);
        else if (ws.data.kind === "view") {
          const d = ws.data;
          if (d.view) d.view.message(String(msg));
          else d.queue.push(String(msg));
        } else eventsMessage(ws as any, msg);
      },
      close(ws) {
        phoneSockets.delete(ws);
        if (ws.data.kind === "attach") closeAttach(ws as any);
        else if (ws.data.kind === "chat") closeChat(ws as any);
        else if (ws.data.kind === "view") {
          ws.data.gone = true;
          ws.data.view?.close();
        } else closeEvents(ws as any);
      },
    },
  });
  chmodSync(sock, 0o600);
  onBrowserChange(() => server.publish("sessions", browserMessage()));
  // Without it, sessions just don't get the browser.
  startBrowserGate().catch((e) => console.log(`browser: ${(e as Error).message}`));
  startNaming(); // off with {"names": false} in <socket dir>/config.json
  startNotes(); // the same switch
  startDigests(); // and again
  startHandoffs();
  console.log(`blimpd ${pkg.version} listening on ${sock}`);
  return server;
}
