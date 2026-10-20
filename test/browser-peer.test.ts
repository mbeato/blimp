import { expect, test } from "bun:test";
import { hexAddress, peerUid, tcpOwner } from "../src/browser/peer";

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
    expect(peerUid(peer!.address, peer!.port)).toBe(process.getuid!());
  } finally {
    server.stop(true);
  }
});
