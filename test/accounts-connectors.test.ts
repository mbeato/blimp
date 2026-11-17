// The connector gap (src/accounts/connectors.ts): what `claude mcp list` printed, the stored readings,
// and the gap between accounts. Names, emails and tokens are made up; no test runs the real claude.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connector, Connectors, type ConnectorsDeps, type Due, gap, gapKey, gapOf, parseMcpList, readConnectors, readingDue, writeConnectors } from "../src/accounts/connectors";
import { CONNECTORS_AFTER_SWITCH_MS, CONNECTORS_EVERY_MS, CONNECTORS_RETRY_MS, CONNECTORS_TIMEOUT_MS, CONNECTORS_ZERO_AGAIN_MS } from "../src/accounts/rules";
import { putLive, readState, type Saved, type State, saveLogin, writeState } from "../src/accounts/store";

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

// The rule and the class run on a clock ahead of the real one, so the real mtime of the live file is in the past.
const T = 1_900_000_000_000;
const H = 3600_000;

describe("readingDue", () => {
  const a: Saved = { id: "id-a", email: "a@x.com" };
  const b: Saved = { id: "id-b", email: "b@x.com" };
  // id-a in use and filed, switched to an hour ago, its reading two hours old taken before that.
  const due = (d: Partial<Due> = {}, now = T) =>
    readingDue(
      {
        state: { active: "id-a", order: ["id-a", "id-b"], out: {}, switchedAt: T - H, filed: { mtime: 7, at: T - H } },
        saved: [a, b],
        mtime: 7,
        reading: { at: T - 2 * H, connectors: [], told: [] },
        running: false,
        ...d,
      },
      now,
    );
  const st = (s: Partial<State>): State => ({ active: "id-a", order: ["id-a", "id-b"], out: {}, switchedAt: T - H, filed: { mtime: 7, at: T - H }, ...s });

  test("a reading older than the switch is due", () => {
    expect(due()).toBe(true);
  });
  test("not with one saved login", () => {
    expect(due({ saved: [a] })).toBe(false);
  });
  test("not with no account in use, nor one that isn't saved", () => {
    expect(due({ state: st({ active: undefined }) })).toBe(false);
    expect(due({ state: st({ active: "id-z" }) })).toBe(false);
  });
  test("not while blimp can't tell whose login is in place", () => {
    expect(due({ state: st({ unknown: true }) })).toBe(false);
  });
  test("not with a change to the live login not yet filed, nor with no live login", () => {
    expect(due({ mtime: 8 })).toBe(false);
    expect(due({ mtime: undefined })).toBe(false);
    expect(due({ state: st({ filed: undefined }) })).toBe(false);
  });
  test("not 20 seconds after a switch; 30 seconds after, yes", () => {
    expect(due({ state: st({ switchedAt: T - 20_000 }) })).toBe(false);
    expect(due({ state: st({ switchedAt: T - 30_000 }) })).toBe(true);
  });
  test("no switch recorded: only the reading's age counts", () => {
    expect(due({ state: st({ switchedAt: undefined }) })).toBe(false);
    expect(due({ state: st({ switchedAt: undefined }), reading: undefined })).toBe(true);
  });
  test("a reading taken since the switch is fresh; none at all is due", () => {
    expect(due({ reading: { at: T - H + 1000, connectors: [], told: [] } })).toBe(false);
    expect(due({ reading: undefined })).toBe(true);
  });
  test("a reading 25 hours old is due, also with no switch since", () => {
    expect(due({ state: st({ switchedAt: T - 30 * H }), reading: { at: T - 25 * H, connectors: [], told: [] } })).toBe(true);
    expect(due({ state: st({ switchedAt: T - 30 * H }), reading: { at: T - 23 * H, connectors: [], told: [] } })).toBe(false);
  });
  test("not while one is running", () => {
    expect(due({ running: true })).toBe(false);
  });
  test("a failed one 5 minutes ago asks to wait; 11 minutes ago, no longer", () => {
    expect(due({ until: T - 5 * 60_000 + CONNECTORS_RETRY_MS })).toBe(false);
    expect(due({ until: T - 11 * 60_000 + CONNECTORS_RETRY_MS })).toBe(true);
  });
});

