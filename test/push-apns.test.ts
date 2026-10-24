// Sending to Apple (src/push/apns.ts), against a stand-in: plain HTTP/2 on a local port. Nothing here reaches Apple.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import http2 from "node:http2";
import net from "node:net";
import { Apns, goneDevice, makeJwt, TOPIC } from "../src/push/apns";
import type { Device, PushEnv } from "../src/push/store";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const creds = { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, keyId: "ABC123DEFG", teamId: "1A2B3C4D5E" };
const device: Device = { token: "a".repeat(64), env: "production", at: 0 };

// What the stand-in got, and how it answers each request (200 unless a test says otherwise).
type Got = { headers: http2.IncomingHttpHeaders; body: string };
const ok = (_: Got, s: http2.ServerHttp2Stream) => {
  s.respond({ ":status": 200 });
  s.end();
};
let got: Got[] = [];
let answer = ok;
const reset = (a = ok) => {
  got = [];
  answer = a;
};
const apple = http2.createServer();
apple.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
  let body = "";
  stream.on("data", (c) => (body += c));
  stream.on("end", () => {
    const g = { headers, body };
    got.push(g);
    answer(g, stream);
  });
});
let hosts: Record<PushEnv, string>;
beforeAll(async () => {
  await new Promise<void>((r) => apple.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(apple.address() as { port: number }).port}`;
  hosts = { production: url, development: url };
});
afterAll(() => apple.close());

const json = (b64: string) => JSON.parse(Buffer.from(b64, "base64url").toString());

test("the JWT: ES256 with the Key ID, the Team ID and the time in seconds, signed with the key", () => {
  const [h, c, s] = makeJwt(creds, 1_700_000_000_123).split(".");
  expect(json(h)).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
  expect(json(c)).toEqual({ iss: "1A2B3C4D5E", iat: 1_700_000_000 });
  expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
});

test("a send: the device's path, Apple's headers, the payload as JSON, and Apple's answer", async () => {
  reset();
  const a = new Apns(creds, hosts);
  try {
    expect(await a.send(device, { aps: { alert: "hi" } }, { collapseId: "s1" })).toEqual({ status: 200 });
    const [g] = got;
    expect(g.headers[":method"]).toBe("POST");
    expect(g.headers[":path"]).toBe(`/3/device/${device.token}`);
    expect(g.headers["apns-topic"]).toBe(TOPIC);
    expect(g.headers["apns-push-type"]).toBe("alert");
    expect(g.headers["apns-priority"]).toBe("10");
    expect(g.headers["apns-collapse-id"]).toBe("s1");
    expect(String(g.headers.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(g.body)).toEqual({ aps: { alert: "hi" } });
  } finally {
    a.close();
  }
});

test("Apple's reason comes back; 410, BadDeviceToken and Unregistered mean the phone is gone", async () => {
  reset((_, s) => {
    s.respond({ ":status": 410 });
    s.end(JSON.stringify({ reason: "Unregistered" }));
  });
  const a = new Apns(creds, hosts);
  try {
    const r = await a.send(device, {});
    expect(r).toEqual({ status: 410, reason: "Unregistered" });
    expect(goneDevice(r)).toBe(true);
  } finally {
    a.close();
  }
  expect(goneDevice({ status: 400, reason: "BadDeviceToken" })).toBe(true);
  expect(goneDevice({ status: 400, reason: "BadCollapseId" })).toBe(false);
  expect(goneDevice({ status: 200 })).toBe(false);
});

test("the JWT is kept for 40 minutes, then made again", async () => {
  reset();
  let now = 1_700_000_000_000;
  const a = new Apns(creds, hosts, () => now);
  try {
    await a.send(device, {});
    now += 39 * 60_000;
    await a.send(device, {});
    now += 2 * 60_000;
    await a.send(device, {});
    const auth = got.map((g) => g.headers.authorization);
    expect(auth[1]).toBe(auth[0]);
    expect(auth[2]).not.toBe(auth[0]);
  } finally {
    a.close();
  }
});

test("a connection that drops before Apple answers is tried once more, on a new one", async () => {
  let first = true;
  reset((g, s) => {
    if (first) {
      first = false;
      s.session?.destroy();
      return;
    }
    ok(g, s);
  });
  const a = new Apns(creds, hosts);
  try {
    expect(await a.send(device, {})).toEqual({ status: 200 });
    expect(got.length).toBe(2);
  } finally {
    a.close();
  }
});

test("when the second try fails too, the send says so with status 0, and doesn't throw", async () => {
  reset((_, s) => s.session?.destroy());
  const a = new Apns(creds, hosts);
  try {
    const r = await a.send(device, {});
    expect(r.status).toBe(0);
    expect(typeof r.reason).toBe("string");
    expect(got.length).toBe(2);
  } finally {
    a.close();
  }
});

// The 10 s limit holds whatever the connection does; here it is 200 ms.
const SHORT = 200;

test("Apple takes the request and never answers: status 0 with a reason, after 2 tries, well under a second", async () => {
  reset((_, s) => void s.on("error", () => {}));
  const a = new Apns(creds, hosts, Date.now, SHORT);
  try {
    const t0 = Date.now();
    const r = await a.send(device, { aps: {} });
    expect(r.status).toBe(0);
    expect(r.reason).toBeTruthy();
    expect(got.length).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1000);
  } finally {
    a.close();
  }
});

test("a TCP connection that never speaks HTTP/2: still status 0 within about 2 x the timeout", async () => {
  const socks: net.Socket[] = [];
  const dead = net.createServer((c) => void socks.push(c));
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(dead.address() as net.AddressInfo).port}`;
  const a = new Apns(creds, { production: url, development: url }, Date.now, SHORT);
  try {
    const t0 = Date.now();
    const r = await a.send(device, { aps: {} });
    expect(r.status).toBe(0);
    expect(r.reason).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(SHORT * 2 + 600);
  } finally {
    a.close();
    for (const c of socks) c.destroy();
    await new Promise((r) => dead.close(r));
  }
}, 5000);
