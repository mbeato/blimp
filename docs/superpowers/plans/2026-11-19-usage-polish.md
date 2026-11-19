# Usage, second round: a fuller bottom bar, a polished Usage window, a daily copy

> **For agentic workers:** work task by task, in order. Test first where a task names tests. Commit after each task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The bottom bar says where you are (server, branch, sessions, the focused session, jobs) as well as usage; the Usage window looks finished (cards for limits, headline numbers with context, a chart with a grid and a hover box, one tabbed table); blimpd keeps a daily copy of its usage database.

**Asked by Max, 2026-11-19, after 0.3.18:** "make it prettier/more polished in general, still feels basic/rough; can also fill out the bottom bar with more useful stuff", and "make sure it stops clearing the old usage data or we keep a copy on the server". He approved the design below.

**Spec this builds on:** `docs/superpowers/specs/2026-11-19-usage-design.md` (as built in 0.3.18). Task 5 adds this round to it.

**Tech stack:** Bun 1.4.3 at `~/.bun/bin/bun` (not on PATH: start commands with `export PATH=$HOME/.bun/bin:$PATH`), `bun:sqlite`, React 19, plain CSS. No new dependency.

## Global constraints

- Work only in `/Users/mbeato/blimp-usage` (branch `usage-polish`). Never touch another `blimp*` folder.
- Tests never read the real `~/.claude`, `~/.codex` or `~/.blimp`.
- The app never imports from `src/`.
- **Colour rules of this app (docs/DESIGN.md "Brand", `app/src/styles/theme.css`):** amber (`--waiting`) means "a session waits for you" and nothing else. So a limit meter has two looks only: normal, and `--danger` over 80%. Blue (`--unread`) means unread and links. Buttons are monochrome. The series colours (`--series-1` … `--series-rest`) are only for the chart and the dots that point at it.
- No emoji, no gradients, no new fonts, no drop shadows other than `--shadow` on the dialog and the hover box. Icons are inline SVG, 16 viewBox, `stroke="currentColor"`, `fill="none"`, as the icons in `App.tsx` are.
- Everything must read in the dark theme and both light blocks of `theme.css`. Numbers use `font-variant-numeric: tabular-nums`.
- `prefers-reduced-motion: reduce` turns off the transitions you add.
- Before the app tasks, load the `frontend-design:frontend-design` skill and the `dataviz` skill (Skill tool) if you have them, and use them inside the rules above: this app's look is quiet, dense and monochrome, like VS Code and Linear, not a marketing page.
- Checks: server `bun test --parallel` (baseline 1008 pass, 4 skip, 0 fail); app `cd app && bun test src && bunx tsc --noEmit` (baseline 264 pass, clean).
- Commits: titles as the repo's (`blimpd: …`, `Mac app: …`, `Docs: …`), one plain sentence saying what is now true. No `Co-Authored-By`, no attribution of any kind. Signed by the repo's config; if signing fails, stop and report. Do not push.
- Do not start a dev server, a browser, Tauri or blimpd. The reviewer checks the look.

---

### Task 1: The server sends what the window needs, and keeps a daily copy

**Files:** Modify `src/usage/summary.ts`, `src/usage/scan.ts`, `test/usage-summary.test.ts`, `test/usage-scan.test.ts`.

**`summarize` gains two optional fields on `UsageView`:**

```ts
previous?: Sum; // the same number of local days just before the range; absent for a range that starts at firstDay (nothing before it) 
hours?: { hour: number; byAccount: Record<string, number>; byModel: Record<string, number> }[]; // only when days === 1: the 24 local hours of today, 0 to 23, cost
```

- `previous`: when `today - days + 1 > firstDay`, the totals of local days `[from - days, from - 1]` (cut at `firstDay`), with cost worked out the same way. Else left out.
- `hours`: when `o.days === 1`, 24 entries. A row's local hour is `Math.floor((hour * 3_600_000 + tz * 60_000) / 3_600_000) mod 24` (mind negative numbers and half-hour zones: use the same floor-then-mod arithmetic `dayOf` uses, on minutes).

