# Sleeping tabs Implementation Plan

> **For agentic workers:** one task per worker. Tasks 1, 2 and 3 touch different files and can run
> at the same time; each depends only on the HTTP contract below, not on another task's code.

**Goal:** A server browser tab nobody has used for 1 hour is closed in Chrome but stays in the tab
list, and opening it loads it again.

**Architecture:** The gate records when each tab was last used and first made. The service keeps
the list of sleeping tabs, puts idle tabs to sleep once a minute, and wakes one on request. The
apps show sleeping tabs dimmed and wake the one you open.

**Tech stack:** Bun + TypeScript (blimpd, `src/`, tests in `test/`), React + TypeScript (Mac app,
`app/`), Swift (phone, `ios/`).

**Spec:** `docs/superpowers/specs/2026-11-23-sleeping-tabs-design.md`. Read it first; it has the
measurements the rules come from.

## Global constraints

- Worktree: `/Users/mbeato/blimp-sleep`, branch `sleep-tabs`. Work only there.
- `bun` is at `/home/mbeato/.bun/bin/bun` and is not on PATH: start commands with
  `export PATH=/home/mbeato/.bun/bin:$PATH &&`.
- **Do not commit.** Leave your changes in the working tree; the reviewer commits.
- **Touch only the files your task names.** Another worker is editing the others right now.
- Match the code around you: comments in plain short sentences that say why, no new
  abstractions, no settings, no error handling for cases that can't happen. Change only what the
  task needs.
- The limit is 1 hour, one constant: `SLEEP_AFTER = 60 * 60_000`. No setting, no environment
  variable.
- The server here has little free memory. Run only the test files you name, not the whole suite
  in a loop.
- Stop and report, without working around it, if: an existing test fails before you change
  anything; the contract below can't be met as written; or you need a file outside your task.

## The contract between the tasks

```ts
// A tab in GET /browser/tabs and in the events socket's { type: "browser", tabs }.
type BrowserTab = { id: string; folder: string; url: string; title: string; openedBy?: string; asleep?: true };
```

- A sleeping tab has `asleep: true` and keeps the id it had awake. An awake tab has no `asleep`.
- The list is in the order the tabs were first made. Sleeping and waking don't move a tab.
- `POST /browser/tabs/<id>/wake` → 200 `{ "id": "<new id>" }`. 404 if `<id>` isn't a sleeping tab.
  503 if Chrome can't start. After it, the list has the new id where the old one was, without
  `asleep`, and no longer has the old id. The events message with the new id can arrive before or
  after the HTTP answer.
- `GET /browser/tabs/<id>/view` on a sleeping tab is 404, as for an unknown tab.
- `DELETE /browser/tabs/<id>` on a sleeping tab removes it: 204.

---

### Task 1: The server

**Files:**
- Modify: `src/browser/gate.ts`, `src/browser/service.ts`, `src/server.ts`
- Test: `test/browser-gate.test.ts`, `test/browser-service.test.ts`, `test/server.test.ts`
- Docs: `docs/DESIGN.md` (the "Server browser" section only)

**Produces:** the contract above, and from `src/browser/service.ts`: `SLEEP_AFTER`,
`sleepIdleTabs(now?, after?)`, `wakeTab(id)`.

- [ ] **Step 1: Baseline.** Run
  `bun test test/browser-gate.test.ts test/browser-service.test.ts` and
  `bun test test/server.test.ts -t "server browser"`. All pass, or stop and report.

- [ ] **Step 2: Gate tests (write, see them fail).** In `test/browser-gate.test.ts`, with the
  file's own `client()` and `until()`:

  1. *"a tool call's `Target.getDevToolsTarget` marks the tab used; other commands don't"*: a
     client in `/p/u` with discovery and auto-attach on creates a tab. `gate.times(id)` has
     `usedAt` and `madeAt` near now. Wait 30 ms. Send `Storage.getStorageKey` on the tab's session
     (the `sessionId` from its `Target.attachedToTarget`): `usedAt` is unchanged. Send
     `Target.getDevToolsTarget { targetId: id }`: `usedAt` is later than before, `madeAt` is
     unchanged.
  2. *"another folder's client can't mark a tab used"*: a client in `/p/other` sends
     `Target.getDevToolsTarget { targetId: id }`: the answer is the error "No target with given id
     found" and `usedAt` is unchanged.
  3. *"a tab made with times keeps them"*: `gate.createTab("/p/u", url, "s", { usedAt: 1000,
     madeAt: 500 })`, then `gate.times(id)` equals `{ usedAt: 1000, madeAt: 500 }`. `gate.touch(id,
     2000)` makes `usedAt` 2000; `gate.touch(id, 1500)` leaves it at 2000.

