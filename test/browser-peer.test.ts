import { expect, test } from "bun:test";
import { hexAddress, lsofOwner, macPeerUid, peerUid, tcpOwner } from "../src/browser/peer";

const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const v4 = [
  header,
  "   0: 0100007F:D431 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 6490 1 0 20 4 30 10 -1",
  "   1: 0100007F:9C40 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 6491 1 0 20 4 30 10 -1",
  "   2: 0100007F:D432 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1001        0 6492 1 0 20 4 30 10 -1",
  "   3: 0100007F:D433 0100007F:9C40 06 00000000:00000000 03:00000000 00000000     0        0 0 3 0",
].join("\n");
const v6 = [
  header,
  "   0: 00000000000000000000000001000000:D434 00000000000000000000000001000000:9C40 01 00000000:00000000 00:00000000 00000000  1002        0 7700 1 0",
  "   1: 0000000000000000FFFF00000100007F:D435 0000000000000000FFFF00000100007F:9C40 01 00000000:00000000 00:00000000 00000000  1003        0 7701 1 0",
].join("\n");

test("addresses as /proc/net/tcp writes them", () => {
  expect(hexAddress("127.0.0.1")).toBe("0100007F");
  expect(hexAddress("::1")).toBe("00000000000000000000000001000000");
  expect(hexAddress("::ffff:127.0.0.1")).toBe("0000000000000000FFFF00000100007F");
  expect(hexAddress("nonsense")).toBeNull();
});

test("the uid that owns a connected socket, by its address and port", () => {
  expect(tcpOwner(v4, "127.0.0.1", 0xd431)).toBe(1000);
  expect(tcpOwner(v4, "127.0.0.1", 0xd432)).toBe(1001);
  // Only connected sockets count, not one that's closing.
  expect(tcpOwner(v4, "127.0.0.1", 0xd433)).toBeNull();
  expect(tcpOwner(v4, "127.0.0.1", 1)).toBeNull();
  expect(tcpOwner(v6, "::1", 0xd434)).toBe(1002);
  expect(tcpOwner(v6, "::ffff:127.0.0.1", 0xd435)).toBe(1003);
});

// `lsof -nP -iTCP:50562 -sTCP:ESTABLISHED -F pun` as macOS prints it, for a connection from port
// 50562 to a listener on 47311. lsof lists both ends: the listener's process first here, then the client's.
const lsof = (server: string[], client: string[]) => [...server, "f5", "n127.0.0.1:47311->127.0.0.1:50562", ...client, "f4", "n127.0.0.1:50562->127.0.0.1:47311", ""].join("\n");

test("the uid that holds the client's end of a connection, in lsof's output", () => {
  const name = "127.0.0.1:50562->127.0.0.1:47311";
  expect(lsofOwner(lsof(["p18065", "u501"], ["p20011", "u501"]), name)).toBe(501);
  // The listener's end is always blimpd's own, so it never counts: only the client's uid does.
  expect(lsofOwner(lsof(["p18065", "u501"], ["p20011", "u502"]), name)).toBe(502);
  // Another user's client: lsof, run as you, lists only the listener's end.
  expect(lsofOwner(["p18065", "u501", "f5", "n127.0.0.1:47311->127.0.0.1:50562", ""].join("\n"), name)).toBeNull();
  // The same client port, connected to something else.
  expect(lsofOwner(lsof(["p18065", "u501"], ["p20011", "u501"]), "127.0.0.1:50562->127.0.0.1:47312")).toBeNull();
  expect(lsofOwner(lsof(["p18065", "u501"], ["p20011", "u501"]), "127.0.0.1:50562->127.0.0.1:4731")).toBeNull();
  // A process with no uid line doesn't get the one before it.
  expect(lsofOwner(lsof(["p18065", "u501"], ["p20011"]), name)).toBeNull();
  // No such connection: lsof prints nothing (and exits 1).
  expect(lsofOwner("", name)).toBeNull();
});

test("a live connection is ours", async () => {
  let peer: { address: string; port: number } | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      peer = srv.requestIP(req) ?? undefined;
      return new Response("ok");
    },
  });
  try {
    await fetch(`http://127.0.0.1:${server.port}/`);
    expect(peer).toBeDefined();
    // The client's side of the connection is still open while keep-alive holds it.
    const uid = process.platform === "darwin" ? await macPeerUid(peer!.address, peer!.port, server.port!) : peerUid(peer!.address, peer!.port);
    expect(uid).toBe(process.getuid!());
    // macOS matches both ends: the same client port to another listener isn't this connection.
    if (process.platform === "darwin") expect(await macPeerUid(peer!.address, peer!.port, 1)).toBeNull();
  } finally {
    server.stop(true);
  }
});
