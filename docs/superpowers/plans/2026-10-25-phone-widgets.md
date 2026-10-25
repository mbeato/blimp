# Phone Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Home screen and lock screen widgets on the iPhone that show every project's sessions (needs you, new,
working), refreshed by a widget push from blimpd.

**Architecture:** blimpd works out a small summary (`GET /widget`, `src/widget.ts`) by the inbox's rules, readable
with a read-only widget key, and pings the widgets with an iOS 26 widget push when it changes (`src/push/widgets.ts`).
The app leaves the server's URL and the widget key in an App Group; a new widget extension (`ios/BlimpWidgets/`)
reads `GET /widget` with them and draws six widget families. BlimpKit holds the summary model, the words and the link.

**Tech Stack:** Bun + TypeScript (blimpd, `bun test`); SwiftUI + WidgetKit, iOS 26, Swift 6 (app) / Swift 5 mode
(widget extension); BlimpKit (Swift package, Swift Testing, Foundation only, also tested on Linux); XcodeGen; XCUITest;
GitHub Actions `.github/workflows/ios.yml`.

**Spec:** `docs/superpowers/specs/2026-10-25-phone-widgets-design.md`

## Global Constraints

- Commits: plain sentences with an area prefix (`blimpd: …`, `BlimpKit: …`, `iPhone: …`, `Docs: …`). Never a
  `Co-Authored-By` line or any Claude attribution.
- bun is at `~/.bun/bin/bun` and not on PATH. Run server tests as `PATH=$HOME/.bun/bin:$PATH bun test <files>`
  (some tests start bun as a subprocess and fail with "Executable not found in $PATH: bun" otherwise).
- There is no Swift toolchain on this machine (Linux). Swift is compiled only in CI. Write Swift exactly as given,
  re-read every edited region, and match the surrounding style.
- BlimpKit stays Foundation-only (it is tested on Linux): no WidgetKit, SwiftUI, CryptoKit or
  `FileManager.containerURL` in it.
- Exact values (from the spec): App Group `group.dev.blimp.phone`; widget extension bundle id
  `dev.blimp.phone.widgets`; widget push topic `dev.blimp.phone.push-type.widgets`, `apns-push-type: widgets`,
  priority 5, body `{"aps":{"content-changed":true}}`; links `blimp://open?session=<name>` and `blimp://open`; the
  widget key is HMAC-SHA256 of the phone's token with the text `blimp widget`, hex; at most 9 rows; a ping at most
  every 2 minutes except a new needs-you, at once.
- Words shown (from the spec): `? 1 needs you`, `✓ 2 new`, `● 3 working`, `? 1 · ✓ 2 · ● 3`, `All quiet`,
  `as of <time>`, `Update blimpd for widgets`.
- Symbols: `?` needs you, `✓` new, `●` working.
- Every UI test must be in a shard list in `.github/workflows/ios.yml`.
- iOS CI: never start a manual iOS run (`gh workflow run iOS …`) while main's push iOS run is going; they share the
  MacBook's runners and ports.

## File map

- Create `src/widget.ts`: the summary rules, its change shape, the widget key.
- Modify `src/push/store.ts`: push.json keeps `widgets` beside `devices`.
- Modify `src/server.ts`: the widget key in `authorized`, `GET /widget`, `GET /widget/key`, `POST`/`DELETE /push/widget`.
- Modify `src/push/apns.ts`: a widgets push type (topic, priority).
- Create `src/push/widgets.ts`: the pinger.
- Modify `src/push/watch.ts`: one shared Apple client, and the pinger's tick beside the watcher's.
- Tests: `test/widget.test.ts` (new), `test/push-widgets.test.ts` (new), `test/push-store.test.ts`,
  `test/push-apns.test.ts`, `test/server.test.ts`.
- Create `ios/BlimpKit/Sources/BlimpKit/Widgets.swift` and `ios/BlimpKit/Tests/BlimpKitTests/WidgetsTests.swift`.
- Create `ios/Blimp/WidgetShare.swift`; modify `ios/Blimp/Net/API.swift`, `ios/Blimp/Model/Store.swift`,
  `ios/Blimp/BlimpApp.swift`, `ios/project.yml`, `ios/.gitignore`.
- Create `ios/BlimpWidgets/BlimpWidgets.swift`, `ios/BlimpWidgets/SessionsView.swift`.
- Modify `ios/BlimpUITests/BlimpUITests.swift`, `.github/workflows/ios.yml`.
- Docs: `docs/DESIGN.md`, `docs/SECURITY.md`, `ios/README.md`, `docs/PHONE-CHECKLIST.md`.

---

### Task 1: blimpd's widget summary and widget key

**Files:**
- Create: `src/widget.ts`
- Test: `test/widget.test.ts`

**Interfaces:**
- Consumes: `Session` from `src/sessions.ts` (fields used: `name`, `dir`, `title`, `state`, `stateSince?`,
  `updatedAt?`, `created` (seconds), `unread`, `note?: { status: "done" | "progress" | "question"; text; at }`).
- Produces:
  - `type WidgetState = "needs" | "new" | "working"`
  - `type WidgetRow = { session: string; dir: string; title: string; state: WidgetState; since: number }`
  - `type WidgetSummary = { at: number; counts: { needs: number; new: number; working: number }; rows: WidgetRow[]; lastFinished?: number }`
  - `MAX_ROWS = 9`
  - `widgetSummary(sessions: Session[], hidden: Set<string>, now?: number): WidgetSummary`
  - `widgetShape(w: WidgetSummary): string`
  - `widgetKey(phoneToken: string): string` ("" for "")

- [ ] **Step 1: Write the failing test**

Create `test/widget.test.ts`:

```ts
// What the phone's widgets show (src/widget.ts): every running session outside the hidden projects, by the inbox's
// rules, and the widget key.

import { expect, test } from "bun:test";
import type { Session } from "../src/sessions";
import { MAX_ROWS, widgetKey, widgetShape, widgetSummary } from "../src/widget";

const T = 1_800_000_000_000;
const s = (name: string, o: Partial<Session> = {}): Session => ({
  name,
  pid: 1,
  clients: 0,
  created: (T - 3_600_000) / 1000,
  dir: "/u/blimp",
  cmd: "claude",
  kind: "claude",
  title: name,
  status: "idle",
  state: "done",
  unread: false,
  ...o,
});
const order = (sessions: Session[], hidden: string[] = []) =>
  widgetSummary(sessions, new Set(hidden), T).rows.map((r) => [r.session, r.state]);

test("needs you: a waiting session, and a done one with a question in its note, the oldest wait first", () => {
  const late = s("late", { state: "waiting", stateSince: T - 1000 });
  const asks = s("asks", { stateSince: T - 5000, note: { status: "question", text: "Which one?", at: T } });
  expect(order([late, asks])).toEqual([["asks", "needs"], ["late", "needs"]]);
  expect(widgetSummary([late, asks], new Set(), T).counts).toEqual({ needs: 2, new: 0, working: 0 });
});

test("new: done and unread, the newest first; one still in progress by its note, or read, isn't", () => {
  const old = s("old", { unread: true, updatedAt: T - 9000 });
  const recent = s("recent", { unread: true, updatedAt: T - 1000 });
  const midway = s("midway", { unread: true, note: { status: "progress", text: "Halfway", at: T } });
  const read = s("read");
  expect(order([old, recent, midway, read])).toEqual([["recent", "new"], ["old", "new"]]);
});

test("working: the longest-running first, after needs you and new", () => {
  const short = s("short", { state: "working", stateSince: T - 60_000 });
  const long = s("long", { state: "working", stateSince: T - 3_000_000 });
  const ask = s("ask", { state: "waiting", stateSince: T });
  const fresh = s("fresh", { unread: true });
  expect(order([short, long, ask, fresh])).toEqual([["ask", "needs"], ["fresh", "new"], ["long", "working"], ["short", "working"]]);
});

test("every project's sessions, the hidden projects' left out", () => {
  const a = s("a", { dir: "/u/cq", state: "working", stateSince: T - 5000 });
  const b = s("b", { dir: "/u/blimp", state: "working", stateSince: T - 9000 });
  const secret = s("secret", { dir: "/u/secret", state: "waiting" });
  expect(order([a, b, secret], ["/u/secret"])).toEqual([["b", "working"], ["a", "working"]]);
  expect(widgetSummary([a, b, secret], new Set(["/u/secret"]), T).counts).toEqual({ needs: 0, new: 0, working: 2 });
});

test("at most 9 rows; the counts count them all", () => {
  const many = Array.from({ length: 12 }, (_, i) => s(`w${i}`, { state: "working", stateSince: T - i }));
  const w = widgetSummary(many, new Set(), T);
  expect(w.rows.length).toBe(MAX_ROWS);
  expect(MAX_ROWS).toBe(9);
  expect(w.counts.working).toBe(12);
});

test("a row's since: when it started waiting or working, else its newest activity", () => {
  const w = widgetSummary([s("a", { state: "working", stateSince: T - 7000 }), s("b", { unread: true, updatedAt: T - 3000 })], new Set(), T);
  expect(w.rows.map((r) => r.since)).toEqual([T - 3000, T - 7000]);
  expect(w.rows[0]).toEqual({ session: "b", dir: "/u/blimp", title: "b", state: "new", since: T - 3000 });
  expect(w.at).toBe(T);
});

test("lastFinished: when the last done session finished; none with none done", () => {
  expect(widgetSummary([s("a", { stateSince: T - 9000 }), s("b", { stateSince: T - 2000 })], new Set(), T).lastFinished).toBe(T - 2000);
  expect("lastFinished" in widgetSummary([s("a", { state: "working" })], new Set(), T)).toBe(false);
});

test("the shape changes with the counts and the rows' states, not with a working row's time", () => {
  const shape = (o: Partial<Session>) => widgetShape(widgetSummary([s("a", { state: "working", ...o })], new Set(), T));
  expect(shape({ stateSince: T - 1000, updatedAt: T })).toBe(shape({ stateSince: T - 1000, updatedAt: T - 500 }));
  expect(shape({})).not.toBe(shape({ state: "waiting" }));
});

test("the widget key: HMAC-SHA256 of the phone's token with the text 'blimp widget', hex; none without a token", () => {
  expect(widgetKey("abc")).toBe("7a0a9292d52985672c308670910039f0f48e762e6393d92d5a1233f6762c52ff");
  expect(widgetKey("abd")).not.toBe(widgetKey("abc"));
  expect(widgetKey("")).toBe("");
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/widget.test.ts`
Expected: FAIL, `Cannot find module '../src/widget'`.

- [ ] **Step 3: Write `src/widget.ts`**

