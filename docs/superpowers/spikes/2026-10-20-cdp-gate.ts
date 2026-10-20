// SPIKE (throwaway): a CDP gate over Chrome's debugging pipe. Each WebSocket client at /s/<folder>
// sees a virtual browser holding only that folder's page targets.
import { spawn } from "node:child_process";
import type { ServerWebSocket } from "bun";

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string };
type Client = { ws: ServerWebSocket<{ folder: string }>; folder: string; discover: boolean; autoAttach: boolean; sessions: Set<string> };
type Target = { info: any; folder: string | null; announced: boolean; seen: boolean };

const chromePath = `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`;
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${import.meta.dir}/profile`, "--no-first-run", ...(process.env.FLAGS ?? "").split(" ").filter(Boolean), "about:blank"], {
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
});
const toChrome = chrome.stdio[3] as any;
const fromChrome = chrome.stdio[4] as any;

let nextId = 1;
const pending = new Map<number, { client?: Client; orig?: number; done?: (m: Msg) => void; after?: (m: Msg) => void }>();
const targets = new Map<string, Target>();
const owners = new Map<string, Client>(); // sessionId -> client
const attachFor = new Map<string, Client[]>(); // targetId -> clients waiting for attachedToTarget
const clients = new Set<Client>();
export const log: string[] = [];

function raw(m: Msg) {
  toChrome.write(JSON.stringify(m) + "\0");
}
function call(method: string, params: any = {}, sessionId?: string): Promise<Msg> {
  return new Promise((done) => {
    const id = nextId++;
    pending.set(id, { done });
    raw({ id, method, params, ...(sessionId && { sessionId }) });
  });
}
function forward(c: Client, m: Msg, after?: (r: Msg) => void) {
  const id = nextId++;
  pending.set(id, { client: c, orig: m.id, after });
  raw({ ...m, id });
}
const send = (c: Client, m: Msg) => (trace(c, "<", m), c.ws.send(JSON.stringify(m)));
import { appendFileSync } from "node:fs";
const trace = (c: Client, dir: string, m: Msg) => process.env.TRACE && appendFileSync(`${import.meta.dir}/trace-${c.folder}.log`, `${dir} ${JSON.stringify(m).slice(0, 400)}\n`);
const reply = (c: Client, m: Msg, result: any) => send(c, { id: m.id, result, ...(m.sessionId && { sessionId: m.sessionId }) });
const fail = (c: Client, m: Msg, message: string) => send(c, { id: m.id, error: { code: -32000, message }, ...(m.sessionId && { sessionId: m.sessionId }) });

const visible = (c: Client, t: Target | undefined) => !!t && t.folder === c.folder && t.info.type === "page";

function attach(c: Client, targetId: string) {
  attachFor.set(targetId, [...(attachFor.get(targetId) ?? []), c]);
  return call("Target.attachToTarget", { targetId, flatten: true });
}

// A target became visible to its folder: announce it to that folder's clients.
function announce(t: Target) {
  if (!t.folder || t.announced || t.info.type !== "page") return;
  t.announced = true;
  for (const c of clients) {
    if (!visible(c, t)) continue;
    if (c.discover) send(c, { method: "Target.targetCreated", params: { targetInfo: t.info } });
    if (c.autoAttach) attach(c, t.info.targetId);
  }
}

let buf = "";
fromChrome.on("data", (d: Buffer) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\0")) >= 0) {
    const m: Msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    onChrome(m);
  }
});

function onChrome(m: Msg) {
  if (m.id !== undefined) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!p) return;
    p.after?.(m);
    if (p.done) return p.done(m);
    if (p.client) send(p.client, { ...m, id: p.orig });
    return;
  }
  if (m.sessionId) {
    const c = owners.get(m.sessionId);
    if (!c) return;
    // A child (iframe, worker) attached inside a session the client owns is the client's too.
    if (m.method === "Target.attachedToTarget") owners.set(m.params.sessionId, c), c.sessions.add(m.params.sessionId);
    if (m.method === "Target.detachedFromTarget") owners.delete(m.params.sessionId), c.sessions.delete(m.params.sessionId);
    return send(c, m);
  }
  switch (m.method) {
    case "Target.targetCreated": {
      const info = m.params.targetInfo;
      const opener = info.openerId && targets.get(info.openerId);
      const t: Target = targets.get(info.targetId) ?? { info, folder: opener ? opener.folder : null, announced: false, seen: false };
      t.info = info;
      t.seen = true;
      targets.set(info.targetId, t);
      announce(t);
      return;
    }
    case "Target.targetInfoChanged": {
      const t = targets.get(m.params.targetInfo.targetId);
      if (!t) return;
      t.info = m.params.targetInfo;
      for (const c of clients) if (c.discover && visible(c, t)) send(c, m);
      return;
    }
    case "Target.targetDestroyed": {
      const t = targets.get(m.params.targetId);
      targets.delete(m.params.targetId);
      for (const c of clients) if (c.discover && visible(c, t)) send(c, m);
      return;
    }
    case "Target.attachedToTarget": {
      const id = m.params.targetInfo.targetId;
      const waiting = attachFor.get(id) ?? [];
      const c = waiting.shift();
      if (!waiting.length) attachFor.delete(id);
      if (!c) return;
      owners.set(m.params.sessionId, c);
      c.sessions.add(m.params.sessionId);
      return send(c, { ...m, params: { ...m.params, waitingForDebugger: false } });
    }
    case "Target.detachedFromTarget": {
      const c = owners.get(m.params.sessionId);
      owners.delete(m.params.sessionId);
      c?.sessions.delete(m.params.sessionId);
      if (c) send(c, m);
      return;
    }
  }
}

function onClient(c: Client, m: Msg) {
  if (m.sessionId) {
    if (!c.sessions.has(m.sessionId)) return fail(c, m, "Session with given id not found.");
    return forward(c, m);
  }
  const p = m.params ?? {};
  const own = (id: string) => visible(c, targets.get(id));
  switch (m.method) {
    case "Target.setDiscoverTargets":
      // As Chrome does: the existing targets first, then the reply.
      c.discover = !!p.discover;
      if (c.discover) for (const t of targets.values()) if (visible(c, t)) send(c, { method: "Target.targetCreated", params: { targetInfo: t.info } });
      return reply(c, m, {});
    case "Target.setAutoAttach":
      // As Chrome does: attached to the existing targets before the reply.
      c.autoAttach = !!p.autoAttach;
      if (!c.autoAttach) return reply(c, m, {});
      return void Promise.all([...targets.values()].filter((t) => visible(c, t)).map((t) => attach(c, t.info.targetId))).then(() => reply(c, m, {}));
    case "Target.getTargets":
      return reply(c, m, { targetInfos: [...targets.values()].filter((t) => visible(c, t)).map((t) => t.info) });
    case "Target.createTarget":
      return forward(c, m, (r) => {
        const id = r.result?.targetId;
        if (!id) return;
        // Chrome's targetCreated may come before or after this reply: announce once both are in.
        const t = targets.get(id) ?? { info: { targetId: id, type: "page" }, folder: null, announced: false, seen: false };
        t.folder = c.folder;
        targets.set(id, t);
        if (t.seen) announce(t);
      });
    case "Target.attachToTarget":
      if (!own(p.targetId)) return fail(c, m, "No target with given id found");
      attachFor.set(p.targetId, [...(attachFor.get(p.targetId) ?? []), c]);
      return forward(c, m);
    case "Target.activateTarget":
    case "Target.closeTarget":
    case "Target.getTargetInfo":
      if (p.targetId && !own(p.targetId)) return fail(c, m, "No target with given id found");
      return forward(c, m);
    case "Target.detachFromTarget":
      if (!c.sessions.has(p.sessionId)) return fail(c, m, "No session with given id");
      return forward(c, m);
    case "Browser.close":
      return reply(c, m, {});
    default:
      return forward(c, m);
  }
}

await call("Target.setDiscoverTargets", { discover: true });

export const server = Bun.serve<{ folder: string }, {}>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    const folder = new URL(req.url).pathname.match(/^\/s\/([\w-]+)$/)?.[1];
    if (folder && srv.upgrade(req, { data: { folder } })) return;
    return new Response("no", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add({ ws, folder: ws.data.folder, discover: false, autoAttach: false, sessions: new Set() });
    },
    message(ws, data) {
      const c = [...clients].find((c) => c.ws === ws)!;
      const m: Msg = JSON.parse(String(data));
      log.push(`${c.folder} -> ${m.method}`);
      trace(c, ">", m);
      onClient(c, m);
    },
    close(ws) {
      const c = [...clients].find((c) => c.ws === ws);
      if (!c) return;
      clients.delete(c);
      for (const s of c.sessions) (owners.delete(s), raw({ id: nextId++, method: "Target.detachFromTarget", params: { sessionId: s } }));
    },
  },
});
export const stop = () => chrome.kill();