- [ ] **Step 3: Gate.** In `src/browser/gate.ts`:

  ```ts
  export type Tab = { id: string; folder: string; url: string; title: string; openedBy?: string; asleep?: true };
  // usedAt: when the tab was last used (made, a session's tool call, a view). madeAt: when it was
  // first made; a tab woken or restored keeps the one it had. Both ms.
  type Target = { info: any; folder: string | null; openedBy?: string; seen: boolean; announced: boolean; usedAt: number; madeAt: number };
  export type Times = { usedAt: number; madeAt: number };
  ```

  - Both places that make a `Target` (`claim`, and `Target.targetCreated` in `fromChrome`) set
    `usedAt` and `madeAt` to `Date.now()`.
  - `createTab(folder, url, openedBy?, times?: Partial<Times>)` passes `times` to `claim`.
  - `claim(targetId, folder, openedBy?, times?: Partial<Times>)`, after setting the folder:

    ```ts
    t.usedAt = times?.usedAt ?? Date.now();
    if (times?.madeAt !== undefined) t.madeAt = times.madeAt;
    ```

  - New public methods:

    ```ts
    times(id: string): Times | undefined {
      const t = this.targets.get(id);
      return t && { usedAt: t.usedAt, madeAt: t.madeAt };
    }

    // The tab was used at `at`: never moved back.
    touch(id: string, at = Date.now()) {
      const t = this.targets.get(id);
      if (t) t.usedAt = Math.max(t.usedAt, at);
    }
    ```

  - In `fromClient`, right after the line that fails a `targetId` the client can't see and before
    the `switch`:

    ```ts
    // The MCP names the page with this before each tool call acts on it, and never by itself
    // (docs/superpowers/specs/2026-11-23-sleeping-tabs-design.md): the session is using the tab.
    if (m.method === "Target.getDevToolsTarget" && typeof p.targetId === "string") this.touch(p.targetId);
    ```

  Run `bun test test/browser-gate.test.ts`: all pass.

