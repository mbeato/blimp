import { expect, test } from "bun:test";
import { connectHint, isNotSetUp } from "./hints";

// The errors as the Rust shell words them (open, wait_healthy and with_detail in src-tauri/src/tunnel.rs),
// with ssh's last stderr line as macOS and Linux print it.
const server = { host: "box", user: "max", port: 2222 };
const notSetUp = "blimpd isn't set up on box: cat: /home/max/.blimp/token: No such file or directory";

test("blimpd not set up: the one error Install blimpd is offered for", () => {
  expect(isNotSetUp(notSetUp)).toBe(true);
  expect(isNotSetUp("blimpd isn't set up on box.")).toBe(true);
  expect(isNotSetUp("SSH to box failed: Permission denied (publickey).")).toBe(false);
  expect(isNotSetUp("blimpd on box didn't answer within 10 seconds")).toBe(false);
  expect(connectHint(notSetUp, server)).toBe("blimpd isn't installed on this server yet. Install blimpd puts it there.");
  // Its detail can name another error; not being set up is what counts.
  expect(connectHint("blimpd isn't set up on box: cat: /home/max/.blimp/token: Permission denied", server)).toBe(connectHint(notSetUp, server));
});

test("an unknown host key: connect once from Terminal, with the command for this server", () => {
  expect(connectHint("SSH to box failed: Host key verification failed.", server)).toBe("Connect once from Terminal first: ssh -p 2222 max@box");
  expect(connectHint("SSH to box failed: Host key verification failed.", { host: "box" })).toBe("Connect once from Terminal first: ssh box");
});

test("a key the server doesn't accept", () => {
  const hint = "The server doesn't accept this Mac's SSH key. Add the key to ~/.ssh/authorized_keys on the server.";
  expect(connectHint("SSH to box failed: max@box: Permission denied (publickey).", server)).toBe(hint);
  expect(connectHint("SSH tunnel to box closed right away: max@box: Permission denied (publickey,password).", server)).toBe(hint);
});

test("a name that doesn't resolve, a timeout or a refusal: check the name and that the server is on", () => {
  const hint = "Check the host name, and that the server is on and reachable from this Mac.";
  for (const e of [
    "SSH to box failed: ssh: Could not resolve hostname box: nodename nor servname provided, or not known",
    "SSH to box failed: ssh: Could not resolve hostname box: Name or service not known",
    "SSH to box failed: ssh: Could not resolve hostname box: Temporary failure in name resolution",
    "SSH to box failed: ssh: connect to host box port 2222: Operation timed out",
    "SSH to box failed: ssh: connect to host box port 2222: Connection timed out",
    "SSH to box failed: ssh: connect to host box port 2222: Connection refused",
  ])
    expect(connectHint(e, server)).toBe(hint);
});

test("other errors get no hint", () => {
  for (const e of [
    "blimpd on box didn't answer within 10 seconds",
    "blimpd on box didn't accept the token",
    "blimpd on box answered /health with HTTP 500",
    "SSH to box failed.",
    "Lost the connection to blimpd.",
    "",
  ])
    expect(connectHint(e, server)).toBe("");
});
