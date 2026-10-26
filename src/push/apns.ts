// Sending to Apple's push service (docs/superpowers/specs/2026-10-20-phone-push-design.md, section 5): one HTTP/2
// connection per service (production for TestFlight builds, sandbox for ones from Xcode), opened when needed and
// kept while it works, and a JWT signed with the push key, made again every 40 minutes (Apple wants 20 to 60).
// Outbound HTTPS only: nothing listens.

import { sign } from "node:crypto";
import http2 from "node:http2";
import type { Creds, Device, PushEnv } from "./store";

export const HOSTS: Record<PushEnv, string> = { production: "https://api.push.apple.com", development: "https://api.sandbox.push.apple.com" };
export const TOPIC = "dev.blimp.phone";
const JWT_LIFE = 40 * 60_000;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

// ES256: the signature is r and s side by side (64 bytes), not DER.
export function makeJwt(c: Creds, now = Date.now()): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: c.keyId }));
  const claims = b64url(JSON.stringify({ iss: c.teamId, iat: Math.floor(now / 1000) }));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key: c.key, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(sig)}`;
}

// status 0: no answer from Apple, and reason says why.
export type Sent = { status: number; reason?: string };
// type widgets: a widget push (iOS 26), which only tells WidgetKit to reload the widgets: its own topic, priority 5.
// type liveactivity: a Live Activity push (the live panel, live.ts): its own topic, priority 10 unless given.
export type PushOptions = { collapseId?: string; type?: "alert" | "widgets" | "liveactivity"; priority?: 5 | 10 };

// Apple's answers that mean the phone's token no longer works: the app was deleted, or the token is wrong.
export const goneDevice = (r: Sent) => r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered";

export class Apns {
  private jwt?: { token: string; at: number };
  private conns = new Map<PushEnv, http2.ClientHttp2Session>();

  constructor(
    private creds: Creds,
    private hosts = HOSTS,
    private now = Date.now,
    private timeout = 10_000,
  ) {}

  // Never throws. A failed send isn't tried again, except after a dropped connection: once, on a fresh one.
  async send(d: Device, payload: object, o: PushOptions = {}): Promise<Sent> {
    for (let i = 0; ; i++) {
      try {
        return await this.once(d, payload, o);
      } catch (e) {
        this.drop(d.env);
        if (i === 1) return { status: 0, reason: (e as Error).message };
      }
    }
  }

  close() {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
  }

  private bearer(): string {
    const t = this.now();
    if (!this.jwt || t - this.jwt.at >= JWT_LIFE) this.jwt = { token: makeJwt(this.creds, t), at: t };
    return this.jwt.token;
  }

  private conn(env: PushEnv): http2.ClientHttp2Session {
    const had = this.conns.get(env);
    if (had && !had.closed && !had.destroyed) return had;
    const c = http2.connect(this.hosts[env]);
    // An error or a goaway ends it, and the next send opens another. Without an error listener, one would end blimpd.
    const forget = () => {
      if (this.conns.get(env) === c) this.conns.delete(env);
    };
    c.on("error", forget);
    c.on("goaway", forget);
    c.on("close", forget);
    this.conns.set(env, c);
    return c;
  }

  private drop(env: PushEnv) {
    this.conns.get(env)?.destroy();
    this.conns.delete(env);
  }

  // Apple's answer, or a rejection when the stream closes without one (a dropped connection, a timeout).
  private once(d: Device, payload: object, o: PushOptions): Promise<Sent> {
    return new Promise((resolve, reject) => {
      const req = this.conn(d.env).request({
        ":method": "POST",
        ":path": `/3/device/${d.token}`,
        authorization: `bearer ${this.bearer()}`,
        "apns-topic": o.type && o.type !== "alert" ? `${TOPIC}.push-type.${o.type}` : TOPIC,
        "apns-push-type": o.type ?? "alert",
        "apns-priority": String(o.priority ?? (o.type === "widgets" ? 5 : 10)),
        ...(o.collapseId && { "apns-collapse-id": o.collapseId }),
      });
      let status = 0;
      let body = "";
      // A hard limit that rejects whatever the stream does: a connection that never comes up (or never finishes TLS)
      // never settles the stream's own timeout. send() then destroys the session, so the worst case is 2 x the limit.
      const timer = setTimeout(() => {
        reject(new Error(`no answer from Apple in ${this.timeout / 1000} s`));
        req.close(http2.constants.NGHTTP2_CANCEL);
      }, this.timeout);
      req.on("response", (h) => (status = Number(h[":status"])));
      req.on("data", (c) => (body += c));
      req.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.on("close", () => {
        clearTimeout(timer);
        if (!status) return reject(new Error("no answer from Apple"));
        let reason: unknown;
        try {
          reason = JSON.parse(body)?.reason;
        } catch {}
        resolve({ status, ...(typeof reason === "string" && { reason }) });
      });
      req.end(JSON.stringify(payload));
    });
  }
}