- [ ] **Step 4: Service tests (write, see them fail).** Add these at the END of
  `test/browser-service.test.ts` (the tests before them share one Chrome and expect their tabs
  awake). Import `sleepIdleTabs`, `wakeTab`, `closeTab`, `viewTab`, `SLEEP_AFTER` from the service
  with the others. `far = () => Date.now() + 2 * SLEEP_AFTER` puts every tab without a view past
  the limit. To sleep only the tabs older than a moment: `const mid = Date.now()` after a
  `Bun.sleep(30)`, then `sleepIdleTabs(Date.now(), Date.now() - mid)`. All `live(...)`, each with
  a 30 s timeout.

  1. *"a tab nobody used for the limit sleeps, and stays in the list"*: open `${base}/old`, wait
     until listed, wait 30 ms, take `mid`, open `${base}/fresh`, wait until listed. A `cdp()` client
     of the session with `Target.setDiscoverTargets` on. `await sleepIdleTabs(Date.now(),
     Date.now() - mid)`. Expect: the `/old` tab is in `browserTabs()` with the same `id`, `folder`,
     `url` and `asleep: true`; `/fresh` has no `asleep`; the client's log gets
     `Target.targetDestroyed` for the old id; the client's `Target.getTargets` has no `/old`;
     `tabs.json` has a row with `url` `/old`, `asleep: true` and that `id` at once (no waiting),
     and the `/fresh` row has numbers for `usedAt` and `madeAt`.
  2. *"a tab with a view open doesn't sleep; it does once the view closes and the limit passes"*:
     open `${base}/watched`. `const v = await viewTab(id, { send() {}, close() {} })`.
     `await sleepIdleTabs(far())`: the tab has no `asleep`. `v.close()`, then
     `await sleepIdleTabs(far())`: it has `asleep: true`.
  3. *"waking a tab: a new id, the same folder, address, opener and place"*: use the session's
     tab from earlier in the file (`/made-by-session`, `openedBy` the session) or make one the same
     way; make sure it sleeps (`sleepIdleTabs(far())`). Open `${base}/after` so an awake tab comes
     after it. Note the sleeping tab's index in `browserTabs()`. `const id2 = await
     wakeTab(old.id)`. Expect: `id2 !== old.id`; `browserTabs()` has no `old.id`; the tab `id2` has
     the same `folder`, `url`, `openedBy`, no `asleep`, and the same index; `wakeTab(old.id)`
     rejects with an `HttpError` whose `status` is 404.
  4. *"two wakes of one tab at once make one tab"*: sleep everything, pick a sleeping tab, `const
     [a, b] = await Promise.all([wakeTab(id), wakeTab(id)])`: `a === b`, and one tab in
     `browserTabs()` has that address.
  5. *"closing a sleeping tab removes it"*: sleep everything, `await closeTab(id)` on a sleeping
     one: gone from `browserTabs()`, and (with `until`) from `tabs.json`.
  6. *"over a restart: sleeping tabs stay asleep and don't load, a tab just used loads"*: sleep
     everything, open `${base}/recent`, wait for it in `tabs.json`. `await stopBrowser()`, `port =
     await startBrowserGate()`. Expect (with `until`): `/recent` is back with no `asleep`; a
     sleeping tab from before has the same `id` and `asleep: true`; a `cdp()` client's
     `Target.getTargets` has `/recent` and none of the sleeping addresses.
  7. *"tabs from before this change (no usedAt) come back asleep, and Chrome doesn't start for
     them"*: `await stopBrowser()`. Write `tabs.json` as `[{ folder, url: `${base}/legacy-a` }, {
     folder, url: `${base}/legacy-b`, openedBy: session }]`. `port = await startBrowserGate()`.
     Expect: `browserTabs()` is exactly those two, in that order, each with `asleep: true`, an
     `id`, `title` `""`, and `openedBy` kept; after 1.5 s, `pgrep -f
     user-data-dir=<profile>` (as the "dies by itself" test does) finds nothing. Then
     `wakeTab` of the first gives an awake tab at `/legacy-a`, first in the list.
  8. In the existing MCP test (the one with `mcpTest`), before `p.kill()`: *the guard for the
     pinned MCP*. Open `${base}/untouched` with `openTab`, wait until listed, `Bun.sleep(30)`,
     `const mid = Date.now()`, then `await tool("list_console_messages", { pageId })` (the
     `/via-mcp` page). `await sleepIdleTabs(Date.now(), Date.now() - mid)`. Expect: `/via-mcp` has
     no `asleep` (the tool call marked it), `/untouched` has `asleep: true`. Then `wakeTab` the
     tabs this put to sleep that later tests in the file need awake (`/made-by-session`), or
     adjust nothing else: if a later existing test now fails because its tab sleeps here, wake
     that tab at the end of this block, don't change the later test.

- [ ] **Step 5: Service.** In `src/browser/service.ts` (add `randomUUID` to the `node:crypto`
  import):

  ```ts
  type Saved = { folder: string; url: string; openedBy?: string; usedAt?: number; madeAt?: number; id?: string; title?: string; asleep?: boolean };
  type Row = Saved & { madeAt: number };

  // A tab nobody has used for this long sleeps (docs/superpowers/specs/2026-11-23-sleeping-tabs-design.md).
  export const SLEEP_AFTER = 60 * 60_000;
  // The sleeping tabs, by the id each had awake: closed in Chrome, still in the list.
  const asleep = new Map<string, { tab: Tab; madeAt: number }>();
  // The saved awake tabs, while Chrome isn't running: what it opens when it next starts.
  let toOpen: Row[] = [];
  let loaded = false;
  const viewing = new Map<string, number>(); // tab id → its open views
  const waking = new Map<string, Promise<string>>(); // sleeping tab id → its wake under way
  let sleeper: ReturnType<typeof setInterval> | undefined;
  ```

  - `browserTabs()`: live and sleeping, oldest first.

    ```ts
    export function browserTabs(): Tab[] {
      const g = gate;
      const live = g ? g.tabs().filter((t) => !asleep.has(t.id)).map((t) => ({ tab: t, madeAt: g.times(t.id)?.madeAt ?? 0 })) : [];
      return [...live, ...asleep.values()].sort((a, b) => a.madeAt - b.madeAt).map((x) => x.tab);
    }
    ```

  - `save()` writes every row, also with Chrome not running (remove the `if (!gate) return`):

    ```ts
    function rows(): Row[] {
      const g = gate;
      const awake: Row[] = g
        ? g.tabs().filter((t) => !asleep.has(t.id)).map((t) => ({ folder: t.folder, url: t.url, ...(t.openedBy && { openedBy: t.openedBy }), ...g.times(t.id)! }))
        : toOpen;
      const slept: Row[] = [...asleep.values()].map(({ tab, madeAt }) => ({ id: tab.id, folder: tab.folder, url: tab.url, title: tab.title, ...(tab.openedBy && { openedBy: tab.openedBy }), madeAt, asleep: true }));
      return [...awake, ...slept].sort((a, b) => a.madeAt - b.madeAt);
    }
    ```

    `save()` keeps its `try`/`catch` and writes `JSON.stringify(rows(), null, 2) + "\n"`. Its
    first line becomes `if (!loaded) return;` (nothing read yet, so nothing to write: a write then
    would empty the file).

  - Loading the file, once per start, and the rule for stale rows:

    ```ts
    const putAsleep = (t: Row) => {
      const id = t.id ?? `asleep-${randomUUID()}`;
      asleep.set(id, { tab: { id, folder: t.folder, url: t.url, title: t.title ?? "", ...(t.openedBy && { openedBy: t.openedBy }), asleep: true }, madeAt: t.madeAt });
    };

    // The file's awake rows, in its order. Rows from before tabs slept have no madeAt: they keep
    // the file's order, before any tab made from now on.
    function awakeRows(): Row[] {
      const saved = loadSaved();
      const base = Date.now() - saved.length;
      return saved.map((t, i) => ({ ...t, madeAt: t.madeAt ?? base + i })).filter((t) => !t.asleep);
    }

    // Saved tabs nobody used within the limit (or from before tabs slept: no usedAt) don't open: they sleep.
    function settle(now = Date.now()) {
      const stale = toOpen.filter((t) => !(now - (t.usedAt ?? 0) <= SLEEP_AFTER));
      if (!stale.length) return;
      toOpen = toOpen.filter((t) => !stale.includes(t));
      stale.forEach(putAsleep);
      save();
    }

    function load() {
      loaded = true;
      const saved = loadSaved();
      const base = Date.now() - saved.length;
      saved.map((t, i) => ({ ...t, madeAt: t.madeAt ?? base + i })).filter((t) => t.asleep).forEach(putAsleep);
      toOpen = awakeRows();
      settle();
    }
    ```

    (Fold the two `saved.map` lines into one helper if that reads better; keep the behavior.)

  - `ensureChrome()`: replace `const restore = loadSaved();` with

    ```ts
    if (!loaded) load();
    settle();
    const restore = toOpen;
    ```

    The restore loop passes the times: `g.createTab(t.folder, t.url, t.openedBy, { usedAt: t.usedAt,
    madeAt: t.madeAt })`. Where `gate = g` is set, also `toOpen = [];` and start the sleeper next
    to the refresher:

    ```ts
    sleeper = setInterval(() => void sleepIdleTabs().then(save).catch(() => {}), 60_000);
    ```

    In the `c.exited` handler, where `clearInterval(refresher)` is: `clearInterval(sleeper);` and,
    before `chrome = gate = null`, `toOpen = awakeRows();` (the file has what Chrome had).

  - Sleeping:

    ```ts
    // Every tab with no view open that nobody has used for `after` goes to sleep: closed in
    // Chrome, kept in the list. Saved before the close, so a blimpd that stops between the two
    // doesn't open the tab again.
    export async function sleepIdleTabs(now = Date.now(), after = SLEEP_AFTER): Promise<void> {
      const g = gate;
      if (!g) return;
      const idle = g.tabs().filter((t) => !viewing.has(t.id) && !asleep.has(t.id) && now - (g.times(t.id)?.usedAt ?? now) > after);
      if (!idle.length) return;
      for (const t of idle) asleep.set(t.id, { tab: { ...t, asleep: true }, madeAt: g.times(t.id)!.madeAt });
      save();
      await Promise.all(idle.map((t) => g.closeTab(t.id).catch(() => {})));
      changed();
    }
    ```

  - Waking:

    ```ts
    // A sleeping tab opens again at its address, in its folder and at its place in the list. The
    // new tab's id (Chrome's). Two wakes of one tab at once get the same answer.
    export function wakeTab(id: string): Promise<string> {
      const going = waking.get(id);
      if (going) return going;
      if (!asleep.has(id)) return Promise.reject(new HttpError(404, "no such sleeping tab"));
      const p = (async () => {
        let g: Gate;
        try {
          g = await ensureChrome();
        } catch (e) {
          throw new HttpError(503, (e as Error).message);
        }
        const s = asleep.get(id);
        if (!s) throw new HttpError(404, "no such sleeping tab"); // closed meanwhile
        asleep.delete(id);
        try {
          const made = await g.createTab(s.tab.folder, s.tab.url, s.tab.openedBy, { madeAt: s.madeAt });
          save(); // at once: the file no longer says it sleeps, so a Chrome that dies now reopens it
          return made;
        } catch (e) {
          asleep.set(id, s);
          changed();
          throw new HttpError(503, (e as Error).message);
        }
      })().finally(() => waking.delete(id));
      waking.set(id, p);
      return p;
    }
    ```

  - `closeTab(id)`: first line `if (asleep.delete(id)) return changed();`.
  - `hasTab(id)`: awake tabs only: `browserTabs().some((t) => t.id === id && !t.asleep)`.
  - `viewTab(id, sock)`: counts the view and touches the tab as it opens and closes.

    ```ts
    export async function viewTab(id: string, sock: ViewSocket) {
      const g = gate;
      if (!chrome || !g?.tabs().some((t) => t.id === id) || asleep.has(id)) throw new Error("That browser tab is closed.");
      // A tab with a view open doesn't sleep; the hour starts when the last view closes.
      viewing.set(id, (viewing.get(id) ?? 0) + 1);
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        const n = (viewing.get(id) ?? 1) - 1;
        if (n) viewing.set(id, n);
        else viewing.delete(id);
        g.touch(id);
      };
      try {
        const v = await openView(chrome, (t) => g.attachDirect(t), id, sock);
        return { message: v.message, close: () => (leave(), v.close()) };
      } catch (e) {
        leave();
        throw e;
      }
    }
    ```

    Check `src/server.ts`'s use of `viewTab` still type-checks (it awaits it already).

  - `startBrowserGate()`: replace its last lines (the "Tabs from before" start) with: `load();`
    then start Chrome only if `toOpen.length && browserAvailable()`.
  - `stopBrowser()`: after `await c?.exited`, reset for the next start: `clearTimeout(saveTimer);
    asleep.clear(); toOpen = []; loaded = false; viewing.clear();`. The `clearTimeout` matters:
    Chrome's exit schedules a save, and one that ran after the reset would write an empty list.
  - Update the file's header comment for the new behavior, in the file's style.

  Run `bun test test/browser-service.test.ts`: all pass, the old tests too.

- [ ] **Step 6: The route.** In `src/server.ts`, import `wakeTab`, and before the `tab` `DELETE`
  match:

  ```ts
  // A sleeping tab opens again: the new tab's id, for the app to put where the old one was.
  const wake = path.match(/^\/browser\/tabs\/([^/]+)\/wake$/);
  if (wake && req.method === "POST") return Response.json({ id: await wakeTab(decodeURIComponent(wake[1])) });
  ```

  In `test/server.test.ts`'s "server browser" block: `POST /browser/tabs/nope/wake` is 404, and
  401 without the token. With Chrome: open a tab, put it to sleep (import `sleepIdleTabs` and
  `SLEEP_AFTER` if the server under test runs in this process, as the block's use of the service
  suggests; if it doesn't, say so in your report and test what you can), then: `GET
  /browser/tabs` has it with `asleep: true`; its view route is 404; the events socket got a
  `browser` message with it asleep; `POST …/wake` is 200 with a new id; the list then has the new
  id without `asleep` and not the old; `DELETE` of a sleeping tab is 204.

  Run `bun test test/server.test.ts -t "server browser"`: pass.

- [ ] **Step 7: Docs.** In `docs/DESIGN.md`, "Server browser" section only: `tabs.json`'s new
  rows, when Chrome starts with blimpd, a short "Sleeping tabs" paragraph (the rule for "used",
  the minute timer, wake), the `asleep` field on `BrowserTab` (also where the events socket's
  `browser` message is described), and the wake route with the others. The file's style: short,
  factual.

- [ ] **Step 8: Check everything of yours.** `bun test test/browser-gate.test.ts
  test/browser-service.test.ts test/browser-view.test.ts` and
  `bun test test/server.test.ts`. Then `bunx tsc --noEmit -p .` if the repo has a tsconfig for
  `src` (otherwise skip and say so). Report: what you changed, each command's last lines, anything
  you left undone or weren't sure of.

---

### Task 2: The Mac app

**Files:**
- Modify: `app/src/lib/api.ts`, `app/src/lib/reorder.ts`, `app/src/components/Workbench.tsx`,
  `app/src/components/PageView.tsx`, `app/src/styles/app.css`
- Test: `app/src/lib/reorder.test.ts`; `app/e2e/browser.spec.ts` only if step 5 says so
- Docs: `README.md` (the "Browser tabs" bullets), `docs/MAC-CHECKLIST.md`

**Consumes:** the contract above. Don't read or change `src/`; the server is being built now.

- [ ] **Step 1: Baseline.** `cd app && bun test src` and `bun run build` pass, or stop and report.

- [ ] **Step 2: The helper, test first.** In `app/src/lib/reorder.test.ts`, then
  `app/src/lib/reorder.ts`:

  ```ts
  // A woken browser tab has a new id: it takes the old one's place in a dragged order. An order
  // that doesn't have the old id (never dragged, or the tab came after) stays as it is.
  export const replaced = (order: string[] | undefined, was: string, now: string): string[] | undefined =>
    order?.includes(was) ? order.map((k) => (k === was ? now : k)) : order;
  ```

  Tests: `replaced(["a","b","c"], "b", "x")` → `["a","x","c"]`; `replaced(["a"], "b", "x")` is the
  same array; `replaced(undefined, "b", "x")` → `undefined`.

- [ ] **Step 3: API.** In `app/src/lib/api.ts`: `BrowserTab` gets `asleep?: boolean`, and its
  comment says a sleeping tab is closed in the server's Chrome until it's woken. Next to
  `closeBrowserTab`:

  ```ts
  // Wakes a sleeping tab: the server opens its address again, as a tab with a new id.
  wakeBrowserTab(id: string) {
    return this.json<{ id: string }>(`/browser/tabs/${encodeURIComponent(id)}/wake`, { method: "POST" });
  }
  ```

- [ ] **Step 4: The strip and the wake.** Behavior, in `Workbench.tsx` and `PageView.tsx`:

  - **Strip:** a sleeping tab's `div.page-tab` also has the class `asleep` (dimmed, in
    `app.css`, next to the other `.page-tab` rules; pick the opacity the app already uses for
    things that are there but not live), and its tooltip gets a line: `Asleep. It loads again when
    you open it.` Close (×, middle click, ⌘W) works as for any tab.
  - **Wake when it's the one on screen:** `PageView` gets `onWake: () => void` and `wakeError?:
    string`. In its view-socket effect, a tab with `tab.asleep` opens no socket; it calls
    `props.onWake()` instead (under the same condition the socket has: `props.shown && seen` and
    an api). Add `tab.asleep` to the effect's dependencies. A background tab never wakes.
  - **What the pane shows meanwhile:** the bar with the tab's address, and over the page area
    `Waking…`, with the existing overlay's look (see how "Reconnecting…" is drawn). With
    `wakeError`: `Couldn't wake the tab: <error>` and a **Try Again** button that calls `onWake`.
    No automatic retry.
  - **`wakePage(key)` in `Workbench`** (near `closePage`): does nothing if the tab isn't asleep,
    there's no api, or a wake of that key is under way (keep the keys under way in a ref `Set`,
    as `opening` and `gone` are). Clears that key's error. Calls
    `api.wakeBrowserTab(tab.id)`. On success with the new id: add `tab:<new>` to `opening`; if
    `props.pageOrder` has the old id, `props.onPageOrder(replaced(props.pageOrder, old, new)!)`;
    if the old key is still `active`, make `tab:<new>` active (`setActiveState`); take the key out
    of the set; rerender. On failure: take the key out of the set, keep the error text for that
    key (`errorText(e)`, in state or a ref plus `rerender()`), and pass it to that tab's
    `PageView` as `wakeError`.
  - **Don't lose the front tab mid-wake.** The effect commented "A tab closed elsewhere … takes
    this one off it" moves `active` to the last tab when the active one leaves the list. The
    server can list the woken tab (and drop the old id) before the wake's answer comes. So that
    effect must also leave `active` alone while a wake of `active` is under way. Without this, the
    last tab comes to the front, and if it's asleep it wakes too.
  - The globe's hide/show (`lastPage`) and "Send to session" need nothing.

  Don't restructure either component. Match their style.