**The daily copy (in `scan.ts`, after `meta.scanEnded` is set):** when `<usage dir>/backups/usage-<YYYY-MM-DD>.db` (the UTC day of `now`) is not there, run ``db.run(`vacuum into ?`, [file])`` (it can't run inside a transaction; SQLite makes a whole, consistent file), `chmod` it 600 (folder 700), then delete all but the newest 7 files in `backups` whose names match `usage-\d{4}-\d{2}-\d{2}\.db`. A failure here must not fail the scan: catch it and write one line to stderr (`blimpd usage-scan: the daily copy failed: <why>`). `scan` needs the usage dir for this; it already has `dirs.usage`.

- [ ] Tests: `previous` for a 7-day range with data in the 7 days before; left out when the range starts at the first day; `hours` has 24 entries and puts a 23:30 UTC row in hour 0 at `tz = 60` (the next local day, so it shows only when that day is today); `hours` absent for `days = 7`. The copy: one scan makes today's file, mode 600, and it opens as a database with the same row count; a second scan the same day makes no second file; with 9 dated files there, 7 stay, the newest ones; a `backups` path that is a file (so the copy fails) leaves the scan's result intact.
- [ ] Code, both suites' server part green, commit: `blimpd: a copy of the usage database once a day, the last 7 kept; /usage also gives the period before and today by the hour`

### Task 2: Words and numbers for the app (pure, tested)

**Files:** Modify `app/src/lib/usage.ts`, `app/src/lib/usage.test.ts`. Add the two new optional fields to the app's copy of `UsageView`.

Add, all pure:

```ts
export const modelName: (id: string) => string;
// "claude-opus-5-5" → "Opus 5.5"; "claude-haiku-4-5-20251001" → "Haiku 4.5"; "claude-opus-4-8[1m]" → "Opus 4.8";
// "gpt-6-astra" → "GPT-6 Astra"; "gpt-5.6-terra" → "GPT-5.6 Terra"; anything else as written ("GLM-5.3", "morph-kimik31").
export const projectParts: (path: string, home?: string) => { name: string; where: string };
// "/Users/m/characterquilt/app" with home "/Users/m" → { name: "app", where: "~/characterquilt" }; home itself → { name: "~", where: "" };
// "" → { name: "Everything else", where: "" }.
export const change: (now: number, before: number | undefined) => string | undefined;
// 112, 100 → "12% more"; 80, 100 → "20% less"; equal within 0.5% → "the same"; before undefined or 0 → undefined.
export const axis: (max: number) => number[];
// 3 nice steps from 0 up to at least max: 2529 → [0, 1000, 2000, 3000]; 657 → [0, 250, 500, 750]; 0.8 → [0, 0.5, 1]; 0 → [0].
// Steps are 1, 2, 2.5 or 5 times a power of ten; the last one is the first that is ≥ max.
export const busiest: (days: { day: string; byModel: Record<string, number> }[]) => { day: string; cost: number } | undefined;
export type BarInfo = {
  branch?: string; pr?: { number: number; url: string; title: string };
  working: number; waiting: string[]; // waiting: the titles of the sessions that wait, for the hover text
  focused?: { label: string; used?: number; limit?: number }; // the focused session's model label and context
  jobs: string[]; // labels of running jobs in this folder's sessions
};
export const barInfo: (sessions: Session[], folder: string | null, focused: string | undefined) => BarInfo;
```

`barInfo` rules (`Session` is the type in `lib/api.ts`; read it):
- `working` and `waiting` count every session on the server (`state === "working"`, `state === "waiting"`), not only this folder's: a session that waits anywhere matters.
- `focused` is the session whose `name` is `focused`, when it has a `label` (so not a plain shell): `label`, and `context.used`/`context.limit` when there.
- Branch and pull request: from the focused session's `work` (`branch`, and the first of `prs` whose `state` is open, compared without case), else its `git?.branch`; with no focused session, from the first session whose `dir` is `folder` that has one. None: left out.
- `jobs`: the `label` of every job with `status === "running"` over the sessions whose `dir` is `folder`.

- [ ] Tests for every function with the examples above and the edges; `barInfo` with a small list of made-up sessions.
- [ ] Code, app checks clean, commit: `Mac app: names for models and projects, a nice axis, and what the bottom bar says, worked out in one tested place`

### Task 3: The bottom bar

**Files:** Modify `app/src/components/StatusBar.tsx`, `app/src/App.tsx`, `app/src/styles/app.css`.

Layout: 24 px high (was 22; move the toast and the transfers list by the same 2 px), `--bg-side`, top line `1px solid var(--line)`, 11 px text, `--fg-dim`. Two groups: the left one says where you are; the right one (`margin-left: auto`) is usage. An item is `.sb-item`: `inline-flex`, centred, 5 px gap, `0 9px` padding, full height, never wraps, text cut with an ellipsis at its own max width. An item that does something is a `<button>` and gets `var(--hover)` and `--fg` on hover and a visible focus ring as other buttons; one that only informs is a `<span>` with a `title`. A 12 px icon starts an item where it helps (branch, sessions, jobs). The bar never scrolls: when the window is too narrow, the left group gives way first (`min-width: 0`, `overflow: hidden`), the usage group stays whole.

Left group, in order, each left out when it has nothing to say:
1. **Server.** The link's status dot (reuse the class the Home tab's server dot uses in the top bar) and its name. `title`: `"<name> · blimpd <version> · <status>"`. Not a button.
2. **Branch.** Branch icon, the branch (max 200 px), and ` #<number>` when there is an open pull request. With a pull request it is a button that opens its URL the way the app opens links elsewhere (find how `Work.prs` is opened in `TerminalPane.tsx` and do the same); `title` is the pull request's title. Without one, a `<span>`.
3. **Sessions.** `N working` (left out at 0) and `N waiting` (left out at 0; the count and the word in `--waiting`, the one amber thing in the bar, since it is what amber means). A button: it opens Jump to Session (the `palette` dialog). `title` lists the waiting sessions' titles. Both 0: the item is left out.
4. **Focused session.** Its `label`, then a 28 px meter and the percent of its context when known (`--danger` over 80%, as its row's meter). `title`: "Context N% (used of limit tokens)" in the same words the session row uses. Not a button.
5. **Jobs.** `N jobs` when `jobs.length > 0`; `title` lists their labels, one per line. Not a button.

Right group: the usage button, as now, with these changes: a hairline (`1px solid var(--line)`) on its left edge; the account name in `--fg`, the labels (`5h`, `week`, `Codex`) in `--fg-faint`, the percents in `--fg-dim`; the meters 32 px wide and 4 px high with fully rounded ends; `today $657` last, the amount in `--fg`. Over 80% the fill and its percent are `--danger`. Keep its hover text and its rules for what is left out.

`App.tsx`: pass the bar what it needs: the front tab's `link`, its folder (`rootOf(t)`), and the name of the focused session of the front tab's panes (`t.panes[t.focus]`); `onOpen` for usage, and `onJump` that opens the palette. Use `barInfo` from Task 2; the bar holds no logic of its own beyond drawing and the usage polling it already has.

- [ ] Code; app checks clean; commit: `Mac app: the bottom bar also says the server, the branch and its pull request, sessions working and waiting, the focused session's model and context, and running jobs`

### Task 4: The Usage window

**Files:** Modify `app/src/components/UsageDialog.tsx`, `app/src/styles/app.css`, `app/src/styles/theme.css` only if a new variable is truly needed, `app/src/lib/usage.ts` if `chart` needs the hours.

The window is about 840 px wide, at most 86% of the window's height, and scrolls inside. Top to bottom:

1. **Head (stays in place while the body scrolls).** "Usage", the server's name in `--fg-faint`, and at the right the range control: Today, 7 days, 30 days, All; 30 days first. The control is one rounded track (`--bg-input`) with the chosen range as a raised pill (`--bg-raised`, `--fg`); the others `--fg-dim`. Use the same control for the two switches below (one component).

2. **Limits.** A grid of cards (`repeat(auto-fill, minmax(240px, 1fr))`, 10 px gap), one per account and one for Codex. A card: `1px solid var(--line)`, 8 px radius, 12 px padding, no fill. Top line: the account's name (the part before `@` in `--fg`, the rest in `--fg-faint`; `Codex` and its plan the same way), and at the right either a small filled dot with "in use" or the numbers' age ("3 h ago") in `--fg-faint`. Then one row per window: its name ("5-hour", "Weekly"), the percent at the right, under them a full-width meter 6 px high with rounded ends, and under that the reset time in 11 px `--fg-faint` ("resets in 3 h 48 min"; "reset" when its time has passed, with an empty meter and 0%). Over 80%: fill and percent `--danger`. An account with no numbers: "No numbers yet" in `--fg-faint` in place of the rows. The "limits are not being read" note stays under the grid.

3. **Headline numbers.** One bordered strip (same border and radius as a card) cut in four by hairlines, not four separate boxes. Each cell: a small label, the number at 26 px and weight 650, and one line of context in 11 px `--fg-faint`:
   - **Cost**: `money(totals.cost)`; context "at API prices · 12% more than the 30 days before" (`change`; left out without `previous`; never coloured, since more is not bad).
   - **Tokens**: `tokens(...)`; context "96% read from cache".
   - **Replies**: with thousands separators; context "70% of cost by helper agents" (`helperCost / cost`; left out at 0 cost).
   - **Per day**: `money(cost / days shown)`; context "busiest Nov 16 · $2,529". For Today this cell is **Per hour** with the busiest hour ("busiest 14:00 · $212").

4. **Cost per day** (Today: **Cost per hour**, 24 bars from `hours`). A card. Head: the title, and at the right the By account / By model switch. The plot is 190 px high with a 44 px gutter on the left:
   - Grid: one hairline per `axis(max)` step, its value in 10 px `--fg-faint` in the gutter, right-aligned, centred on its line. The top step is the top of the plot (so bars scale to the top step, not to the biggest day).
   - Bars: one per day (per week over 90 days, as now; per hour for Today), 2 px apart, at most 28 px wide and centred in their slot, stacked parts with no gap between them, a 2 px radius on the top corners of the whole bar only. Today's bar (the last one, or the current hour) is drawn at 70% opacity: it is not over yet.
   - Dates under the plot: the first, the last, and one about every 7 bars between, in 10 px `--fg-faint`, centred on their bar ("Oct 21"; hours as "00", "06", "12", "18").
   - Hover: the slot under the pointer gets a `var(--hover)` band from top to bottom, and a hover box appears beside it (to its left when the bar is in the right half): `--bg-raised`, `1px solid var(--line)`, 8 px radius, `--shadow`, 12 px text. It has the date ("Mon Nov 16", plus "so far" for today), the total in `--fg`, then one line per series that has cost that day, most first: dot, name, cost right-aligned. It never takes the pointer (`pointer-events: none`) and never leaves the card. No `title` attributes on the parts any more.
   - The plot is one `role="img"` with an `aria-label` that says the range, the total and the busiest day. Under it, the legend: dot, name, and that series' cost for the range in `--fg-dim`.
   - Names in the legend and the hover box: `accountName` or `modelName`.
   - Nothing in the range: "No cost in this range." centred in the plot's place.

5. **Breakdown.** A card. Head: the switch Accounts / Models / Projects (Models first). One table, most cost first:
   - **Name.** Accounts: a series dot when that account is one of the chart's "By account" series, then the name. Models: the dot the same way, then `modelName(id)`, with the id as written in `title`. Projects: `projectParts`: the name in `--fg`, then `where` in `--fg-faint`; the whole path in `title`.
   - **Share bar.** A 96 px track (`var(--hover)`) with a fill (`--fg-dim`) as wide as the row's share of the range's cost. Empty for an unpriced model.
   - **Cost** (`--fg`), **Share** ("66%", "<1%"), **Input**, **Output**, **Cached**, **Replies**. All right-aligned. "no price" in `--fg-faint` for an unpriced model, and "—" for its share.
   - Row height 30 px, a hairline between rows, the head row in 11 px `--fg-faint`, a `var(--hover)` fill on the row under the pointer.
   - Under the Models table, the two notes as now (`note`, and the "No price for…" line).

While the first scan runs: "Counting your history…" in the body, as now. A load error and the too-old-blimpd text: as now.

Keep `UsageDialog.tsx` readable: one small component per block (`Limits`, `Headline`, `CostChart`, `Breakdown`, and the shared `Choice`), each with a one-line comment. If the file passes about 450 lines, move `CostChart` to `components/UsageChart.tsx`.

- [ ] Code; app checks clean; commit: `Mac app: the Usage window has cards for the limits, headline numbers with their context, a chart with a grid and a hover box, today by the hour, and one tabbed table`

### Task 5: Docs

**Files:** Modify `docs/DESIGN.md`, `README.md`, `docs/MAC-CHECKLIST.md`, `docs/superpowers/specs/2026-11-19-usage-design.md`.

Say what is true now, as those files are written (short plain sentences, names in backticks):
- DESIGN.md: the bottom bar's items and what a click on each does; the Usage window's blocks; `previous` and `hours` in the API; the daily copy (where, when, how many kept) and how to put one back: stop blimpd, copy `backups/usage-<day>.db` over `usage.db`, delete `usage.db-wal` and `usage.db-shm`, start blimpd.
- README: the bar's line under "The window", and one sentence on the daily copy in "Usage and cost".
- MAC-CHECKLIST: Do/Expect steps for each bar item (and that each is left out when it has nothing to say), the hover box, Today by the hour, the tabs.
- The spec: a "Second round (0.3.19)" section listing what changed, and "A setting to hide the bottom bar" stays under "Not in this version".

- [ ] Commit: `Docs: the fuller bottom bar, the polished Usage window, and the daily copy of the usage database`

## Report back

Each commit hash; the last test and type-check counts; every place you built something differently and why; what you are unsure of, especially layout you could not see. Do not say a thing works unless you ran it.
