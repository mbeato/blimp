// The connector gap (src/accounts/connectors.ts): what `claude mcp list` printed, the stored readings,
// and the gap between accounts. Names, emails and tokens are made up; no test runs the real claude.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connector, gap, gapKey, gapOf, parseMcpList, readConnectors, writeConnectors } from "../src/accounts/connectors";
import { CONNECTORS_AFTER_SWITCH_MS, CONNECTORS_EVERY_MS, CONNECTORS_RETRY_MS, CONNECTORS_TIMEOUT_MS, CONNECTORS_ZERO_AGAIN_MS } from "../src/accounts/rules";
import { saveLogin } from "../src/accounts/store";

const root = realpathSync(mkdtempSync(join(tmpdir(), "blimp-connectors-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const creds = (tok: string) => JSON.stringify({ claudeAiOauth: { accessToken: tok, refreshToken: `r-${tok}`, expiresAt: 1, refreshTokenExpiresAt: 2e12 } });
const acct = (id: string, email: string) => ({ accountUuid: id, emailAddress: email });

// What claude mcp list printed on claude1, with the names and addresses made up.
const LISTED = [
  "Checking MCP server health…",
  "",
  "claude.ai Slack: https://mcp.example.com/slack - ✔ Connected",
  "claude.ai Gmail: https://mcp.example.com/gmail - ✔ Connected",
  "claude.ai Google Drive: https://mcp.example.com/drive - ✔ Connected",
  "claude.ai Google Calendar: https://calendarmcp.example.com/mcp/v1 - ✔ Connected",
  "claude.ai Zapier: https://mcp.example.com/zapier - ✔ Connected",
  "claude.ai Claude Docs: https://mcp.example.com/docs - ✔ Connected",
  "ptc: uv run ptc-server - ✔ Connected",
  "blimp: /usr/bin/blimpd visuals-mcp - ✔ Connected",
  "notes: node /opt/notes/server.js - ✗ Failed to connect",
  "",
].join("\n");

const ok = (name: string): Connector => ({ name, state: "ok" });
const signin = (name: string): Connector => ({ name, state: "signin" });
const down = (name: string): Connector => ({ name, state: "down" });

describe("parseMcpList", () => {
  test("the claude.ai connectors of the real-looking output, and not the user's own servers", () => {
    expect(parseMcpList(LISTED)).toEqual(["Slack", "Gmail", "Google Drive", "Google Calendar", "Zapier", "Claude Docs"].map(ok));
  });

  test("a connector that needs a sign-in, in any case", () => {
    expect(parseMcpList("claude.ai Slack: https://mcp.example.com/slack - ! Needs authentication")).toEqual([signin("Slack")]);
    expect(parseMcpList("claude.ai Slack: https://mcp.example.com/slack - ! needs AUTHENTICATION")).toEqual([signin("Slack")]);
  });

  test("a connector that can't be reached is down", () => {
    expect(parseMcpList("claude.ai Zapier: https://mcp.example.com/zapier - ✗ Failed to connect")).toEqual([down("Zapier")]);
    expect(parseMcpList("claude.ai Zapier: https://mcp.example.com/zapier - something else")).toEqual([down("Zapier")]);
  });

  test("a name with a space, and a second ': ' in the address part", () => {
    expect(parseMcpList("claude.ai Google Calendar: https://x.example.com/a: b - ✔ Connected")).toEqual([ok("Google Calendar")]);
  });

  test("a doubled name: the first one counts", () => {
    expect(parseMcpList("claude.ai Slack: https://a.example.com - ✗ Failed to connect\nclaude.ai Slack: https://b.example.com - ✔ Connected")).toEqual([down("Slack")]);
  });

  test("no connector lines, and empty text", () => {
    expect(parseMcpList("Checking MCP server health…\n\nptc: uv run ptc-server - ✔ Connected\n")).toEqual([]);
    expect(parseMcpList("Checking MCP server health…\n\nNo MCP servers configured.")).toEqual([]);
    expect(parseMcpList("")).toEqual([]);
  });
});

describe("gap", () => {
  test("missing only", () => {
    expect(gap([ok("Slack")], [[ok("Slack"), ok("Zapier"), ok("Gmail")]])).toEqual({ missing: ["Gmail", "Zapier"], signin: [] });
  });

  test("sign-in only", () => {
    expect(gap([signin("Slack"), ok("Zapier")], [[ok("Slack"), ok("Zapier")]])).toEqual({ missing: [], signin: ["Slack"] });
  });

  test("both, and the key: missing sorted, then sign-ins sorted with ! in front", () => {
    const g = gap([signin("Slack"), signin("Gmail")], [[ok("Slack"), ok("Zapier"), ok("Google Calendar"), ok("Gmail")]]);
    expect(g).toEqual({ missing: ["Google Calendar", "Zapier"], signin: ["Gmail", "Slack"] });
    expect(gapKey(g)).toEqual(["Google Calendar", "Zapier", "!Gmail", "!Slack"]);
  });

  test("a connector down here is not in it; nor one that needs a sign-in on the other account too", () => {
    expect(gap([down("Slack"), signin("Gmail")], [[ok("Slack"), signin("Gmail")]])).toEqual({ missing: [], signin: [] });
  });

  test("one that isn't ok on the other account isn't missing here", () => {
    expect(gap([], [[down("Slack"), signin("Gmail")]])).toEqual({ missing: [], signin: [] });
  });

  test("an account with no reading adds nothing", () => {
    expect(gap([ok("Slack")], [])).toEqual({ missing: [], signin: [] });
  });

  test("three accounts: any other one with it ok counts", () => {
    expect(gap([ok("Slack")], [[ok("Slack"), ok("Gmail")], [ok("Zapier"), down("Gmail")]])).toEqual({ missing: ["Gmail", "Zapier"], signin: [] });
  });

  test("names compare exactly", () => {
    expect(gap([ok("slack")], [[ok("Slack")]])).toEqual({ missing: ["Slack"], signin: [] });
  });
});

describe("connectors.json", () => {
  // id-a, id-b and id-c saved.
  function setup() {
    const dir = join(root, `t${++n}`, "accounts");
    for (const id of ["id-a", "id-b", "id-c"]) saveLogin(id, creds(`tok-${id}`), acct(id, `${id}@x.com`), dir);
    return dir;
  }

  test("written 600 through a temp file, read back; none: undefined", () => {
    const dir = setup();
    expect(readConnectors("id-a", dir)).toBeUndefined();
    const r = { at: 5, connectors: [ok("Slack"), signin("Gmail")], told: ["!Gmail"] };
    writeConnectors("id-a", r, dir);
    const file = join(dir, "id-a", "connectors.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(r);
    expect(readConnectors("id-a", dir)).toEqual(r);
  });

  test("a broken file reads as none; a bad told as []", () => {
    const dir = setup();
    const file = join(dir, "id-a", "connectors.json");
    for (const text of ["not json", "{}", '{"at": "x", "connectors": []}', '{"at": 1, "connectors": [{"name": 3, "state": "ok"}]}', '{"at": 1, "connectors": [{"name": "Slack", "state": "maybe"}]}']) {
      writeFileSync(file, text);
      expect(readConnectors("id-a", dir)).toBeUndefined();
    }
    writeFileSync(file, JSON.stringify({ at: 1, connectors: [ok("Slack")], told: "Slack" }));
    expect(readConnectors("id-a", dir)).toEqual({ at: 1, connectors: [ok("Slack")], told: [] });
  });

  test("an account with no folder isn't written to, and no folder is made for it", () => {
    const dir = setup();
    expect(() => writeConnectors("id-z", { at: 1, connectors: [], told: [] }, dir)).toThrow();
    expect(() => statSync(join(dir, "id-z"))).toThrow();
    expect(() => writeConnectors("../x", { at: 1, connectors: [], told: [] }, dir)).toThrow();
  });

  test("gapOf: against the other saved accounts' stored readings only", () => {
    const dir = setup();
    writeConnectors("id-a", { at: 1, connectors: [ok("Slack"), signin("Gmail")], told: [] }, dir);
    writeConnectors("id-b", { at: 1, connectors: [ok("Slack"), ok("Gmail")], told: [] }, dir);
    expect(gapOf("id-a", dir)).toEqual({ missing: [], signin: ["Gmail"] });
    expect(gapOf("id-b", dir)).toEqual({ missing: [], signin: [] });
    expect(gapOf("id-c", dir)).toBeUndefined(); // no reading of its own
    // A folder that isn't a saved login any more (no credentials.json): its reading isn't read.
    mkdirSync(join(dir, "id-d"));
    writeConnectors("id-d", { at: 1, connectors: [ok("Zapier")], told: [] }, dir);
    expect(gapOf("id-a", dir)).toEqual({ missing: [], signin: ["Gmail"] });
  });
});

test("the constants", () => {
  expect(CONNECTORS_EVERY_MS).toBe(24 * 3600_000);
  expect(CONNECTORS_AFTER_SWITCH_MS).toBe(30_000);
  expect(CONNECTORS_RETRY_MS).toBe(10 * 60_000);
  expect(CONNECTORS_ZERO_AGAIN_MS).toBe(60_000);
  expect(CONNECTORS_TIMEOUT_MS).toBe(60_000);
});