- [ ] **Step 5: e2e, if the harness allows it cheaply.** Read `app/e2e/browser.spec.ts` and
  `app/e2e/helpers.ts`. If a test there can start its blimpd with a `tabs.json` you write first
  (rows `{ folder, url, id: "S1", title: "Slept", asleep: true, madeAt: 1 }`), add one test: the
  tab is in the strip with class `asleep`; clicking it shows `Waking…` and then the page; the
  strip then has one tab for that address, without `asleep`. This test needs Task 1's server, so
  it may fail until that lands: write it, run it once, and report the result either way. If the
  harness can't do this without new machinery, skip it and say so.

- [ ] **Step 6: Docs.** `README.md`, in the "Browser tabs" bullets: one bullet. A tab nobody has
  used for an hour goes to sleep: it stays in the strip, dimmed, and uses no memory on the server;
  open it and the page loads again (what you typed in it is gone); a tab on your screen doesn't
  sleep; to a session a sleeping tab is closed. `docs/MAC-CHECKLIST.md`: one item in the browser
  section, in the file's Do / Expect form, for: a tab left an hour shows dimmed; clicking it shows
  Waking… then the page, in the same place in the strip; closing a dimmed tab removes it.

- [ ] **Step 7: Check.** `cd app && bun test src && bun run build`. Report: what you changed,
  each command's last lines, the e2e result or why skipped, anything you weren't sure of.