// The class on stand-ins: a temp accounts folder and live login file, a settable clock, and a fake
// claude mcp list and phone.
const listing = (...lines: string[]) => ["Checking MCP server health…", "", ...lines, ""].join("\n");
const line = (name: string, state = "✔ Connected") => `claude.ai ${name}: https://mcp.example.com/${name.replace(/ /g, "-")} - ${state}`;
const NEEDS = "! Needs authentication";
const ADD = "Add them at claude.ai/customize/connectors.";

// id-a and id-b saved, id-a live, filed and switched to an hour before T.
function watch() {
  const top = join(root, `t${++n}`);
  const dir = join(top, "accounts");
  const live = join(top, "claude", ".credentials.json");
  mkdirSync(join(top, "claude"), { recursive: true });
  saveLogin("id-a", creds("tok-A"), acct("id-a", "a@x.com"), dir);
  saveLogin("id-b", creds("tok-B"), acct("id-b", "b@x.com"), dir);
  const mtime = putLive("id-a", live, dir);
  writeState({ active: "id-a", order: ["id-a", "id-b"], out: {}, switchedAt: T - H, filed: { mtime, at: T - H } }, dir);
  const t = {
    dir,
    live,
    clock: T,
    out: listing() as string | undefined | (() => Promise<string | undefined>),
    lists: 0,
    told: [] as { title: string; body: string }[],
    refuse: false,
    logs: [] as Record<string, unknown>[],
  };
  const deps: ConnectorsDeps = {
    dir,
    live,
    list: async () => {
      t.lists++;
      return typeof t.out === "function" ? t.out() : t.out;
    },
    tell: async (title, body) => {
      if (t.refuse) throw new Error("the phone said no");
      t.told.push({ title, body });
    },
    log: (e) => void t.logs.push(e),
    now: () => t.clock,
  };
  return { t, c: new Connectors(deps) };
}
const stored = (dir: string, id = "id-a") => readConnectors(id, dir);

