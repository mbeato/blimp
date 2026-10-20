// Typed client for blimpd (docs/DESIGN.md, "blimpd API"). One instance per connected server.

export type SessionState = "working" | "waiting" | "done" | "unknown";

// A port a program in a session listens on (blimpd's ports.ts). host: where it is on the server.
export type Port = { port: number; host: "127.0.0.1" | "::1"; session: string; pid: number; command: string };

// A tab of the server's browser (events `browser`): its folder, and the session that opened it.
export type BrowserTab = { id: string; folder: string; url: string; title: string; openedBy?: string };

// A way to start a session (GET /kinds): claude, claude-glm, codex, shell, or one from the
// server's ~/.blimp/kinds.json. note: why it can't start, or Codex's sign-in.
export type Kind = { id: string; label: string; available: boolean; note?: string };

export type Session = {
  name: string;
  kind: string; // a Kind's id ("codex-login" for Settings' Codex sign-in)
  label?: string; // the small label rows show for kinds other than Claude Code and a shell
  pid: number;
  clients: number;
  created: number; // unix seconds
  dir: string;
  cmd: string;
  sessionId?: string;
  title: string;
  status: string;
  waitingFor?: string;
  updatedAt?: number; // ms
  state: SessionState;
  stateSince?: number; // ms
};

export type RecentFolder = { dir: string; lastUsed: number };
export type Conversation = { sessionId: string; title: string; updatedAt: number };
export type DirEntry = { name: string; kind: "file" | "dir"; size: number; mtime: number };
export type DirListing = { path: string; entries: DirEntry[] };
export type FileBody = { bytes: Uint8Array<ArrayBuffer>; mtime: number; contentType: string };

// What the app needs to reach one blimpd: the local end of the tunnel and the token.
// version: blimpd's, from /health.
export type Conn = { id: string; base: string; token: string; home: string; version?: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: any = {},
  ) {
    super(message);
  }
}

export class Api {
  constructor(private conn: Conn) {}

  private url(path: string, query: Record<string, string | number | undefined> = {}) {
    const u = new URL(path, this.conn.base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async req(path: string, init: RequestInit & { query?: Record<string, string | number | undefined> } = {}) {
    const { query, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("Authorization", `Bearer ${this.conn.token}`);
    const res = await fetch(this.url(path, query), { ...rest, headers });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`, body);
    }
    return res;
  }

  private async json<T>(path: string, init: Parameters<Api["req"]>[1] = {}): Promise<T> {
    return (await this.req(path, init)).json();
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.json(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  }

  health() {
    return this.json<{ version: string; home: string }>("/health");
  }

  sessions() {
    return this.json<Session[]>("/sessions");
  }

  createSession(body: { dir: string; name?: string; resume?: string; kind?: string }) {
    return this.post<{ name: string }>("/sessions", body);
  }

  kinds() {
    return this.json<Kind[]>("/kinds");
  }

  // Whether the server has each key. Keys only ever go to it, never come back.
  keys() {
    return this.json<{ zai: boolean }>("/keys");
  }

  async setZaiKey(key: string) {
    await this.req("/keys/zai", { method: "PUT", body: JSON.stringify({ key }), headers: { "Content-Type": "application/json" } });
  }

  async removeZaiKey() {
    await this.req("/keys/zai", { method: "DELETE" });
  }

  // Ends the session (zmx kill). Claude's conversation stays resumable.
  async endSession(name: string) {
    await this.req(`/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  recentFolders() {
    return this.json<RecentFolder[]>("/folders/recent");
  }

  conversations(dir: string) {
    return this.json<Conversation[]>("/conversations", { query: { dir } });
  }

  // WebSockets can't carry an Authorization header, so the token rides in the query.
  wsUrl(path: string, query: Record<string, string | number> = {}) {
    const u = new URL(this.url(path, { ...query, token: this.conn.token }));
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  }

  attachUrl(name: string, cols: number, rows: number) {
    return this.wsUrl(`/sessions/${encodeURIComponent(name)}/attach`, { cols, rows });
  }

  eventsUrl() {
    return this.wsUrl("/events");
  }

  fsList(path: string) {
    return this.json<DirListing>("/fs/list", { query: { path } });
  }

  async fsRead(path: string): Promise<FileBody> {
    const res = await this.req("/fs/file", { query: { path } });
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mtime: Number(res.headers.get("X-Blimp-Mtime") ?? 0),
      contentType: res.headers.get("Content-Type") ?? "application/octet-stream",
    };
  }

  // With baseMtime, a file changed on the server since it was read throws ApiError 409
  // (body.mtime is the server's). Without it the write overwrites ("Keep mine").
  async fsWrite(path: string, body: BodyInit, baseMtime?: number) {
    const res = await this.req("/fs/file", { method: "PUT", body, query: { path, baseMtime } });
    return (await res.json()) as { mtime: number };
  }

  // The browser build's download (the Mac app's goes through Rust: src-tauri/src/transfer.rs).
  fsDownload(path: string, signal?: AbortSignal) {
    return this.req("/fs/download", { query: { path }, signal });
  }

  // mode "new": 409 if the name is taken; "replace": over a file of that name.
  async fsUpload(path: string, body: Blob, mode: "new" | "replace", signal?: AbortSignal) {
    const res = await this.req("/fs/upload", { method: "PUT", body, query: { path, mode }, signal });
    return (await res.json()) as { size: number; mtime: number };
  }

    fsMkdir(path: string) {
    return this.post<{ path: string }>("/fs/mkdir", { path });
  }

  fsCreate(path: string) {
    return this.post<{ path: string; mtime: number }>("/fs/create", { path });
  }

  fsFiles(root: string) {
    return this.json<{ files: string[]; truncated: boolean }>("/fs/files", { query: { root } });
  }
}
