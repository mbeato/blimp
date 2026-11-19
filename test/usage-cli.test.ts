// `blimpd usage` (src/usage/cli.ts): the text it prints for a fixed view. Times are made with local-time
// dates, so the clock and day it prints are the same in any time zone.

import { expect, test } from "bun:test";
import { runUsage, usageText } from "../src/usage/cli";
import type { NowView, Sum, UsageView } from "../src/usage/summary";

const AT = new Date(2026, 10, 19, 12, 0).getTime();
const H = 3_600_000;
const sum = (o: Partial<Sum>): Sum => ({ replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, helperCost: 0, ...o });

const view: UsageView = {
  scanning: false,
  firstDay: "2026-10-16",
  totals: sum({ replies: 4321, input: 1_200_000, output: 200_000, cacheRead: 1_500_000, cacheWrite: 500_000, cost: 1234.5 }),
  days: Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, byAccount: {}, byModel: {} })),
  accounts: [
    { ...sum({ input: 1_000_000, output: 150_000, cacheRead: 1_000_000, cacheWrite: 400_000, cost: 1200 }), id: "A", email: "a@x.com" },
    { ...sum({ input: 200_000, output: 50_000, cacheRead: 500_000, cacheWrite: 100_000, cost: 34.5 }), id: "codex" },
    { ...sum({ input: 950 }), id: "" },
  ],
  models: [
    { ...sum({ input: 1_000_000, output: 150_000, cacheRead: 1_000_000, cacheWrite: 400_000, cost: 1200 }), model: "claude-opus-5-5", priced: true },
    { ...sum({ input: 200_000, output: 50_000, cacheRead: 500_000, cacheWrite: 100_000, cost: 34.5 }), model: "gpt-6-astra", priced: true },
    { ...sum({ input: 950, output: 3 }), model: "GLM-5.3", priced: false },
  ],
  projects: [
    { ...sum({ input: 1_100_000, output: 180_000, cacheRead: 1_400_000, cacheWrite: 450_000, cost: 1100 }), project: "/home/u/blimp" },
    { ...sum({ input: 99_000, output: 20_000, cacheRead: 100_000, cacheWrite: 50_000, cost: 134.004 }), project: `/home/u/${"x".repeat(60)}/app` },
    { ...sum({ input: 1000, cost: 0.004 }), project: "" },
  ],
  unpriced: ["GLM-5.3"],
};

const now: NowView = {
  accounts: [
    {
      id: "A",
      email: "a@x.com",
      inUse: true,
      at: AT - 3 * H,
      fiveHour: { used: 62, resetsAt: new Date(2026, 10, 19, 14, 20).getTime(), reset: false },
      sevenDay: { used: 21.4, resetsAt: new Date(2026, 10, 24, 9, 0).getTime(), reset: false },
    },
    { id: "8c1f2a3b-0000-4000-8000-000000000000", inUse: false, at: AT - 50 * H, sevenDay: { used: 90, resetsAt: AT - 1000, reset: true } },
    { id: "C", email: "c@x.com", inUse: false },
  ],
  codex: {
    at: AT - 30_000,
    plan: "pro",
    windows: [
      { minutes: 300, used: 12, resetsAt: new Date(2026, 10, 19, 12, 10).getTime(), reset: false },
      { minutes: 10080, used: 40, resetsAt: new Date(2026, 10, 26, 8, 0).getTime(), reset: false },
    ],
  },
  today: { cost: 12.35, tokens: 1000 },
  statusline: true,
};

test("a fixed view: the limits, then the totals, then by account, model and project", () => {
  expect(usageText(view, now, AT)).toBe(SNAPSHOT);
});

test("while the first scan runs, only that", () => {
  expect(usageText({ ...view, scanning: true }, now, AT)).toBe("blimpd is counting your history. Try again in a few minutes.");
});

test("a model with no price says so in its cost column", () => {
  const line = usageText(view, now, AT)
    .split("\n")
    .find((l) => l.startsWith("GLM-5.3"))!;
  expect(line).toMatch(/ no price$/);
});

test("without the status line step, the line that says how to put it in place", () => {
  const text = usageText(view, { ...now, accounts: [], statusline: false }, AT);
  expect(text.split("\n")).toContain("Claude limits are not being read. Run: blimpd install-statusline");
  expect(usageText(view, now, AT)).not.toContain("install-statusline");
});

test("--days takes 1 to 3660; anything else is the usage line and 1", async () => {
  for (const args of [["--days"], ["--days", "0"], ["--days", "3661"], ["--days", "1.5"], ["--weeks", "2"], ["--days", "7", "x"]]) expect(await runUsage(args)).toBe(1);
});

const SNAPSHOT = [
  "a@x.com (in use): 5h 62% resets 14:20, week 21% resets Nov 24, as of 3 h ago",
  "8c1f2a3b-0000-4000-8000-000000000000: week reset, as of 2 d ago",
  "c@x.com: no numbers yet",
  "Codex (pro): 5h 12% resets 12:10, week 40% resets Nov 26, as of just now",
  "",
  "Last 30 days at API prices: $1,235",
  "Tokens: 3.4M (in 1.2M, out 200K, cached 2M). Replies: 4,321.",
  "",
  "By account                                         in      out   cached        cost",
  "a@x.com                                            1M     150K     1.4M      $1,200",
  "Codex                                            200K      50K     600K      $34.50",
  "Before account tracking                           950        0        0          $0",
  "",
  "By model                                           in      out   cached        cost",
  "claude-opus-5-5                                    1M     150K     1.4M      $1,200",
  "gpt-6-astra                                      200K      50K     600K      $34.50",
  "GLM-5.3                                           950        3        0    no price",
  "",
  "By project                                         in      out   cached        cost",
  "/home/u/blimp                                    1.1M     180K     1.9M      $1,100",
  "…xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/app        99K      20K     150K     $134.00",
  "Everything else                                    1K        0        0      <$0.01",
].join("\n");
