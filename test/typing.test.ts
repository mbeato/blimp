// typeInto against a real zmx session: a stand-in Claude that prints each line it reads, with ESC
// shown as ~ (zmx draws output through a terminal emulator, which would swallow a raw ESC).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseZmxList, zmxEnv, zmxPath } from "../src/sessions";
import { Asking, typeInto } from "../src/typing";

const tmp = mkdtempSync(join(tmpdir(), "blimp-typing-"));
const tag = `blimptest-ty${process.pid}`;
const made: string[] = [];
const saved = { claude: process.env.CLAUDE_CONFIG_DIR, socket: process.env.BLIMPD_SOCKET };

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
  process.env.BLIMPD_SOCKET = join(tmp, "blimpd.sock");
  mkdirSync(join(tmp, "claude", "sessions"), { recursive: true });
});

afterAll(() => {
  if (made.length) Bun.spawnSync([zmxPath(), "kill", ...made, "--force"], { env: zmxEnv(), stdout: "ignore", stderr: "ignore" });
  for (const [k, v] of [["CLAUDE_CONFIG_DIR", saved.claude], ["BLIMPD_SOCKET", saved.socket]] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  rmSync(tmp, { recursive: true, force: true });
});

const LOOP = `while IFS= read -r l; do printf 'got:%s\\n' "$(printf %s "$l" | tr '\\033' '~')"; done`;
const zmx = (...args: string[]) => Bun.spawnSync([zmxPath(), ...args], { env: zmxEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
const screen = (name: string) => zmx("history", name).stdout.toString();

async function until(f: () => boolean, what: string, ms = 5000) {
  for (const end = Date.now() + ms; !f(); await Bun.sleep(25)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

// A session that looks like Claude to listSessions: its pid has a status file with a sessionId.
async function fakeClaude(suffix: string, status = "idle") {
  const name = `${tag}-${suffix}`;
  made.push(name);
  Bun.spawnSync([zmxPath(), "attach", name, "sh", "-c", LOOP], { env: zmxEnv(), cwd: tmp, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let pid = 0;
  await until(() => (pid = parseZmxList(zmx("list").stdout.toString()).find((s) => s.name === name)?.pid ?? 0) > 0, `zmx session ${name}`);
  const file = join(tmp, "claude", "sessions", `${pid}.json`);
  writeFileSync(file, JSON.stringify({ sessionId: `s-${suffix}`, cwd: tmp, status }));
  return { name, setStatus: (s: string) => writeFileSync(file, JSON.stringify({ sessionId: `s-${suffix}`, cwd: tmp, status: s })) };
}

describe("typeInto", () => {
  test("types the text as a bracketed paste, then Enter", async () => {
    const { name } = await fakeClaude("a");
    await typeInto(name, "hello there", { enter: true });
    await until(() => screen(name).includes("got:~[200~hello there~[201~"), "the line to reach the session");
  });

  test("without enter, the paste waits in the input; control characters are taken out", async () => {
    const { name } = await fakeClaude("b");
    await typeInto(name, "one\x03\x1b[31m", { enter: false });
    await typeInto(name, "two", { enter: true });
    await until(() => screen(name).includes("got:~[200~one[31m~[201~~[200~two~[201~"), "both pastes on one line");
  });

  test("two at once go one after the other, never mixed", async () => {
    const { name } = await fakeClaude("c");
    await Promise.all([typeInto(name, "first", { enter: true }), typeInto(name, "second", { enter: true })]);
    await until(() => screen(name).includes("got:~[200~first~[201~") && screen(name).includes("got:~[200~second~[201~"), "both lines");
  });

  test("refused while Claude asks something, and nothing is typed", async () => {
    const { name, setStatus } = await fakeClaude("d", "waiting");
    const err = await typeInto(name, "no", { enter: true }).catch((e) => e);
    expect(err).toBeInstanceOf(Asking);
    expect(err.message).toBe("Claude is asking something. Answer it first.");
    setStatus("idle");
    await typeInto(name, "yes", { enter: true });
    await until(() => screen(name).includes("got:~[200~yes~[201~"), "the line after the wait");
    expect(screen(name)).not.toContain("~[200~no");
  });

  test("a session that isn't there: an error, and no session is made", async () => {
    await expect(typeInto(`${tag}-gone`, "x", { enter: true })).rejects.toThrow("the session ended");
    expect(parseZmxList(zmx("list").stdout.toString()).some((s) => s.name === `${tag}-gone`)).toBe(false);
  });

  test("its zmx client is gone afterwards", async () => {
    const { name } = await fakeClaude("e");
    await typeInto(name, "x", { enter: true });
    await until(() => parseZmxList(zmx("list").stdout.toString()).find((s) => s.name === name)?.clients === 0, "the client to go");
  });
});