---

### Task 3: The phone app

**Files:**
- Modify: `ios/BlimpKit/Sources/BlimpKit/Browser.swift`, `ios/Blimp/Net/API.swift`,
  `ios/Blimp/Model/Store.swift`, `ios/Blimp/Views/DrawerView.swift`,
  `ios/Blimp/Views/HomeView.swift`
- Test: `ios/BlimpKit/Tests/BlimpKitTests/BrowserTests.swift`
- Docs: `docs/PHONE-CHECKLIST.md`

**Consumes:** the contract above. This server has no Swift: nothing here can be compiled or run.
Write carefully against the code around it, and say in your report that it's unbuilt. GitHub's Mac
build is the check.

- [ ] **Step 1: The model.** `BrowserTab` gets `public let asleep: Bool?` (documented: true while
  the tab sleeps: closed in the server's Chrome until woken; nil otherwise), an `asleep: Bool? =
  nil` last in `init`, and `public var isAsleep: Bool { asleep == true }`. Decoding stays
  synthesized. In `BrowserTests.swift`: add a tab with `"asleep":true` to a test's JSON (a new
  test, or the existing list without breaking its expectations) and expect `isAsleep`; a tab
  without the key has `isAsleep == false`.

- [ ] **Step 2: The call.** In `API.swift`, next to the tab open and close calls, in their style:
  `wakeTab(_ id: String) async throws -> String`: `POST /browser/tabs/<id>/wake`, returns the
  answer's `id`. Percent-encode the id only if the neighbors do. In `Store.swift`, a `wakeTab`
  beside `openTab` / `closeTab` that calls it, shaped like them.

- [ ] **Step 3: The drawer and the tap.** `DrawerView.tabRow`: a sleeping tab's row is dimmed
  (`.opacity(0.5)` on the label's content, not on the swipe actions) and its accessibility label
  ends with `, asleep`. `HomeView`: the drawer's `onTab` for a sleeping tab closes the drawer,
  wakes it (`store.wakeTab`), and on success sets `browserTab` to the new id; on failure sets
  `actions.failure = Store.words(for: error)` as `closeTab` does. An awake tab opens as now. The
  view appears once the list has the new id (the existing overlay condition does that).
  Update `DrawerView`'s header comment by a few words.

- [ ] **Step 4: Docs.** `docs/PHONE-CHECKLIST.md`, in the browser tabs section: one item. A tab
  left an hour is dimmed in the drawer; a tap opens it after a moment, loaded again; a swipe
  closes it.

- [ ] **Step 5: Report** what you changed and that it's unbuilt, plus anything you weren't sure
  of (name the line).