describe("Connectors", () => {
  test("a reading is stored, 600, and told kept when the gap is the one told", async () => {
    const { t, c } = watch();
    writeConnectors("id-b", { at: T - H, connectors: [ok("Slack"), ok("Zapier")], told: [] }, t.dir);
    writeConnectors("id-a", { at: T - 2 * H, connectors: [ok("Slack")], told: ["Zapier"] }, t.dir);
    t.out = listing(line("Slack"), line("Gmail", NEEDS), "ptc: uv run ptc-server - ✔ Connected");
    await c.tick();
    expect(t.lists).toBe(1);
    expect(stored(t.dir)).toEqual({ at: T, connectors: [ok("Slack"), signin("Gmail")], told: ["Zapier"] });
    expect(statSync(join(t.dir, "id-a", "connectors.json")).mode & 0o777).toBe(0o600);
    expect(t.told).toEqual([]);
    // Fresh now: the next tick asks nothing.
    t.clock = T + 1000;
    await c.tick();
    expect(t.lists).toBe(1);
  });

  test("a failed run stores nothing, logs once and waits 10 minutes; so does output without the health line", async () => {
    for (const out of [undefined, "Error: something went wrong\n"]) {
      const { t, c } = watch();
      t.out = out;
      await c.tick();
      expect(stored(t.dir)).toBeUndefined();
      expect(t.logs).toEqual([{ event: "connectors-failed", account: "id-a" }]);
      t.clock = T + 5 * 60_000;
      await c.tick();
      expect(t.lists).toBe(1);
      t.clock = T + CONNECTORS_RETRY_MS;
      t.out = listing(line("Slack"));
      await c.tick();
      expect(t.lists).toBe(2);
      expect(stored(t.dir)?.connectors).toEqual([ok("Slack")]);
      expect(t.logs).toHaveLength(1);
    }
  });

  test("a list that throws is a failed run too", async () => {
    const { t, c } = watch();
    t.out = async () => {
      throw new Error("spawn failed");
    };
    await c.tick();
    expect(stored(t.dir)).toBeUndefined();
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0].event).toBe("connectors-failed");
  });

  test("the first zero isn't stored; the second, 60 seconds later, is", async () => {
    const { t, c } = watch();
    await c.tick();
    expect(stored(t.dir)).toBeUndefined();
    t.clock = T + 30_000;
    await c.tick();
    expect(t.lists).toBe(1);
    t.clock = T + CONNECTORS_ZERO_AGAIN_MS;
    await c.tick();
    expect(t.lists).toBe(2);
    expect(stored(t.dir)).toEqual({ at: T + CONNECTORS_ZERO_AGAIN_MS, connectors: [], told: [] });
  });

  test("a zero more than 10 minutes after the first is a first zero again", async () => {
    const { t, c } = watch();
    await c.tick();
    t.clock = T + 11 * 60_000;
    await c.tick();
    expect(t.lists).toBe(2);
    expect(stored(t.dir)).toBeUndefined();
    t.clock += CONNECTORS_ZERO_AGAIN_MS;
    await c.tick();
    expect(stored(t.dir)?.connectors).toEqual([]);
  });

  test("a reading with connectors between two zeros: the second zero is a first one", async () => {
    const { t, c } = watch();
    await c.tick(); // zero, remembered
    // A new switch to the same account makes the stored reading old again.
    t.clock = T + CONNECTORS_ZERO_AGAIN_MS;
    t.out = listing(line("Slack"));
    await c.tick();
    expect(stored(t.dir)?.connectors).toEqual([ok("Slack")]);
    writeState({ ...readState(t.dir), switchedAt: t.clock + 1 }, t.dir);
    t.clock += CONNECTORS_ZERO_AGAIN_MS;
    t.out = listing();
    await c.tick();
    expect(stored(t.dir)?.connectors).toEqual([ok("Slack")]);
  });

  test("a zero after a stored reading with connectors needs its own second zero", async () => {
    const { t, c } = watch();
    writeConnectors("id-a", { at: T - 25 * H, connectors: [ok("Slack")], told: [] }, t.dir);
    await c.tick();
    expect(stored(t.dir)?.connectors).toEqual([ok("Slack")]);
    t.clock = T + CONNECTORS_ZERO_AGAIN_MS;
    await c.tick();
    expect(stored(t.dir)).toEqual({ at: T + CONNECTORS_ZERO_AGAIN_MS, connectors: [], told: [] });
  });

  test("the account changing during the run throws the reading away", async () => {
    const { t, c } = watch();
    t.out = async () => {
      const mtime = putLive("id-b", t.live, t.dir);
      writeState({ ...readState(t.dir), active: "id-b", switchedAt: t.clock, filed: { mtime, at: t.clock } }, t.dir);
      return listing(line("Slack"));
    };
    await c.tick();
    expect(stored(t.dir, "id-a")).toBeUndefined();
    expect(stored(t.dir, "id-b")).toBeUndefined();
    expect(t.logs).toEqual([]);
  });

  test("the live login changing, or blimp losing track of it, during the run throws the reading away", async () => {
    for (const after of ["unfiled", "unknown"]) {
      const { t, c } = watch();
      t.out = async () => {
        if (after === "unfiled") {
          writeFileSync(t.live, creds("tok-A2"));
          utimesSync(t.live, 1_000_000, 1_000_000); // a change the switcher hasn't filed
        }
        else writeState({ ...readState(t.dir), unknown: true }, t.dir);
        return listing(line("Slack"));
      };
      await c.tick();
      expect(stored(t.dir)).toBeUndefined();
    }
  });

  test("a gap is told once, not again, again once it changed, and again after it was empty in between", async () => {
    const { t, c } = watch();
    writeConnectors("id-b", { at: T - H, connectors: [ok("Slack"), ok("Zapier"), ok("Google Calendar")], told: [] }, t.dir);
    const reading = async (out: string) => {
      t.clock += 25 * H;
      t.out = out;
      await c.tick();
    };
    await reading(listing(line("Slack")));
    expect(t.told).toEqual([{ title: "a@x.com is missing connectors", body: `No Google Calendar, Zapier. ${ADD}` }]);
    expect(stored(t.dir)?.told).toEqual(["Google Calendar", "Zapier"]);
    expect(t.logs).toEqual([{ event: "connector-gap", account: "id-a", missing: ["Google Calendar", "Zapier"], signin: [] }]);

    await reading(listing(line("Slack")));
    expect(t.told).toHaveLength(1);

    await reading(listing(line("Slack", NEEDS), line("Zapier")));
    expect(t.told.at(-1)).toEqual({ title: "a@x.com is missing connectors", body: `No Google Calendar. Slack needs a sign-in. ${ADD}` });
    expect(stored(t.dir)?.told).toEqual(["Google Calendar", "!Slack"]);

    await reading(listing(line("Slack", NEEDS), line("Zapier"), line("Google Calendar")));
    expect(t.told.at(-1)?.body).toBe(`Slack needs a sign-in. ${ADD}`);

    await reading(listing(line("Slack"), line("Zapier"), line("Google Calendar")));
    expect(t.told).toHaveLength(3);
    expect(stored(t.dir)?.told).toEqual([]);

    await reading(listing(line("Slack", NEEDS), line("Zapier"), line("Google Calendar")));
    expect(t.told).toHaveLength(4);
    expect(t.told.at(-1)?.body).toBe(`Slack needs a sign-in. ${ADD}`);
  });

  test("an account with no email is named by its id", async () => {
    const { t, c } = watch();
    rmSync(join(t.dir, "id-a", "account.json"));
    writeConnectors("id-b", { at: T - H, connectors: [ok("Slack"), ok("Zapier")], told: [] }, t.dir);
    t.out = listing(line("Slack", NEEDS));
    await c.tick();
    expect(t.told).toEqual([{ title: "id-a is missing connectors", body: `No Zapier. Slack needs a sign-in. ${ADD}` }]);
  });

  test("a tell that throws stops nothing, and the gap is tried again at the next reading", async () => {
    const { t, c } = watch();
    writeConnectors("id-b", { at: T - H, connectors: [ok("Slack"), ok("Zapier")], told: [] }, t.dir);
    t.out = listing(line("Slack"));
    t.refuse = true;
    await c.tick();
    expect(stored(t.dir)).toEqual({ at: T, connectors: [ok("Slack")], told: [] });
    expect(t.logs).toEqual([{ event: "connector-gap", account: "id-a", missing: ["Zapier"], signin: [], error: "the phone said no" }]);
    t.refuse = false;
    t.clock += 25 * H;
    await c.tick();
    expect(t.told).toEqual([{ title: "a@x.com is missing connectors", body: `No Zapier. ${ADD}` }]);
    expect(stored(t.dir)?.told).toEqual(["Zapier"]);
  });

  test("two calls while one runs start only one", async () => {
    const { t, c } = watch();
    let finish!: (s: string) => void;
    t.out = () => new Promise<string>((r) => (finish = r));
    const first = c.tick();
    await c.tick();
    expect(t.lists).toBe(1);
    finish(listing(line("Slack")));
    await first;
    expect(stored(t.dir)?.connectors).toEqual([ok("Slack")]);
  });

  test("nothing is asked while the reading isn't due", async () => {
    const { t, c } = watch();
    writeConnectors("id-a", { at: T - 10_000, connectors: [ok("Slack")], told: [] }, t.dir);
    await c.tick();
    expect(t.lists).toBe(0);
  });
});