```ts
// What the phone's widgets show (docs/superpowers/specs/2026-10-25-phone-widgets-design.md): every running session
// outside the hidden projects, by the rules the inbox gives each session (ios/BlimpKit/Sources/BlimpKit/Inbox.swift,
// app/src/lib/inbox.ts): needs you (waiting, or done with a question in its note), the oldest wait first; new (done
// and unread, its note not "in progress"), the newest first; working, the longest-running first. At most 9 rows, for
// the large widget. Past conversations stay in their project's inbox, as the drawer's project marks leave them out.
// The widget key, which reads only GET /widget (server.ts), comes from the phone's token.

import { createHmac } from "node:crypto";
import type { Session } from "./sessions";

export type WidgetState = "needs" | "new" | "working";
export type WidgetRow = { session: string; dir: string; title: string; state: WidgetState; since: number };
export type WidgetSummary = { at: number; counts: { needs: number; new: number; working: number }; rows: WidgetRow[]; lastFinished?: number };

export const MAX_ROWS = 9;

// ms: its newest activity, as the phone's Session.activity has it.
const activity = (s: Session) => Math.max(s.updatedAt ?? 0, s.stateSince ?? 0, s.created * 1000);
// ms: when it started waiting or working, else its activity (InboxLine.since).
const since = (s: Session) => s.stateSince ?? activity(s);

function widgetState(s: Session): WidgetState | undefined {
  if (s.state === "waiting" || (s.state === "done" && s.note?.status === "question")) return "needs";
  if (s.state === "done" && s.unread && s.note?.status !== "progress") return "new";
  if (s.state === "working") return "working";
}

// Ties keep the list's order: sort is stable.
export function widgetSummary(sessions: Session[], hidden: Set<string>, now = Date.now()): WidgetSummary {
  const shown = sessions.filter((s) => !hidden.has(s.dir));
  const of = (state: WidgetState) => shown.filter((s) => widgetState(s) === state);
  const needs = of("needs").sort((a, b) => since(a) - since(b));
  const fresh = of("new").sort((a, b) => activity(b) - activity(a));
  const working = of("working").sort((a, b) => since(a) - since(b));
  const row = (state: WidgetState) => (s: Session): WidgetRow => ({ session: s.name, dir: s.dir, title: s.title, state, since: since(s) });
  const rows = [...needs.map(row("needs")), ...fresh.map(row("new")), ...working.map(row("working"))].slice(0, MAX_ROWS);
  const finished = shown.filter((s) => s.state === "done").map(since);
  return {
    at: now,
    counts: { needs: needs.length, new: fresh.length, working: working.length },
    rows,
    ...(finished.length ? { lastFinished: Math.max(...finished) } : {}),
  };
}

// What the widgets show, for the pinger to tell a change: the counts, and the rows and their states in order. A
// working row's time isn't a change (the widget counts it up by itself).
export const widgetShape = (w: WidgetSummary) => JSON.stringify([w.counts, w.rows.map((r) => [r.session, r.state])]);

// HMAC-SHA256 of the phone's token with the text "blimp widget", hex. No phone paired: none.
export const widgetKey = (phoneToken: string) => (phoneToken ? createHmac("sha256", phoneToken).update("blimp widget").digest("hex") : "");
```

- [ ] **Step 4: Run the test to see it pass**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/widget.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Type check**

Run: `PATH=$HOME/.bun/bin:$PATH bunx tsc --noEmit -p . 2>&1 | grep -E "src/widget.ts|test/widget.test.ts" || echo "no errors in the new files"`
Expected: `no errors in the new files` (the repo has older type errors elsewhere; only the new files must be clean).

- [ ] **Step 6: Commit**

```bash
git add src/widget.ts test/widget.test.ts
git commit -m "blimpd: the widgets' summary (needs you, new, working across every project but the hidden ones, by the inbox's rules, at most 9 rows) and the widget key, HMAC-SHA256 of the phone's token"
```

---

### Task 2: blimpd's widget routes, the widget key's reach, and widget push tokens

**Files:**
- Modify: `src/push/store.ts`
- Modify: `src/server.ts` (`authorized` near line 82, the fetch handler near line 432, `route()` from line 110, the
  `/push/device` route near line 255)
- Test: `test/push-store.test.ts`, `test/server.test.ts`
- Docs: `docs/DESIGN.md`, `docs/SECURITY.md`

**Interfaces:**
- Consumes: `widgetKey`, `widgetSummary` from `src/widget.ts` (Task 1).
- Produces (store): `isWidgetToken(t: unknown): t is string`, `readWidgets(file?): Device[]`,
  `addWidget(token, env, now?, file?): Device[]`, `removeWidget(token, file?): Device[]`. `readDevices`,
  `addDevice`, `removeDevice`, `clearDevices` keep their signatures and behaviour.
- Produces (HTTP): `GET /widget` → `WidgetSummary`; `GET /widget/key` → `{ key }`, 404 with no phone paired;
  `POST /push/widget { token, env }` → 204; `DELETE /push/widget { token }` → 204.

- [ ] **Step 1: Write the failing store test**

Append to `test/push-store.test.ts` (add any missing names to its imports: `mkdtempSync`, `readFileSync`,
`statSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, and `addDevice`, `addWidget`,
`isWidgetToken`, `readDevices`, `readWidgets`, `removeWidget` from `../src/push/store`):

```ts
test("widget push tokens are kept beside the devices, and each list leaves the other as it was", () => {
  const file = join(mkdtempSync(join(tmpdir(), "blimp-push-")), "push.json");
  addDevice("a".repeat(64), "production", 1, file);
  addWidget("AB".repeat(50), "development", 2, file);
  expect(readDevices(file).map((d) => d.token)).toEqual(["a".repeat(64)]);
  expect(readWidgets(file)).toEqual([{ token: "ab".repeat(50), env: "development", at: 2 }]);
  addDevice("b".repeat(64), "production", 3, file);
  expect(readWidgets(file).length).toBe(1);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  removeWidget("ab".repeat(50), file);
  expect(readWidgets(file)).toEqual([]);
  expect(readDevices(file).map((d) => d.token[0])).toEqual(["b", "a"]);
  // no widgets: push.json is as it was before widgets
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["devices"]);
});

test("a widget push token is hex, 64 to 400 characters", () => {
  expect(isWidgetToken("ab".repeat(32))).toBe(true);
  expect(isWidgetToken("ab".repeat(200))).toBe(true);
  expect(isWidgetToken("ab".repeat(201))).toBe(false);
  expect(isWidgetToken("xyz")).toBe(false);
  expect(isWidgetToken(5)).toBe(false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-store.test.ts`
Expected: FAIL, `addWidget` (and the others) not exported.

- [ ] **Step 3: Rewrite push.json's reading and writing in `src/push/store.ts`**

Change the header comment's push.json part to:
`push.json { devices: [{ token, env, at }], widgets: [...] }, the phones that asked for notifications and the widgets'
push tokens (iOS 26 widget push, src/push/widgets.ts).`

Below `isPushEnv`, add:

```ts
// WidgetKit's push tokens: hex, longer than a device's can be.
export const isWidgetToken = (t: unknown): t is string => typeof t === "string" && /^[0-9a-f]{64,400}$/i.test(t);
```

Replace `readDevices`, `addDevice` and `removeDevice` (keep `clearDevices` as it is) with:

```ts
type Lists = { devices: Device[]; widgets: Device[] };

const valid = (list: unknown, isToken: (t: unknown) => boolean): Device[] =>
  Array.isArray(list) ? list.filter((x) => isToken(x?.token) && isPushEnv(x?.env) && typeof x?.at === "number") : [];

// Missing or unreadable: none. Entries that aren't phones (or widgets) are left out.
function readLists(file: string): Lists {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return { devices: valid(j?.devices, isDeviceToken), widgets: valid(j?.widgets, isWidgetToken) };
  } catch {}
  return { devices: [], widgets: [] };
}

// No widgets: the file is as it was before them.
const writeLists = (file: string, l: Lists) => write(file, JSON.stringify({ devices: l.devices, ...(l.widgets.length ? { widgets: l.widgets } : {}) }));

// Adds one, or moves it to the front with its env and time; only the 5 newest are kept.
function add(key: keyof Lists, token: string, env: PushEnv, now: number, file: string): Device[] {
  const t = token.toLowerCase();
  const l = readLists(file);
  l[key] = [{ token: t, env, at: now }, ...l[key].filter((d) => d.token !== t)].slice(0, MAX_DEVICES);
  writeLists(file, l);
  return l[key];
}

function remove(key: keyof Lists, token: string, file: string): Device[] {
  const t = token.toLowerCase();
  const l = readLists(file);
  const had = l[key].length;
  l[key] = l[key].filter((d) => d.token !== t);
  if (l[key].length !== had) writeLists(file, l);
  return l[key];
}

export const readDevices = (file = devicesFile()): Device[] => readLists(file).devices;
export const addDevice = (token: string, env: PushEnv, now = Date.now(), file = devicesFile()) => add("devices", token, env, now, file);
export const removeDevice = (token: string, file = devicesFile()) => remove("devices", token, file);

export const readWidgets = (file = devicesFile()): Device[] => readLists(file).widgets;
export const addWidget = (token: string, env: PushEnv, now = Date.now(), file = devicesFile()) => add("widgets", token, env, now, file);
export const removeWidget = (token: string, file = devicesFile()) => remove("widgets", token, file);
```

Change `clearDevices`' comment to: `// \`blimpd pair --revoke\`: a phone that can't connect gets no notifications, and its widgets no pings.`

- [ ] **Step 4: Run the store tests**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-store.test.ts test/push-watch.test.ts`
Expected: PASS (the old device tests too).

- [ ] **Step 5: Write the failing server tests**

Append to `test/server.test.ts` (import `widgetKey` from `../src/widget`; `rmSync`, `writeFileSync`, `readFileSync`,
`statSync` from `node:fs` if not imported yet):

```ts
describe("widgets", () => {
  const phoneFile = join(tmp, "phone-token");
  const phone = "beef".repeat(16);
  const key = widgetKey(phone);
  const withToken = (t: string, path: string, init: RequestInit = {}) => api(path, { ...init, headers: { Authorization: `Bearer ${t}` } }, false);

  test("GET /widget: the counts and rows, with the widget key or the phone's or the Mac's token", async () => {
    writeFileSync(phoneFile, phone);
    try {
      for (const t of [key, phone, token]) {
        const r = await withToken(t, "/widget");
        expect(r.status).toBe(200);
        const w = await r.json();
        expect(Object.keys(w.counts).sort()).toEqual(["needs", "new", "working"]);
        expect(Array.isArray(w.rows)).toBe(true);
        expect(typeof w.at).toBe("number");
      }
    } finally {
      rmSync(phoneFile, { force: true });
    }
  });

  test("the widget key reads GET /widget and nothing else", async () => {
    writeFileSync(phoneFile, phone);
    try {
      expect((await withToken(key, "/sessions")).status).toBe(401);
      expect((await withToken(key, "/widget/key")).status).toBe(401);
      expect((await withToken(key, "/health")).status).toBe(401);
      const push = JSON.stringify({ token: "ab".repeat(50), env: "production" });
      expect((await withToken(key, "/push/widget", { method: "POST", body: push })).status).toBe(401);
    } finally {
      rmSync(phoneFile, { force: true });
    }
  });

  test("GET /widget/key gives the phone its widget key; pairing again changes it; with no phone paired, 404", async () => {
    writeFileSync(phoneFile, phone);
    try {
      expect(await (await withToken(phone, "/widget/key")).json()).toEqual({ key });
      const again = "f00d".repeat(16);
      writeFileSync(phoneFile, again);
      expect(await (await withToken(again, "/widget/key")).json()).toEqual({ key: widgetKey(again) });
      // the old key no longer reads anything
      expect((await withToken(key, "/widget")).status).toBe(401);
    } finally {
      rmSync(phoneFile, { force: true });
    }
    expect((await api("/widget/key")).status).toBe(404);
  });

  test("POST and DELETE /push/widget keep the widgets' push tokens in push.json, beside the devices", async () => {
    const widget = (t: unknown, env: unknown = "production", method = "POST") => api("/push/widget", { method, body: JSON.stringify({ token: t, env }) });
    const file = () => JSON.parse(readFileSync(join(tmp, "push.json"), "utf8"));
    expect((await widget("ab".repeat(50))).status).toBe(204);
    expect(file().widgets.map((w: { token: string }) => w.token)).toEqual(["ab".repeat(50)]);
    expect(statSync(join(tmp, "push.json")).mode & 0o777).toBe(0o600);
    expect((await widget("ab".repeat(50), undefined, "DELETE")).status).toBe(204);
    expect(file().widgets).toBeUndefined();
    expect((await widget("xyz")).status).toBe(400);
    expect((await widget("ab".repeat(50), "staging")).status).toBe(400);
    expect((await api("/push/widget", { method: "POST", body: "null" })).status).toBe(400);
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "widgets"`
Expected: FAIL (404s, and the widget key gets 401 on `/widget`).

- [ ] **Step 7: The widget key in `authorized` and the fetch handler (`src/server.ts`)**

Import `widgetKey` and `widgetSummary` from `./widget`, and `addWidget`, `isWidgetToken`, `removeWidget` beside the
store's other names in the existing `./push/store` import. Make sure `listSessionsLite` and `blimpDir` are in the
`./sessions` import and `readHidden` in the `./hidden` one (add whichever is missing).

Replace `authorized` with:

```ts
// Which token the request carries: the Mac's, the phone's (its value), the widget key (it reads only GET /widget,
// widget.ts), or none (undefined).
function authorized(req: Request, url: URL, token: string, dir: string): "mac" | "widget" | { phone: string } | undefined {
  // HTTP sends a Bearer header; WebSockets can't, so they send ?token=.
  const h = req.headers.get("authorization");
  const given = Buffer.from(h?.startsWith("Bearer ") ? h.slice(7) : (url.searchParams.get("token") ?? ""));
  const phone = readPhoneToken(dir);
  // All compared every time, so the answer takes as long whichever matched.
  const [mac, ph, widget] = [same(given, token), same(given, phone), same(given, widgetKey(phone))];
  return mac ? "mac" : ph ? { phone } : widget ? "widget" : undefined;
}
```

In the fetch handler, replace

```ts
      if (!who) return error(401, "wrong or missing token");
```

with

```ts
      // The widget key reads the widgets' summary and nothing else.
      if (!who || (who === "widget" && !(url.pathname === "/widget" && req.method === "GET"))) return error(401, "wrong or missing token");
```

and in the same handler change `who === "mac" ? undefined : who.phone` to
`who === "mac" || who === "widget" ? undefined : who.phone`.

- [ ] **Step 8: The routes (`src/server.ts`, inside `route()`)**

Check how `serve()` computes the `dir` it passes to `authorized`. If it isn't `blimpDir()`, use that same value
below instead of `blimpDir()`.

Right after the `/push/device` route, add:

```ts
  // The widgets' push tokens (iOS 26 widget push): the pinger (push/widgets.ts) tells them to reload.
  if (path === "/push/widget" && (req.method === "POST" || req.method === "DELETE")) {
    const { token: widget, env } = ((await req.json()) ?? {}) as Record<string, unknown>;
    if (!isWidgetToken(widget)) throw new HttpError(400, "token must be the widgets' push token, in hex");
    if (req.method === "DELETE") removeWidget(widget);
    else if (isPushEnv(env)) addWidget(widget, env);
    else throw new HttpError(400, 'env must be "development" or "production"');
    return new Response(null, { status: 204 });
  }

  // The phone's widgets (widget.ts): what they show, and the key they read it with while the phone is locked.
  if (path === "/widget" && get) return Response.json(widgetSummary(listSessionsLite(claudeDir(), await zmxListAsync()), new Set(readHidden())));
  if (path === "/widget/key" && get) {
    const key = widgetKey(phone ?? readPhoneToken(blimpDir()));
    if (!key) throw new HttpError(404, "no phone is paired (blimpd pair)");
    return Response.json({ key });
  }
```

- [ ] **Step 9: Run the server tests**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts test/push-store.test.ts test/widget.test.ts`
Expected: PASS.

- [ ] **Step 10: Docs**

In `docs/DESIGN.md`, after the last bullet of the phone notifications section (the one with `POST /push/device`,
near line 343, and any bullets after it in that section), add:

```markdown
### Widgets

The iPhone's widgets (home screen and lock screen; design in `docs/superpowers/specs/2026-10-25-phone-widgets-design.md`) show every project's running sessions, the hidden projects' left out, by the rules the inbox gives each session: needs you (waiting, or done with a question in its note; the oldest wait first), new (done and unread, the note not "in progress"; the newest first) and working (the longest-running first).

- **`GET /widget`** → `{ at, counts: { needs, new, working }, rows: [{ session, dir, title, state, since }], lastFinished? }`, at most 9 rows (`src/widget.ts`). `since` is when it started waiting or working (ms).
- **The widget key** reads `GET /widget` and nothing else (anything else answers it 401), so the widgets can read while the phone is locked without the phone's token, which stays in the keychain until Face ID. It is HMAC-SHA256 of the phone's token with the text `blimp widget`, hex. The app gets it with `GET /widget/key` (phone token) → `{ key }`, 404 with no phone paired. `blimpd pair` makes a new phone token, and so a new key.
- **Widget push tokens:** `POST /push/widget { "token": hex, "env" }` → 204 and `DELETE /push/widget { "token" }` → 204, kept in push.json's `widgets` beside its `devices` (at most 5); 400 for a token that isn't hex or another env. `blimpd pair --revoke` removes them with the devices.
```

In `docs/SECURITY.md`'s threat table, after the row that starts `| Someone who sees your locked phone |`, add:

```markdown
| Someone who gets the widget key (it's in blimp's App Group on the phone) | Read session titles and counts | It reads `GET /widget` and nothing else. `blimpd pair` again replaces it. |
| Someone who sees your locked phone, with blimp's rectangular widget on the lock screen | Read session titles | It shows the top two titles, as notifications show their text. The round and inline widgets show counts only. |
```

- [ ] **Step 11: Commit**

```bash
git add src/push/store.ts src/server.ts test/push-store.test.ts test/server.test.ts docs/DESIGN.md docs/SECURITY.md
git commit -m "blimpd: GET /widget for the phone's widgets, readable with a widget key that reads nothing else (GET /widget/key gives the phone it), and the widgets' push tokens in push.json beside the devices (POST and DELETE /push/widget)"
```

---

### Task 3: blimpd pings the widgets when what they show changes

**Files:**
- Modify: `src/push/apns.ts` (`PushOptions`, the headers in `once`)
- Create: `src/push/widgets.ts`
- Modify: `src/push/watch.ts` (the `live.send` client, `startPush`)
- Test: `test/push-apns.test.ts`, `test/push-widgets.test.ts` (new)
- Docs: `docs/DESIGN.md`

**Interfaces:**
- Consumes: `widgetSummary`, `widgetShape` (Task 1); `readWidgets`, `removeWidget` (Task 2); `Apns`, `goneDevice`,
  `Sent`, `TOPIC` from `src/push/apns.ts`.
- Produces: `PushOptions = { collapseId?: string; type?: "alert" | "widgets" }`; `PING`, `PING_GAP`, `WidgetDeps`,
  `WidgetPinger` (with `tick(): Promise<void>`) from `src/push/widgets.ts`; `apnsFor(c: Creds): Apns` from
  `src/push/watch.ts`.

- [ ] **Step 1: Write the failing APNs test**

Append to `test/push-apns.test.ts`, after the test "a send: the device's path, Apple's headers, …" (it uses that
file's `reset`, `got`, `creds`, `hosts`, `device` and `TOPIC`):

```ts
test("a widget ping: the widgets push type, its own topic, and priority 5", async () => {
  reset();
  const a = new Apns(creds, hosts);
  try {
    expect(await a.send(device, { aps: { "content-changed": true } }, { type: "widgets" })).toEqual({ status: 200 });
    const [g] = got;
    expect(g.headers["apns-topic"]).toBe(`${TOPIC}.push-type.widgets`);
    expect(g.headers["apns-push-type"]).toBe("widgets");
    expect(g.headers["apns-priority"]).toBe("5");
    expect(g.headers["apns-collapse-id"]).toBeUndefined();
  } finally {
    a.close();
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-apns.test.ts`
Expected: FAIL on the topic (`dev.blimp.phone` is sent).

- [ ] **Step 3: The widgets push type in `src/push/apns.ts`**

Replace `export type PushOptions = { collapseId?: string };` with:

```ts
// type widgets: a widget push (iOS 26), which only tells WidgetKit to reload the widgets: its own topic, priority 5.
export type PushOptions = { collapseId?: string; type?: "alert" | "widgets" };
```

In `once`, replace the three header lines

```ts
        "apns-topic": TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
```

with

```ts
        "apns-topic": o.type === "widgets" ? `${TOPIC}.push-type.widgets` : TOPIC,
        "apns-push-type": o.type ?? "alert",
        "apns-priority": o.type === "widgets" ? "5" : "10",
```

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-apns.test.ts` — Expected: PASS.

- [ ] **Step 4: Write the failing pinger test**

Create `test/push-widgets.test.ts`:

```ts
// The widgets' pinger (src/push/widgets.ts) on stand-ins: the session list, the clock, the hidden projects, and Apple.

import { expect, test } from "bun:test";
import type { Sent } from "../src/push/apns";
import type { Creds, Device } from "../src/push/store";
import { PING, PING_GAP, type WidgetDeps, WidgetPinger } from "../src/push/widgets";
import type { Session } from "../src/sessions";

const T = 1_800_000_000_000;
const key: Creds = { key: "k", keyId: "ABC123DEFG", teamId: "1A2B3C4D5E" };
const widget: Device = { token: "ab".repeat(50), env: "production", at: 0 };

const s = (name: string, o: Partial<Session> = {}): Session => ({
  name,
  pid: 1,
  clients: 0,
  created: (T - 3_600_000) / 1000,
  dir: "/u/blimp",
  cmd: "claude",
  kind: "claude",
  title: name,
  status: "busy",
  state: "working",
  stateSince: T - 60_000,
  unread: false,
  ...o,
});

function setup(o: { widgets?: Device[]; creds?: Creds; answer?: Sent; hidden?: string[] } = {}) {
  const t = {
    list: [] as Session[],
    clock: T,
    widgets: o.widgets ?? [widget],
    creds: ("creds" in o ? o.creds : key) as Creds | undefined,
    sent: [] as Device[],
    gone: [] as Device[],
    logs: [] as string[],
    reads: 0,
  };
  const deps: WidgetDeps = {
    sessions: async () => {
      t.reads++;
      return t.list;
    },
    hidden: () => new Set(o.hidden ?? []),
    creds: () => t.creds,
    widgets: () => t.widgets,
    send: async (_c, d) => {
      t.sent.push(d);
      return o.answer ?? { status: 200 };
    },
    gone: (d) => void t.gone.push(d),
    now: () => t.clock,
    log: (line) => void t.logs.push(line),
  };
  return { t, p: new WidgetPinger(deps) };
}

test("the ping only says the content changed", () => {
  expect(PING).toEqual({ aps: { "content-changed": true } });
  expect(PING_GAP).toBe(2 * 60_000);
});

test("what it finds first counts as known: a restart pings nothing", async () => {
  const { t, p } = setup();
  t.list = [s("a", { state: "waiting" })];
  await p.tick();
  expect(t.sent).toEqual([]);
});

test("a needs-you that wasn't there pings at once, even right after another ping", async () => {
  const { t, p } = setup();
  t.list = [s("a")];
  await p.tick();
  t.list = [s("a", { state: "waiting", stateSince: T })];
  await p.tick();
  expect(t.sent).toEqual([widget]);
  t.clock += 5000;
  t.list = [s("a", { state: "waiting", stateSince: T }), s("b", { state: "waiting", stateSince: T + 5000 })];
  await p.tick();
  expect(t.sent.length).toBe(2);
});

test("any other change: no sooner than 2 minutes after the last ping, then one ping for all of it", async () => {
  const { t, p } = setup();
  t.list = [s("a", { state: "waiting" })];
  await p.tick();
  // a answered: a change, and no ping in the last 2 minutes, so at once
  t.list = [s("a")];
  await p.tick();
  expect(t.sent.length).toBe(1);
  t.clock += 30_000;
  t.list = [s("a"), s("b")];
  await p.tick();
  t.clock += 30_000;
  t.list = [s("a"), s("b"), s("c")];
  await p.tick();
  expect(t.sent.length).toBe(1);
  // 2 minutes after the first ping: nothing new this second, but the changes since are still unsent
  t.clock = T + PING_GAP;
  await p.tick();
  expect(t.sent.length).toBe(2);
  t.clock += 1000;
  await p.tick();
  expect(t.sent.length).toBe(2);
});

test("a working row's time going on, and its activity, ping nothing", async () => {
  const { t, p } = setup();
  t.list = [s("a")];
  await p.tick();
  t.clock += PING_GAP * 3;
  t.list = [s("a", { updatedAt: t.clock })];
  await p.tick();
  expect(t.sent).toEqual([]);
});

test("no widget token, or no push key: nothing is listed or sent, and what was known is forgotten", async () => {
  const none = setup({ widgets: [] });
  none.t.list = [s("a")];
  await none.p.tick();
  expect(none.t.reads).toBe(0);
  const nokey = setup({ creds: undefined });
  await nokey.p.tick();
  expect(nokey.t.reads).toBe(0);
  const { t, p } = setup();
  t.list = [s("a")];
  await p.tick();
  t.creds = undefined;
  await p.tick();
  // the key back: its first list counts as known again
  t.creds = key;
  t.list = [s("a", { state: "waiting" })];
  await p.tick();
  expect(t.sent).toEqual([]);
});

test("the ping goes to each widget token, and one Apple says is gone is removed", async () => {
  const other: Device = { token: "cd".repeat(50), env: "development", at: 0 };
  const { t, p } = setup({ widgets: [widget, other], answer: { status: 410, reason: "Unregistered" } });
  t.list = [s("a")];
  await p.tick();
  t.list = [s("a", { state: "waiting" })];
  await p.tick();
  expect(t.sent).toEqual([widget, other]);
  expect(t.gone).toEqual([widget, other]);
  expect(t.logs.some((l) => l.includes("no longer works"))).toBe(true);
});

test("another answer from Apple is logged, and nothing is removed", async () => {
  const { t, p } = setup({ answer: { status: 429, reason: "TooManyRequests" } });
  t.list = [s("a")];
  await p.tick();
  t.list = [s("a", { state: "waiting" })];
  await p.tick();
  expect(t.gone).toEqual([]);
  expect(t.logs.some((l) => l.includes("429") && l.includes("TooManyRequests"))).toBe(true);
});

test("an empty list after sessions is skipped: more likely a zmx list that failed", async () => {
  const { t, p } = setup();
  t.list = [s("a")];
  await p.tick();
  t.list = [];
  await p.tick();
  t.list = [s("a")];
  await p.tick();
  expect(t.sent).toEqual([]);
});

test("a hidden project's sessions ping nothing", async () => {
  const { t, p } = setup({ hidden: ["/u/secret"] });
  t.list = [s("a")];
  await p.tick();
  t.list = [s("a"), s("x", { dir: "/u/secret", state: "waiting" })];
  await p.tick();
  expect(t.sent).toEqual([]);
});
```

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-widgets.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 5: Write `src/push/widgets.ts`**

```ts
// The widgets' pinger (docs/superpowers/specs/2026-10-25-phone-widgets-design.md, "How they stay up to date"): every
// second, while there's a push key and a widget push token, the widgets' summary (widget.ts) from the session list.
// When what they show changes, a widget push, which only tells iOS to reload them (they then GET /widget): a
// needs-you that wasn't there at once, anything else 2 minutes after the last ping at the earliest, one ping then
// covering everything since. What it finds first counts as known, so a restart pings nothing.

import type { Session } from "../sessions";
import { widgetShape, widgetSummary } from "../widget";
import { goneDevice, type Sent } from "./apns";
import type { Creds, Device } from "./store";

export const PING = { aps: { "content-changed": true } };
export const PING_GAP = 2 * 60_000;

export type WidgetDeps = {
  sessions: () => Promise<Session[]>;
  hidden: () => Set<string>;
  creds: () => Creds | undefined;
  widgets: () => Device[];
  send: (c: Creds, d: Device) => Promise<Sent>;
  gone: (d: Device) => void;
  now: () => number;
  log: (line: string) => void;
};

export class WidgetPinger {
  // What the widgets show now, and which sessions need you in it.
  private known?: { shape: string; needs: Set<string> };
  private listed = false;
  private pending = false;
  private lastPing = -Infinity;
  private busy = false;

  constructor(private deps: WidgetDeps) {}

  async tick(): Promise<void> {
    if (this.busy) return; // a slow zmx shouldn't pile up checks
    this.busy = true;
    try {
      const widgets = this.deps.widgets();
      const creds = widgets.length ? this.deps.creds() : undefined;
      if (!creds) {
        this.known = undefined;
        this.listed = false;
        this.pending = false;
        return;
      }
      const now = this.deps.now();
      const list = await this.deps.sessions();
      // An empty list after sessions is more likely a zmx list that failed than every session gone (as in watch.ts).
      if (!list.length && this.listed) return;
      this.listed = list.length > 0;
      const w = widgetSummary(list, this.deps.hidden(), now);
      const shape = widgetShape(w);
      const needs = new Set(w.rows.filter((r) => r.state === "needs").map((r) => r.session));
      const was = this.known;
      this.known = { shape, needs };
      if (!was) return;
      if (shape !== was.shape) this.pending = true;
      const urgent = [...needs].some((n) => !was.needs.has(n));
      if (this.pending && (urgent || now - this.lastPing >= PING_GAP)) {
        this.pending = false;
        this.lastPing = now;
        await this.ping(creds, widgets);
      }
    } catch (e) {
      this.deps.log(`push: widgets: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async ping(creds: Creds, widgets: Device[]) {
    for (const d of widgets) {
      const r = await this.deps.send(creds, d);
      if (goneDevice(r)) {
        this.deps.gone(d);
        this.deps.log(`push: Apple says a widget push token no longer works (${r.reason ?? r.status}), so it's removed`);
      } else if (r.status !== 200) this.deps.log(`push: Apple said ${r.status || "nothing"}${r.reason ? ` (${r.reason})` : ""} to a widget ping`);
    }
  }
}
```

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-widgets.test.ts` — Expected: PASS, 10 tests.

- [ ] **Step 6: Start it beside the watcher (`src/push/watch.ts`)**

Add imports: `import { readHidden } from "../hidden";`, `import { PING, type WidgetDeps, WidgetPinger } from "./widgets";`,
and `readWidgets`, `removeWidget` beside the store's names already imported. (`listSessionsLite`, `claudeDir`,
`zmxListAsync` are imported already.)

Replace the `send` entry of `live` (its comment and body) with:

```ts
  send: (c, d, payload, collapseId) => apnsFor(c).send(d, payload, { collapseId }),
```

and add above `const live`:

```ts
// One client while the key stays the same; push-key with a new one gets a new client. Notifications and the widgets'
// pings share it, so one connection to Apple.
export function apnsFor(c: Creds): Apns {
  const id = `${c.keyId}\0${c.teamId}\0${c.key}`;
  if (client?.id !== id) {
    client?.apns.close();
    client = { id, apns: new Apns(c) };
  }
  return client.apns;
}
```

Below `live`, add:

```ts
const widgetsLive: WidgetDeps = {
  sessions: async () => listSessionsLite(claudeDir(), await zmxListAsync()),
  hidden: () => new Set(readHidden()),
  creds: () => readCreds(),
  widgets: () => readWidgets(),
  send: (c, d) => apnsFor(c).send(d, PING, { type: "widgets" }),
  gone: (d) => void removeWidget(d.token),
  now: Date.now,
  log: (line) => console.log(line),
};
```

Replace `startPush` with:

```ts
export function startPush(every = 1000) {
  const w = new PushWatcher(live);
  const p = new WidgetPinger(widgetsLive);
  setInterval(() => {
    void w.tick();
    void p.tick();
  }, every);
}
```

Update the file's header comment's first sentence to end: `…what it finds goes to every phone that asked, at once
or, while the Mac is in use, up to 2 minutes later. The widgets' pinger (widgets.ts) runs on the same tick.`

- [ ] **Step 7: Run every push test, then the whole suite**

Run: `PATH=$HOME/.bun/bin:$PATH bun test test/push-*.test.ts test/widget.test.ts`
Expected: PASS.
Run: `PATH=$HOME/.bun/bin:$PATH bun test`
Expected: 0 fail.

- [ ] **Step 8: Docs**

In `docs/DESIGN.md`'s `### Widgets` section (Task 2), add this last bullet:

```markdown
- **The pinger** (`src/push/widgets.ts`): every second, while there's a push key and a widget push token, the summary from the session list. When the counts, or the rows and their states, change, a widget push (`apns-push-type: widgets`, topic `dev.blimp.phone.push-type.widgets`, priority 5, `{"aps":{"content-changed":true}}`) tells iOS to reload the widgets, which then read `GET /widget`: a needs-you that wasn't there at once, anything else 2 minutes after the last ping at the earliest. A working row's time isn't a change. What it finds first counts as known. It shares the notifications' connection to Apple, and Apple's 410, `BadDeviceToken` or `Unregistered` removes a token. iOS decides when the widgets reload: expect minutes, not seconds.
```

- [ ] **Step 9: Commit**

```bash
git add src/push/apns.ts src/push/widgets.ts src/push/watch.ts test/push-apns.test.ts test/push-widgets.test.ts docs/DESIGN.md
git commit -m "blimpd: a widget push tells the phone's widgets to reload when what they show changes, a new needs-you at once and anything else at most every 2 minutes, on the notifications' connection to Apple"
```

---

### Task 4: BlimpKit: the widgets' summary, words, link and shared files

**Files:**
- Create: `ios/BlimpKit/Sources/BlimpKit/Widgets.swift`
- Test: `ios/BlimpKit/Tests/BlimpKitTests/WidgetsTests.swift`

**Interfaces:**
- Consumes: `Strip.letters(_:)` (BlimpKit `Strip.swift`).
- Produces:
  - `WidgetSummary` (`at`, `counts: Counts { needs, new, working }`, `rows: [Row]`, `lastFinished: Double?`),
    `WidgetSummary.State` (`needs`, `new`, `working`), `WidgetSummary.Row` (`session`, `dir`, `title`, `state`,
    `since`; `id` = session). Public memberwise inits.
  - `WidgetText.symbol(_:)`, `.quiet`, `.isQuiet(_:)`, `.line(_:)`, `.countLines(_:)`, `.circle(_:) -> (symbol: String, count: Int?)`,
    `.letters(dir:)`, `.elapsed(since:now:) -> String?`
  - `WidgetLink.app`, `WidgetLink.url(session:)`, `WidgetLink.session(_:) -> String?`
  - `WidgetShared.group`, `WidgetShared.Server(url:key:)`, `WidgetShared.Kept(summary:pushToken:)`,
    `WidgetShared.files(in:) -> (server: URL, kept: URL)`, `WidgetShared.read(_:from:) -> T?`,
    `WidgetShared.write(_:to:) throws`

Swift is compiled only in CI (Global Constraints). Write exactly this, and re-read it.

- [ ] **Step 1: Write the tests**

Create `ios/BlimpKit/Tests/BlimpKitTests/WidgetsTests.swift`:

```swift
import Foundation
import Testing
@testable import BlimpKit

// The phone's widgets: GET /widget's summary, the words they show, the link a row opens, and the App Group's files.

private let counts = WidgetSummary.Counts(needs: 1, new: 2, working: 3)

@Test func theSummaryDecodes() throws {
    let json = #"{"at":1800000000000,"counts":{"needs":1,"new":0,"working":1},"rows":[{"session":"demo","dir":"/u/blimp","title":"Fix it","state":"needs","since":1799999990000},{"session":"w","dir":"/u/cq","title":"Build","state":"working","since":1799999000000}],"lastFinished":1799999999000}"#
    let w = try JSONDecoder().decode(WidgetSummary.self, from: Data(json.utf8))
    #expect(w.counts == WidgetSummary.Counts(needs: 1, new: 0, working: 1))
    #expect(w.rows.map(\.state) == [WidgetSummary.State.needs, WidgetSummary.State.working])
    #expect(w.rows.first?.id == "demo")
    #expect(w.lastFinished == 1_799_999_999_000)
    let none = try JSONDecoder().decode(WidgetSummary.self, from: Data(#"{"at":1,"counts":{"needs":0,"new":0,"working":0},"rows":[]}"#.utf8))
    #expect(none.lastFinished == nil)
}

@Test func theLockScreenLineLeavesOutNoughtsAndSaysAllQuietForNothing() {
    #expect(WidgetText.line(counts) == "? 1 · ✓ 2 · ● 3")
    #expect(WidgetText.line(WidgetSummary.Counts(needs: 0, new: 0, working: 3)) == "● 3")
    #expect(WidgetText.line(WidgetSummary.Counts(needs: 0, new: 0, working: 0)) == "All quiet")
    #expect(WidgetText.isQuiet(WidgetSummary.Counts(needs: 0, new: 0, working: 0)))
    #expect(!WidgetText.isQuiet(counts))
}

@Test func theSmallWidgetHasAllThreeCounts() {
    #expect(WidgetText.countLines(counts) == ["? 1 needs you", "✓ 2 new", "● 3 working"])
    #expect(WidgetText.countLines(WidgetSummary.Counts(needs: 0, new: 0, working: 0)) == ["? 0 needs you", "✓ 0 new", "● 0 working"])
}

@Test func theRoundWidgetShowsNeedsYouElseWorkingElseATick() {
    let needs = WidgetText.circle(counts)
    #expect(needs.symbol == "?")
    #expect(needs.count == 1)
    let working = WidgetText.circle(WidgetSummary.Counts(needs: 0, new: 2, working: 3))
    #expect(working.symbol == "●")
    #expect(working.count == 3)
    let neither = WidgetText.circle(WidgetSummary.Counts(needs: 0, new: 2, working: 0))
    #expect(neither.symbol == "✓")
    #expect(neither.count == nil)
}

@Test func aRowsProjectIsTwoLettersAsInTheDrawer() {
    #expect(WidgetText.letters(dir: "/Users/max/brain-memory") == "BM")
    #expect(WidgetText.letters(dir: "/Users/max/blimp") == "BL")
}

@Test func aWorkingRowsTimeIsATimerUnderAnHourThenHoursThenDays() {
    let now = 1_800_000_000_000.0
    #expect(WidgetText.elapsed(since: now - 59 * 60_000, now: now) == nil)
    #expect(WidgetText.elapsed(since: now - 60 * 60_000, now: now) == "1h")
    #expect(WidgetText.elapsed(since: now - 23 * 3_600_000 - 59 * 60_000, now: now) == "23h")
    #expect(WidgetText.elapsed(since: now - 50 * 3_600_000, now: now) == "2d")
}

@Test func aRowsLinkOpensItsSessionAndOtherLinksOpenNone() {
    let url = WidgetLink.url(session: "blimp-demo-chat")
    #expect(url.absoluteString == "blimp://open?session=blimp-demo-chat")
    #expect(WidgetLink.session(url) == "blimp-demo-chat")
    #expect(WidgetLink.session(WidgetLink.app) == nil)
    #expect(WidgetLink.session(URL(string: "blimp://open?session=")!) == nil)
    #expect(WidgetLink.session(URL(string: "blimp://pair?url=x&token=y")!) == nil)
    #expect(WidgetLink.session(URL(string: "https://example.com/open?session=x")!) == nil)
}

@Test func theSharedFilesGoThereAndBackAndAMissingOneReadsAsNone() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("widgets-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let files = WidgetShared.files(in: dir)
    #expect(files.server.lastPathComponent == "server.json")
    #expect(files.kept.lastPathComponent == "kept.json")
    #expect(WidgetShared.read(WidgetShared.Server.self, from: files.server) == nil)
    let server = WidgetShared.Server(url: URL(string: "https://box.tail1234.ts.net:7425")!, key: "abc")
    try WidgetShared.write(server, to: files.server)
    #expect(WidgetShared.read(WidgetShared.Server.self, from: files.server) == server)
    let summary = WidgetSummary(at: 1, counts: counts, rows: [WidgetSummary.Row(session: "a", dir: "/u/blimp", title: "A", state: .new, since: 1)])
    let kept = WidgetShared.Kept(summary: summary, pushToken: "ab")
    try WidgetShared.write(kept, to: files.kept)
    #expect(WidgetShared.read(WidgetShared.Kept.self, from: files.kept) == kept)
    #expect(WidgetShared.group == "group.dev.blimp.phone")
}
```

(Each `#expect` compares one value with `==`, never a tuple or a leading-dot array: Swift Testing's `#expect` takes
the two sides apart, and type inference for those can fail inside it.)

- [ ] **Step 2: Write `ios/BlimpKit/Sources/BlimpKit/Widgets.swift`**

```swift
// The phone's widgets (docs/superpowers/specs/2026-10-25-phone-widgets-design.md): what GET /widget answers
// (src/widget.ts), the words and symbols they show, the link a row opens, and the two files the app and the widgets
// share in their App Group: server.json, which only the app writes, and kept.json, which only the widgets write.
import Foundation

public struct WidgetSummary: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable { case needs, new, working }

    public struct Counts: Codable, Sendable, Equatable {
        public let needs: Int
        public let new: Int
        public let working: Int

        public init(needs: Int, new: Int, working: Int) {
            self.needs = needs
            self.new = new
            self.working = working
        }
    }

    public struct Row: Codable, Sendable, Equatable, Identifiable {
        public let session: String
        public let dir: String
        public let title: String
        public let state: State
        /// Milliseconds: when it started waiting or working.
        public let since: Double

        public var id: String { session }

        public init(session: String, dir: String, title: String, state: State, since: Double) {
            self.session = session
            self.dir = dir
            self.title = title
            self.state = state
            self.since = since
        }
    }

    /// Milliseconds: when blimpd made it.
    public let at: Double
    public let counts: Counts
    /// Needs you, then new, then working; at most 9.
    public let rows: [Row]
    /// Milliseconds: when the last session finished. nil: none has.
    public let lastFinished: Double?

    public init(at: Double, counts: Counts, rows: [Row], lastFinished: Double? = nil) {
        self.at = at
        self.counts = counts
        self.rows = rows
        self.lastFinished = lastFinished
    }
}

public enum WidgetText {
    public static func symbol(_ state: WidgetSummary.State) -> String {
        switch state {
        case .needs: "?"
        case .new: "✓"
        case .working: "●"
        }
    }

    public static let quiet = "All quiet"

    /// Nothing needs you, is new or works.
    public static func isQuiet(_ c: WidgetSummary.Counts) -> Bool { c.needs == 0 && c.new == 0 && c.working == 0 }

    /// The lock screen's line above the clock, "? 1 · ✓ 2 · ● 3", a count of 0 left out; with none, "All quiet".
    public static func line(_ c: WidgetSummary.Counts) -> String {
        let all: [(WidgetSummary.State, Int)] = [(.needs, c.needs), (.new, c.new), (.working, c.working)]
        let parts = all.filter { $0.1 > 0 }.map { "\(symbol($0.0)) \($0.1)" }
        return parts.isEmpty ? quiet : parts.joined(separator: " · ")
    }

    /// The small widget's lines, each count even at 0.
    public static func countLines(_ c: WidgetSummary.Counts) -> [String] {
        ["\(symbol(.needs)) \(c.needs) needs you", "\(symbol(.new)) \(c.new) new", "\(symbol(.working)) \(c.working) working"]
    }

    /// The round lock screen widget: the needs-you count with ?, else the working count with ●, else ✓ alone.
    public static func circle(_ c: WidgetSummary.Counts) -> (symbol: String, count: Int?) {
        if c.needs > 0 { return (symbol(.needs), c.needs) }
        if c.working > 0 { return (symbol(.working), c.working) }
        return (symbol(.new), nil)
    }

    /// A row's project, as the drawer's column has it: two letters from its folder's name.
    public static func letters(dir: String) -> String {
        Strip.letters(URL(fileURLWithPath: dir).lastPathComponent)
    }

    /// A working row's time from an hour on: "3h", then "2d" from 24 hours. Under an hour nil: the widget shows a timer
    /// that counts up by itself. Both in milliseconds.
    public static func elapsed(since: Double, now: Double) -> String? {
        let minutes = Int((now - since) / 60_000)
        if minutes < 60 { return nil }
        let hours = minutes / 60
        return hours < 24 ? "\(hours)h" : "\(hours / 24)d"
    }
}

/// What a widget's tap opens: a session's chat (blimp://open?session=<name>), or just the app (blimp://open).
public enum WidgetLink {
    public static let app = URL(string: "blimp://open")!

    public static func url(session: String) -> URL {
        var c = URLComponents()
        c.scheme = "blimp"
        c.host = "open"
        c.queryItems = [URLQueryItem(name: "session", value: session)]
        return c.url!
    }

    /// The session a link opens; nil for blimp://open alone and for any other link.
    public static func session(_ url: URL) -> String? {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.scheme == "blimp", c.host == "open",
              let name = c.queryItems?.first(where: { $0.name == "session" })?.value, !name.isEmpty
        else { return nil }
        return name
    }
}

public enum WidgetShared {
    /// The App Group the app and the widgets share.
    public static let group = "group.dev.blimp.phone"

    /// What only the app writes: the server's address and the widget key. key nil: blimpd is too old to have one.
    public struct Server: Codable, Sendable, Equatable {
        public let url: URL
        public let key: String?

        public init(url: URL, key: String?) {
            self.url = url
            self.key = key
        }
    }

    /// What only the widgets write: their last summary, and their push token for the app to send to blimpd.
    public struct Kept: Codable, Sendable, Equatable {
        public var summary: WidgetSummary?
        public var pushToken: String?

        public init(summary: WidgetSummary? = nil, pushToken: String? = nil) {
            self.summary = summary
            self.pushToken = pushToken
        }
    }

    /// The two files in the App Group's folder.
    public static func files(in container: URL) -> (server: URL, kept: URL) {
        (container.appendingPathComponent("server.json"), container.appendingPathComponent("kept.json"))
    }

    /// nil: missing or unreadable.
    public static func read<T: Decodable>(_ type: T.Type, from file: URL) -> T? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    /// Whole or not at all: a temporary file, then a rename.
    public static func write<T: Encodable>(_ value: T, to file: URL) throws {
        try JSONEncoder().encode(value).write(to: file, options: .atomic)
    }
}
```

- [ ] **Step 3: Re-read both files against the tests**

Check by eye: every name the tests use exists with that label; `WidgetText.circle` returns `(symbol: String, count:
Int?)` and the tests read `.symbol` and `.count`; `Strip.letters` is `public static`.

- [ ] **Step 4: Commit**

```bash
git add ios/BlimpKit/Sources/BlimpKit/Widgets.swift ios/BlimpKit/Tests/BlimpKitTests/WidgetsTests.swift
git commit -m "BlimpKit: the widgets' summary (GET /widget), their words and symbols (? needs you, ✓ new, ● working, All quiet), the link a row opens (blimp://open?session=), and the App Group's two files"
```

---

### Task 5: The app: shares the server with the widgets, sends their push token, and opens their links

**Files:**
- Create: `ios/Blimp/WidgetShare.swift`
- Modify: `ios/Blimp/Net/API.swift` (after `unregisterDevice`)
- Modify: `ios/Blimp/Model/Store.swift` (`update(_:)`'s `.open` case, `signOut()`)
- Modify: `ios/Blimp/BlimpApp.swift` (`Root`)
- Modify: `ios/project.yml` (the Blimp target's entitlements and info)
- Modify: `ios/BlimpUITests/BlimpUITests.swift` (a test under `// MARK: - Notifications`)
- Modify: `.github/workflows/ios.yml` (shard b's core lists, near lines 99 and 102)

**Interfaces:**
- Consumes: `WidgetShared`, `WidgetLink` (Task 4); `GET /widget/key`, `POST`/`DELETE /push/widget` (Task 2);
  `Push.shared.open`, `Push.env` (`ios/Blimp/Push.swift`).
- Produces: `API.widgetKey() async throws -> String`, `API.registerWidget(token:env:)`, `API.unregisterWidget(token:)`;
  `WidgetShare.update(api:)`, `WidgetShare.forget(api:)`, `WidgetShare.reload()`; the `blimp` URL scheme; the App
  Group entitlement on the app.

- [ ] **Step 1: API calls (`ios/Blimp/Net/API.swift`)**

After `unregisterDevice(token:)`, add:

```swift
    /// The widget key: it reads only GET /widget, so the widgets can read it while the phone is locked. An older
    /// blimpd has no such route: "not found".
    func widgetKey() async throws -> String {
        struct Key: Decodable { let key: String }
        let k: Key = try await decode(call("GET", "/widget/key"))
        return k.key
    }

    /// blimpd's widget pings to this phone's widgets: their push token from WidgetKit, and which of Apple's services.
    func registerWidget(token: String, env: String) async throws {
        struct Body: Encodable { let token: String; let env: String }
        _ = try await call("POST", "/push/widget", body: JSONEncoder().encode(Body(token: token, env: env)))
    }

    func unregisterWidget(token: String) async throws {
        struct Body: Encodable { let token: String }
        _ = try await call("DELETE", "/push/widget", body: JSONEncoder().encode(Body(token: token)))
    }
```

- [ ] **Step 2: Create `ios/Blimp/WidgetShare.swift`**

```swift
// The widgets' side, in the app (docs/superpowers/specs/2026-10-25-phone-widgets-design.md): each time the app is
// online, the server's address and the widget key go in the App Group's server.json for the widgets to read GET /widget
// with, a widget push token the widgets left in kept.json goes to blimpd once, and the widgets reload. Signing out
// takes the server away from them.
import BlimpKit
import Foundation
import WidgetKit

@MainActor
enum WidgetShare {
    private static var files: (server: URL, kept: URL)? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetShared.group).map(WidgetShared.files(in:))
    }

    /// The widget push token blimpd has been sent.
    private static var sentToken: String? {
        get { UserDefaults.standard.string(forKey: "widgetTokenSent") }
        set { UserDefaults.standard.set(newValue, forKey: "widgetTokenSent") }
    }

    /// An older blimpd has no widget key ("not found"): server.json then has none, and the widgets say to update it.
    /// Any other failure (offline) leaves server.json as it was.
    static func update(api: API) async {
        guard let files else { return }
        do {
            let key = try await api.widgetKey()
            try? WidgetShared.write(WidgetShared.Server(url: api.server.url, key: key), to: files.server)
        } catch APIError.server(let message) where message == "not found" {
            try? WidgetShared.write(WidgetShared.Server(url: api.server.url, key: nil), to: files.server)
        } catch {}
        if let token = WidgetShared.read(WidgetShared.Kept.self, from: files.kept)?.pushToken, token != sentToken,
           (try? await api.registerWidget(token: token, env: Push.env)) != nil {
            sentToken = token
        }
        reload()
    }

    /// Signing out: blimpd stops pinging the widgets (the old server still answers this), and they forget the server.
    static func forget(api: API?) {
        if let api, let token = sentToken { Task { try? await api.unregisterWidget(token: token) } }
        sentToken = nil
        if let files { try? FileManager.default.removeItem(at: files.server) }
        reload()
    }

    static func reload() {
        WidgetCenter.shared.reloadAllTimelines()
    }
}
```

- [ ] **Step 3: Store (`ios/Blimp/Model/Store.swift`)**

In `update(_:)`, case `.open`, change the Task to:

```swift
            Task { [weak self] in
                guard let api = self?.api, let health = try? await api.health() else { return }
                self?.serverVersion = health.version
                self?.serverHome = health.home
                await WidgetShare.update(api: api)
            }
```

In `signOut()`, add `WidgetShare.forget(api: api)` as the second line, right after `stopPush()` (before
`Keychain.clear()` and `server = nil`, so `api` still has the old server).

- [ ] **Step 4: Root (`ios/Blimp/BlimpApp.swift`)**

In `Root.body`, after the `.onChange(of: Push.shared.token) { … }` modifier, add:

```swift
        // A widget's tap (WidgetLink): its session's chat, the way a tapped notification opens one.
        .onOpenURL { url in
            if let name = WidgetLink.session(url) { Push.shared.open = name }
        }
```

In the existing `.onChange(of: scenePhase) { _, phase in … }` of `Root` (the one that calls `store.loadServer()`),
add as its last line:

```swift
            // What the widgets show may have changed while the app was open.
            if phase == .background { WidgetShare.reload() }
```

- [ ] **Step 5: project.yml (the Blimp target)**

In the Blimp target's `entitlements.properties`, under `aps-environment`, add:

```yaml
        com.apple.security.application-groups: [group.dev.blimp.phone]
```

In its `info.properties`, after `CFBundleDisplayName: blimp`, add:

```yaml
        # A widget's tap opens blimp://open?session=<name> (WidgetLink).
        CFBundleURLTypes:
          - CFBundleURLName: dev.blimp.phone
            CFBundleURLSchemes: [blimp]
```

Update the comment above `entitlements:` to: `# Notifications: Apple's sandbox service for a build from Xcode or the
simulator, production for TestFlight; the App Group the widgets share. XcodeGen writes the file (it's ignored, as
Info.plist is).`

- [ ] **Step 6: The UI test**

In `ios/BlimpUITests/BlimpUITests.swift`, after `testPushOpensTheChat()` (still under `// MARK: - Notifications`),
add:

```swift
    /// A widget's row links to blimp://open?session=<name> (WidgetLink): opened with the app in front, it lands in that
    /// session's chat, as a tapped notification does. (The widgets themselves can't be driven from a UI test.)
    func testWidgetLinkOpensTheChat() throws {
        try launchPaired()
        app.open(URL(string: "blimp://open?session=demo-chat")!)
        try wait(message("message.user", "Add a dark mode toggle to settings"), "demo-chat's chat from the widget's link", timeout: 30)
        shot("45-widget-link")
    }
```

Check `grep -n 'shot("45\|screen("45' ios/BlimpUITests/BlimpUITests.swift` finds only this one.

- [ ] **Step 7: The shard lists (`.github/workflows/ios.yml`)**

Add `testWidgetLinkOpensTheChat` after `testPushOpensTheChat` in shard b's core tests (the 4th argument) on both
lines: the Mac's (near line 99) and GitHub's (near line 102). Change nothing else.

- [ ] **Step 8: Re-read every edited Swift region**

Check: `WidgetShare` is `@MainActor` and `Store` is `@MainActor`, so the calls from `Store` need no `await` except
`update(api:)`; `Push.env` is read on the main actor; the `catch APIError.server(let message) where …` form matches
`FolderBrowserView.swift`'s; `Root` already imports BlimpKit.

- [ ] **Step 9: Commit**

```bash
git add ios/Blimp/WidgetShare.swift ios/Blimp/Net/API.swift ios/Blimp/Model/Store.swift ios/Blimp/BlimpApp.swift ios/project.yml ios/BlimpUITests/BlimpUITests.swift .github/workflows/ios.yml
git commit -m "iPhone: the app leaves the server's address and the widget key in the App Group for the widgets, sends blimpd their push token, reloads them when it's online or leaves, and opens a widget's blimp://open?session= link as a tapped notification; testWidgetLinkOpensTheChat"
```

---

### Task 6: The widget extension

**Files:**
- Modify: `ios/project.yml` (a `BlimpWidgets` target; the Blimp target depends on it)
- Modify: `ios/.gitignore`
- Create: `ios/BlimpWidgets/BlimpWidgets.swift`, `ios/BlimpWidgets/SessionsView.swift`
- Docs: `ios/README.md`, `docs/PHONE-CHECKLIST.md`

**Interfaces:**
- Consumes: `WidgetSummary`, `WidgetText`, `WidgetLink`, `WidgetShared` (Task 4); `server.json` written by the app
  (Task 5); `GET /widget` (Task 2).
- Produces: the `dev.blimp.phone.widgets` extension, embedded in the app, with one widget (kind `sessions`) in six
  families and a push handler.

If CI's compiler rejects a WidgetKit name used here (`WidgetPushHandler`, `WidgetPushInfo`, `WidgetInfo`,
`.pushHandler`), read the iOS 26 SDK's WidgetKit interface for the exact spelling (in CI's log or Apple's
documentation page "Updating widgets with WidgetKit push notifications") and match it; don't drop the push handler.

- [ ] **Step 1: The target (`ios/project.yml`)**

Under `targets:`, after the `Blimp` target and before `BlimpUITests`, add:

```yaml
  # The widgets (BlimpWidgets/): every project's sessions on the home screen and the lock screen. Swift 5 language
  # mode: WidgetKit's TimelineProvider hands over completion handlers that aren't Sendable, and Swift 6 won't let the
  # Task that fetches GET /widget carry them.
  BlimpWidgets:
    type: app-extension
    platform: iOS
    sources: [BlimpWidgets]
    dependencies:
      - package: BlimpKit
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: dev.blimp.phone.widgets
        PRODUCT_NAME: BlimpWidgets
        MARKETING_VERSION: "0.3.11"
        CURRENT_PROJECT_VERSION: "1"
        SWIFT_VERSION: "5.0"
        TARGETED_DEVICE_FAMILY: "1"
        GENERATE_INFOPLIST_FILE: YES
      configs:
        Debug:
          APS_ENVIRONMENT: development
        Release:
          APS_ENVIRONMENT: production
    # Widget push (blimpd's pings) and the App Group the app shares. XcodeGen writes both files (they're ignored).
    entitlements:
      path: BlimpWidgets/BlimpWidgets.entitlements
      properties:
        aps-environment: $(APS_ENVIRONMENT)
        com.apple.security.application-groups: [group.dev.blimp.phone]
    info:
      path: BlimpWidgets/Info.plist
      properties:
        CFBundleDisplayName: blimp
        NSExtension:
          NSExtensionPointIdentifier: com.apple.widgetkit-extension
        NSAppTransportSecurity:
          NSExceptionDomains:
            localhost: { NSExceptionAllowsInsecureHTTPLoads: true }
            127.0.0.1: { NSExceptionAllowsInsecureHTTPLoads: true }
```

`MARKETING_VERSION` must be the same as the Blimp target's (Apple refuses an extension with another version), and it
has the same 8-space indent, so `scripts/version.sh` sets both: check with `grep -n 'MARKETING_VERSION' ios/project.yml`
(two lines, the same value) and `sh scripts/version.sh` (prints the version, exit 0).

In the Blimp target's `dependencies`, add after `- package: BlimpKit`:

```yaml
      - target: BlimpWidgets
```

Append to `ios/.gitignore`:

```
BlimpWidgets/Info.plist
BlimpWidgets/BlimpWidgets.entitlements
```

- [ ] **Step 2: Create `ios/BlimpWidgets/BlimpWidgets.swift`**

```swift
// The widgets (docs/superpowers/specs/2026-10-25-phone-widgets-design.md): every project's sessions that need you, are
// new or are working, on the home screen (small, medium, large) and the lock screen (inline, circular, rectangular).
// They read GET /widget with the widget key the app leaves in the App Group (WidgetShare.swift in the app) whenever iOS
// reloads them: after blimpd's widget push, after 15 minutes, or when the app is online or leaves. Failing that, the
// last summary they had, greyed.
import BlimpKit
import SwiftUI
import WidgetKit

// Not named BlimpWidgets: that's the module's name.
@main
struct BlimpWidgetBundle: WidgetBundle {
    var body: some Widget { SessionsWidget() }
}

struct SessionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "sessions", provider: Provider()) { entry in
            SessionsView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("blimp")
        .description("What needs you, what's new and what's working, in every project.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryInline, .accessoryCircular, .accessoryRectangular])
        .pushHandler(PushHandler.self)
    }
}

struct Entry: TimelineEntry {
    enum Status { case fresh, stale, notSetUp, needsUpdate }
    let date: Date
    /// stale: the last one the widgets had, if any.
    let summary: WidgetSummary?
    let status: Status
}

/// The App Group's two files; nil without the group (a build without its entitlement).
enum Files {
    static var both: (server: URL, kept: URL)? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetShared.group).map(WidgetShared.files(in:))
    }
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        Entry(date: .now, summary: .sample, status: .fresh)
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        if context.isPreview { return completion(placeholder(in: context)) }
        Task { completion(await Self.load()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        Task {
            let entry = await Self.load()
            completion(Timeline(entries: [entry], policy: .after(Date.now.addingTimeInterval(15 * 60))))
        }
    }

    /// GET /widget with the widget key, kept for next time; failing that, the last one, greyed.
    static func load() async -> Entry {
        guard let files = Files.both, let server = WidgetShared.read(WidgetShared.Server.self, from: files.server) else {
            return Entry(date: .now, summary: nil, status: .notSetUp)
        }
        guard let key = server.key else { return Entry(date: .now, summary: nil, status: .needsUpdate) }
        var kept = WidgetShared.read(WidgetShared.Kept.self, from: files.kept) ?? WidgetShared.Kept()
        guard var c = URLComponents(url: server.url, resolvingAgainstBaseURL: false) else {
            return Entry(date: .now, summary: kept.summary, status: .stale)
        }
        c.path += "/widget"
        guard let url = c.url else { return Entry(date: .now, summary: kept.summary, status: .stale) }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let summary = try JSONDecoder().decode(WidgetSummary.self, from: data)
            kept.summary = summary
            try? WidgetShared.write(kept, to: files.kept)
            return Entry(date: .now, summary: summary, status: .fresh)
        } catch {
            return Entry(date: .now, summary: kept.summary, status: .stale)
        }
    }
}

/// iOS 26's widget push: the token for blimpd's pings goes in kept.json, and the app sends it on (POST /push/widget)
/// the next time it's online.
struct PushHandler: WidgetPushHandler {
    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        guard let files = Files.both else { return }
        var kept = WidgetShared.read(WidgetShared.Kept.self, from: files.kept) ?? WidgetShared.Kept()
        kept.pushToken = pushInfo.token.map { String(format: "%02x", $0) }.joined()
        try? WidgetShared.write(kept, to: files.kept)
    }
}

extension WidgetSummary {
    /// The widget gallery's picture.
    static var sample: WidgetSummary {
        let now = Date.now.timeIntervalSince1970 * 1000
        return WidgetSummary(
            at: now,
            counts: Counts(needs: 1, new: 1, working: 2),
            rows: [
                Row(session: "a", dir: "/blimp", title: "Linking Linear cards", state: .needs, since: now - 600_000),
                Row(session: "b", dir: "/blimp", title: "Folder browser", state: .new, since: now - 300_000),
                Row(session: "c", dir: "/blimp", title: "PR overnight fixes", state: .working, since: now - 720_000),
                Row(session: "d", dir: "/brain-memory", title: "Fixing the Slack bot", state: .working, since: now - 7_200_000),
            ])
    }
}
```

- [ ] **Step 3: Create `ios/BlimpWidgets/SessionsView.swift`**

```swift
// What each widget shows (BlimpWidgets.swift says where it comes from): the counts, the rows (a tap on one opens its
// chat), "All quiet", or why there's nothing to show. Greyed with "as of" when it's the last summary, not a new one.
// Each state has its own symbol, so a widget reads right when iOS tints it one colour.
import BlimpKit
import SwiftUI
import WidgetKit

struct SessionsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: Entry

    var body: some View {
        switch entry.status {
        case .notSetUp:
            MessageView(text: "Open blimp to set up its widgets")
        case .needsUpdate:
            MessageView(text: "Update blimpd for widgets")
        case .fresh, .stale:
            if let summary = entry.summary {
                content(summary, stale: entry.status == .stale).opacity(entry.status == .stale ? 0.5 : 1)
            } else {
                MessageView(text: "Can't reach the server")
            }
        }
    }

    @ViewBuilder private func content(_ s: WidgetSummary, stale: Bool) -> some View {
        switch family {
        case .accessoryInline:
            Text(verbatim: WidgetText.line(s.counts)).widgetURL(link(s))
        case .accessoryCircular:
            CircleView(counts: s.counts).widgetURL(link(s))
        case .accessoryRectangular:
            RectangleView(summary: s, stale: stale).widgetURL(link(s))
        case .systemSmall:
            SmallView(summary: s, stale: stale).widgetURL(link(s))
        case .systemLarge:
            RowsView(summary: s, rows: 9, stale: stale)
        default:
            RowsView(summary: s, rows: 4, stale: stale)
        }
    }

    /// The oldest that needs you, else just the app.
    private func link(_ s: WidgetSummary) -> URL {
        s.rows.first(where: { $0.state == .needs }).map { WidgetLink.url(session: $0.session) } ?? WidgetLink.app
    }
}

struct MessageView: View {
    let text: String

    var body: some View {
        Text(verbatim: text).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            .widgetURL(WidgetLink.app)
    }
}

/// "as of 10:42": the summary is the last one the widget had, not a new one.
struct AsOf: View {
    let at: Double

    var body: some View {
        Text("as of \(Date(timeIntervalSince1970: at / 1000), style: .time)").font(.caption2).foregroundStyle(.secondary)
    }
}

/// "All quiet", and when the last session finished.
struct QuietView: View {
    let lastFinished: Double?

    var body: some View {
        Text(verbatim: WidgetText.quiet).font(.subheadline.weight(.medium))
        if let t = lastFinished {
            Text("Last finished \(Date(timeIntervalSince1970: t / 1000), style: .relative) ago").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct SmallView: View {
    let summary: WidgetSummary
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if WidgetText.isQuiet(summary.counts) {
                QuietView(lastFinished: summary.lastFinished)
            } else {
                ForEach(WidgetText.countLines(summary.counts), id: \.self) { Text(verbatim: $0).font(.subheadline.weight(.medium)) }
            }
            Spacer(minLength: 0)
            if stale { AsOf(at: summary.at) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct RowsView: View {
    let summary: WidgetSummary
    let rows: Int
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(verbatim: "blimp").font(.headline)
                Spacer()
                if !WidgetText.isQuiet(summary.counts) {
                    Text(verbatim: WidgetText.line(summary.counts)).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                }
            }
            if WidgetText.isQuiet(summary.counts) { QuietView(lastFinished: summary.lastFinished) }
            ForEach(summary.rows.prefix(rows)) { RowView(row: $0) }
            Spacer(minLength: 0)
            if stale { AsOf(at: summary.at) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A session: its state's symbol, its title, a working one's time, its project's two letters. A tap opens its chat.
struct RowView: View {
    let row: WidgetSummary.Row

    var body: some View {
        Link(destination: WidgetLink.url(session: row.session)) {
            HStack(spacing: 6) {
                Text(verbatim: WidgetText.symbol(row.state)).font(.caption.bold()).frame(width: 12)
                Text(verbatim: row.title).font(.caption).lineLimit(1)
                Spacer(minLength: 4)
                if row.state == .working { ElapsedView(since: row.since) }
                Text(verbatim: WidgetText.letters(dir: row.dir)).font(.caption2.bold()).foregroundStyle(.secondary)
            }
        }
    }
}

/// A working row's time: a timer that counts up by itself under an hour, then "3h" or "2d".
struct ElapsedView: View {
    let since: Double

    var body: some View {
        if let text = WidgetText.elapsed(since: since, now: Date.now.timeIntervalSince1970 * 1000) {
            Text(verbatim: text).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
        } else {
            Text(Date(timeIntervalSince1970: since / 1000), style: .timer)
                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing).frame(width: 40)
        }
    }
}

/// The lock screen's rectangle: the counts, then the top two titles.
struct RectangleView: View {
    let summary: WidgetSummary
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(verbatim: WidgetText.line(summary.counts)).font(.headline).widgetAccentable()
            ForEach(summary.rows.prefix(2)) { row in
                Text(verbatim: "\(WidgetText.symbol(row.state)) \(row.title)").font(.caption).lineLimit(1)
            }
            if stale { AsOf(at: summary.at) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The lock screen's circle: the needs-you count with ?, else the working count with ●, else ✓.
struct CircleView: View {
    let counts: WidgetSummary.Counts

    var body: some View {
        let c = WidgetText.circle(counts)
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Text(verbatim: c.symbol).font(.caption.bold())
                if let n = c.count { Text(verbatim: "\(n)").font(.title3.bold()).widgetAccentable() }
            }
        }
    }
}
```

- [ ] **Step 4: Re-read both Swift files**

Check: no type is named like a SwiftUI one (`List`, `Circle`, `Rectangle`); every `Text` of a title or count uses
`verbatim:`; the two `Text("… \(date, style: …)")` keep the interpolation form (a date style needs it); `QuietView`'s
body has two views (a `View` body is a ViewBuilder, so that's allowed).

- [ ] **Step 5: Docs**

In `ios/README.md`, before `## Check list`, add:

```markdown
## Widgets

Long-press the home screen or the lock screen, tap Edit and Add Widget, and pick blimp. Home screen: small (the counts), medium (4 sessions) and large (about 9). Lock screen: the line above the clock, a circle (the needs-you count, else the working count) and a rectangle (the counts and the top two titles). They show every project's sessions, the hidden projects' left out: ? needs you, ✓ new (finished, not read yet), ● working. A tap on a session opens its chat.

They need blimpd newer than 0.3.11 ("Update blimpd for widgets" otherwise) and the app opened once after pairing ("Open blimp to set up its widgets"). blimpd tells them to reload when what they show changes, and the phone decides when they do: expect minutes, not seconds. When the phone can't reach the server, a widget shows what it last had, greyed, with "as of". Open the app once after adding the first widget, so blimpd gets the widgets' push token.

The widgets are an app extension, `dev.blimp.phone.widgets`, sharing the App Group `group.dev.blimp.phone` with the app. CI's App Store Connect key (Admin) registers both when it signs. If a TestFlight upload fails on them, register them once on https://developer.apple.com/account/resources/identifiers: press +, pick App Groups, Description: blimp, Identifier: `group.dev.blimp.phone`, Continue, Register. Then press +, pick App IDs, then App, Description: blimp widgets, Bundle ID: Explicit, `dev.blimp.phone.widgets`, tick App Groups and Push Notifications, Continue, Register. Then open the `dev.blimp.phone` App ID, tick App Groups, and save. Then run the TestFlight upload again.
```

In `docs/PHONE-CHECKLIST.md`, add at the end:

```markdown
## Widgets

- [ ] Add each widget: small, medium and large on the home screen; the line above the clock, the circle and the rectangle on the lock screen. Open blimp once after adding the first.
- [ ] The counts match the app: needs you as the drawer's ? marks, new as the inbox's "Finished, not read yet", working as its Working, across every project; a hidden project's sessions aren't counted.
- [ ] With the app closed, start a turn that asks a question. The widgets show it as needing you within a few minutes.
- [ ] A row's tap opens its chat. The small widget's tap opens the oldest that needs you.
- [ ] Stop blimpd (or turn Tailscale off). After the next refresh the widgets are greyed with "as of".
- [ ] A working row's time counts up by itself; past an hour it says "1h", past a day "1d".
```

- [ ] **Step 6: Commit**

```bash
git add ios/project.yml ios/.gitignore ios/BlimpWidgets/BlimpWidgets.swift ios/BlimpWidgets/SessionsView.swift ios/README.md docs/PHONE-CHECKLIST.md
git commit -m "iPhone: the widgets, an app extension: every project's sessions (needs you, new, working) on the home screen small, medium and large and the lock screen inline, circular and rectangular, read from GET /widget with the widget key, greyed with as of when blimpd can't be reached, and iOS 26 widget push for blimpd's pings"
```

---

### Task 7: CI verification

**Files:** none, unless CI finds something; then a fix through a helper, with a commit per fix.

- [ ] **Step 1: Run the whole server suite**

Run: `PATH=$HOME/.bun/bin:$PATH bun test`
Expected: 0 fail.

- [ ] **Step 2: Ask Max before pushing**

Pushing the branch starts the iOS workflow on the MacBook's runners. Ask Max in one plain line, for example: "ok to
push the widgets branch? it starts the iOS CI on the MacBook". Wait for a yes.

- [ ] **Step 3: Push and watch the push run**

Run: `git push -u origin phone-widgets`, then find the iOS run for the branch
(`gh run list --branch phone-widgets --limit 3`) and watch it in the background:
`gh run watch <id> --exit-status --interval 30` (run_in_background). This run builds the app with the extension,
runs BlimpKit's tests (on Linux and the Mac) and the core UI tests, including `testWidgetLinkOpensTheChat`.

- [ ] **Step 4: Fix what CI finds**

Compile errors or failing tests go to a helper with the log's lines and this plan's task text, one fix commit each,
then push and watch again. For a WidgetKit name the SDK spells differently, see Task 6's note.

- [ ] **Step 5: Ask Max about a TestFlight build from the branch**

Signing the extension and the App Group only happens on a TestFlight upload, and that build is also how Max tries
the widgets on his phone. Check main's iOS runs are idle (`gh run list --workflow iOS --branch main --limit 3`), then
ask Max in one plain line, for example: "the branch is green. ok to send a TestFlight build from it, so you can try
the widgets? if Apple wants the widget part registered by hand, the run says so". On a yes:
`gh workflow run iOS --ref phone-widgets -f layout=false -f testflight=true`, and watch it in the background. If it
fails on signing the extension or the App Group, give Max the README's "Widgets" steps (Task 6) in plain words.

- [ ] **Step 6: Report to Max**

Lead with the result: what passed, the TestFlight build number if one was uploaded, and what he should check on his
phone (`docs/PHONE-CHECKLIST.md`, "Widgets"). Remind him the widgets need blimpd newer than 0.3.11, so they work on
his server after the next release and update.
