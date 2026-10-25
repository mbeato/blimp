# Phone: open a folder, and the drawer's column — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the iPhone drawer, browse the computer's folders (from home), make a folder, and open one as a project (bringing back a hidden one). The drawer's projects go back to a column down its left side, with + and Settings at its foot, and New session becomes a labelled button above Active.

**Architecture:**
- blimpd keeps the folders opened from the phone in `opened.json`, beside `hidden.json`. `GET /folders/recent` merges them in, so an opened folder stays a project before Claude has run there.
- The phone uses the existing `/fs/list` and `/fs/mkdir` routes, plus a new `POST /folders/opened`.
- The phone's pure rules live in BlimpKit, with tests.
- The views are `FolderBrowserView` (new) and `DrawerView` (reworked), wired up in `HomeView`.

**Tech Stack:**
- Server: Bun + TypeScript (`bun test`).
- Phone: SwiftUI, iOS 17, Swift 6 language mode; BlimpKit is a Swift package tested with `swift test`; UI tests use XCUITest.
- CI: GitHub Actions `iOS` workflow.

**Spec:** `docs/superpowers/specs/2026-10-25-phone-open-folder-design.md`

## Global Constraints

- **Commits:** never add a `Co-Authored-By: Claude` line or any other Claude attribution (Max's hard rule). Messages are plain sentences with an area prefix, like the repo's history: `blimpd: …`, `iPhone: …`, `Docs: …`.
- **Comments:** match the surrounding code. Short plain sentences that say what a thing does and why.
- **Swift:** Swift 6 language mode (`SWIFT_VERSION: "6.0"`), iOS 17 minimum.
- **BlimpKit portability:** BlimpKit also builds and tests on Linux (CI job `kit-linux`). It may import Foundation only, never SwiftUI or UIKit.
- **Building Swift:** no Swift toolchain on this machine (`swift`/`xcodebuild` not found), so Swift tasks are written carefully and compiled in CI (Task 5). If `swift --version` works when you start, run `cd ios/BlimpKit && swift test` after Tasks 2 and 3.
- **iOS CI runs:** never start a manual iOS run (`gh workflow run iOS …`) while main's push iOS run is still going. Both use the MacBook's runners with the same ports and break each other.
- **Out of scope:**
  - The Mac app is untouched.
  - No hidden-projects list.
  - The browser always starts at home.
- **Exact copy (from the spec):**
  - "Open a folder on the computer to start."
  - "Open a Folder"
  - "New session"
  - "Open a folder" (accessibility label of +)
  - "No folders here."
  - "New Folder"
  - "Open \<name\>"
  - "A name can't contain / or be . or .."
  - "\<name\> already exists."
  - "Couldn't do that"
- **Accessibility ids:**
  - Kept: `drawerStrip` (now the column), `drawerNewSession`, `settingsButton`, `strip-<name>`, `drawerProject`.
  - New: `drawerOpenFolder`, `folder-<name>`, `folderBrowserEmpty`, `folderBrowserNewFolder`, `folderBrowserName`, `folderBrowserOpen`.

---

### Task 1: blimpd remembers opened folders (`POST /folders/opened`)

**Files:**
- Create: `src/opened.ts`
- Create: `test/opened.test.ts`
- Modify: `src/folders.ts` (`recentFolders`, around lines 82-104)
- Modify: `src/server.ts` (imports at lines 15-19, the folder routes at lines 297-305)
- Modify: `test/folders.test.ts` (after the test at line 51)
- Modify: `test/server.test.ts` (new `describe` after `describe("hidden folders", …)`, which ends near line 2166)
- Modify: `docs/DESIGN.md` (the `GET /folders/recent` and `GET /folders/hidden` paragraphs, around lines 130-132)

**Interfaces:**
- Produces:
  - `export type Opened = { dir: string; at: number }`
  - `readOpened(file?: string): Opened[]`
  - `addOpened(dir: string, at?: number, file?: string): Opened[]`
  - `recentFolders(dir?, temp?, hidden?, opened?: Opened[])`
  - HTTP `POST /folders/opened` with body `{ "dir": string }`. It answers 200 with `[{ dir, lastUsed }]`, the same list `GET /folders/recent` gives, or 400.

- [ ] **Step 1: Write the failing unit test for opened.ts**

Create `test/opened.test.ts`:

```ts
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addOpened, readOpened } from "../src/opened";

const root = mkdtempSync(join(tmpdir(), "blimp-opened-"));
const file = join(root, "opened.json");
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("with no file, no folder was opened", () => {
  expect(readOpened(file)).toEqual([]);
});

test("the newest open is first, opening one again moves it to the front, at most 30 are kept, and the file is yours alone", () => {
  expect(addOpened("/w/a", 1, file)).toEqual([{ dir: "/w/a", at: 1 }]);
  expect(addOpened("/w/b", 2, file)).toEqual([{ dir: "/w/b", at: 2 }, { dir: "/w/a", at: 1 }]);
  expect(addOpened("/w/a", 3, file)).toEqual([{ dir: "/w/a", at: 3 }, { dir: "/w/b", at: 2 }]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  for (let i = 0; i < 40; i++) addOpened(`/w/n${i}`, 10 + i, file);
  const kept = readOpened(file);
  expect(kept).toHaveLength(30);
  expect(kept[0]).toEqual({ dir: "/w/n39", at: 49 });
});

test("a file that isn't a list of opened folders keeps only the entries that are", () => {
  writeFileSync(file, JSON.stringify({ dirs: [{ dir: "/w/a", at: 1 }, { dir: 5, at: 1 }, { dir: "", at: 1 }, { dir: "/w/b" }, null, "x", { dir: "/w/c", at: 2, extra: true }] }));
  expect(readOpened(file)).toEqual([{ dir: "/w/a", at: 1 }, { dir: "/w/c", at: 2 }]);
  writeFileSync(file, "not json");
  expect(readOpened(file)).toEqual([]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test test/opened.test.ts`
Expected: FAIL. The import `../src/opened` can't be resolved.

- [ ] **Step 3: Write opened.ts**

Create `src/opened.ts`:

```ts
// Folders you opened as projects from the phone's folder browser, so one stays in the recent folders before Claude
// has run there. <socket dir>/opened.json: { "dirs": [{ "dir": "/Users/me/new-app", "at": 1729850000000 }] },
// newest first, at most 30. Opening a hidden one shows it again (server.ts).

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blimpDir } from "./sessions";

export type Opened = { dir: string; at: number };

export const openedFile = () => join(blimpDir(), "opened.json");

// Missing or unreadable: none. Entries that aren't a folder and a time are dropped.
export function readOpened(file = openedFile()): Opened[] {
  try {
    const dirs = JSON.parse(readFileSync(file, "utf8"))?.dirs;
    if (Array.isArray(dirs))
      return dirs
        .filter((d) => typeof d?.dir === "string" && d.dir !== "" && typeof d.at === "number")
        .map((d) => ({ dir: d.dir, at: d.at }));
  } catch {}
  return [];
}

// Records dir as opened at `at`, first in the list (once); returns the list now.
export function addOpened(dir: string, at = Date.now(), file = openedFile()): Opened[] {
  const dirs = [{ dir, at }, ...readOpened(file).filter((d) => d.dir !== dir)].slice(0, 30);
  writeFileSync(file + ".tmp", JSON.stringify({ dirs }), { mode: 0o600 });
  // mode only applies to a new file: a .tmp left from before keeps its own.
  chmodSync(file + ".tmp", 0o600);
  renameSync(file + ".tmp", file);
  return dirs;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `bun test test/opened.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing recentFolders tests**

In `test/folders.test.ts`, add after the test `"recentFolders: none you hid, left out before the list is cut to 30"`:

```ts
test("recentFolders: a folder you opened counts from when you opened it, unless hidden or gone, even in a temporary folder", () => {
  const fresh = join(root, "work", "fresh");
  mkdirSync(fresh, { recursive: true });
  // fresh has no transcript; api's (2000 s) is older than its open, web's (3000 s) newer.
  const opened = [
    { dir: fresh, at: 2_500_000 },
    { dir: api, at: 2_600_000 },
    { dir: web, at: 1_000 },
    { dir: join(root, "gone"), at: 5_000_000 },
  ];
  expect(recentFolders(claude, [], new Set(), opened)).toEqual([
    { dir: web, lastUsed: 3_000_000 },
    { dir: api, lastUsed: 2_600_000 },
    { dir: fresh, lastUsed: 2_500_000 },
  ]);
  expect(recentFolders(claude, [], new Set([fresh]), opened).map((f) => f.dir)).toEqual([web, api]);
  // You picked them: a temporary folder leaves out only their transcripts.
  expect(recentFolders(claude, [root], new Set(), opened)).toEqual([
    { dir: api, lastUsed: 2_600_000 },
    { dir: fresh, lastUsed: 2_500_000 },
    { dir: web, lastUsed: 1_000 },
  ]);
});

test("recentFolders: the list is cut to 30 after the opened folders join it", () => {
  const many = Array.from({ length: 35 }, (_, i) => {
    const d = join(root, "many", `f${i}`);
    mkdirSync(d, { recursive: true });
    return { dir: d, at: 10_000_000 + i };
  });
  const list = recentFolders(claude, [], new Set(), many);
  expect(list).toHaveLength(30);
  expect(list[0]).toEqual({ dir: join(root, "many", "f34"), lastUsed: 10_000_034 });
  expect(list.map((f) => f.dir)).not.toContain(web);
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `bun test test/folders.test.ts`
Expected: the two new tests FAIL, because `recentFolders` ignores the 4th argument. All the others pass.

- [ ] **Step 7: Merge opened folders into recentFolders**

In `src/folders.ts`, add the import after the other `./` imports:

```ts
import type { Opened } from "./opened";
```

Replace the comment and the start of `recentFolders` (the old `try { … } catch { return []; }` returned early). Old:

```ts
// hidden: the projects you hid from the phone's strip (hidden.ts), left out before the list is cut to 30.
export function recentFolders(dir = claudeDir(), temp = tempRoots(), hidden = new Set<string>()): { dir: string; lastUsed: number }[] {
  const projects = join(dir, "projects");
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    return [];
  }
```

New:

```ts
// hidden: the projects you hid from the phone's strip (hidden.ts), left out before the list is cut to 30.
// opened: the folders you opened from the phone's folder browser (opened.ts), from when you opened them, even in a
// temporary folder (you picked them), so one is listed before Claude has run there.
export function recentFolders(
  dir = claudeDir(),
  temp = tempRoots(),
  hidden = new Set<string>(),
  opened: Opened[] = [],
): { dir: string; lastUsed: number }[] {
  const projects = join(dir, "projects");
  let folders: string[];
  try {
    folders = readdirSync(projects);
  } catch {
    folders = []; // no transcripts yet: the opened folders still count
  }
```

Then, right after the `for (const f of folders) { … }` loop and before `return [...seen]`, add:

```ts
  for (const o of opened) {
    if (hidden.has(o.dir) || !existsSync(o.dir)) continue;
    seen.set(o.dir, Math.max(seen.get(o.dir) ?? 0, o.at));
  }
```

- [ ] **Step 8: Run them to see them pass**

Run: `bun test test/folders.test.ts test/opened.test.ts test/hidden.test.ts`
Expected: PASS, every test in all three files.

- [ ] **Step 9: Write the failing route test**

In `test/server.test.ts`, add after the closing `});` of `describe("hidden folders", …)`:

```ts
describe("opened folders", () => {
  test("a folder opened from the phone joins the recent folders and shows a hidden one again; only a folder inside home", async () => {
    const dir = join(homeDir, `${tag}-opened`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "file.txt"), "x");
    const open = (d: unknown) => api("/folders/opened", { method: "POST", body: JSON.stringify({ dir: d }) });
    const dirs = (list: unknown) => (list as { dir: string }[]).map((f) => f.dir);

    await api("/folders/hidden", { method: "POST", body: JSON.stringify({ dir, hidden: true }) });
    const r = await open(dir);
    expect(r.status).toBe(200);
    expect(dirs(await r.json())).toContain(dir);
    expect(await (await api("/folders/hidden")).json()).not.toContain(dir);
    expect(dirs(await (await api("/folders/recent")).json())).toContain(dir);
    expect(statSync(join(tmp, "opened.json")).mode & 0o777).toBe(0o600);

    for (const bad of [undefined, 5, "relative/dir", join(dir, "missing"), join(dir, "file.txt"), tmpdir()]) {
      expect((await open(bad)).status).toBe(400);
    }
  }, 15000);
});
```

(`homeDir`, `tag`, `tmp`, `api`, `statSync`, `mkdirSync`, `writeFileSync`, `tmpdir` and `join` are all defined or imported at the top of the file already. blimpd's socket folder is `tmp`, like `push.json` in the next describe.)

- [ ] **Step 10: Run it to see it fail**

Run: `bun test test/server.test.ts -t "opened folders"`
Expected: FAIL, because `r.status` is 404, not 200.

- [ ] **Step 11: Add the route**

In `src/server.ts`, add to the imports (next to `import { readHidden, setHidden } from "./hidden";`):

```ts
import { addOpened, readOpened } from "./opened";
```

Replace the recent-folders line. Old:

```ts
  if (path === "/folders/recent" && get) return Response.json(recentFolders(claudeDir(), tempRoots(), new Set(readHidden())));
```

New:

```ts
  if (path === "/folders/recent" && get) return Response.json(recentFolders(claudeDir(), tempRoots(), new Set(readHidden()), readOpened()));
```

Then, right after the `if (path === "/folders/hidden" && req.method === "POST") { … }` block, add:

```ts
  // A folder the phone's browser opened as a project: shown again if it was hidden, and kept in the recent folders
  // so it stays a project before Claude has run there. Answers with the recent folders.
  if (path === "/folders/opened" && req.method === "POST") {
    const { dir } = ((await req.json()) ?? {}) as Record<string, unknown>;
    if (typeof dir !== "string" || !dir.startsWith("/")) throw new HttpError(400, "dir must be a folder's full path");
    let folder = false;
    try {
      folder = isDir(guardList(dir));
    } catch {}
    if (!folder) throw new HttpError(400, "dir must be a folder inside your home folder");
    setHidden(dir, false);
    addOpened(dir);
    return Response.json(recentFolders(claudeDir(), tempRoots(), new Set(readHidden()), readOpened()));
  }
```

(`isDir`, `guardList` and `HttpError` are already in `server.ts`. `isDir` is at line 102, and the other two are imported from `./files`.)

- [ ] **Step 12: Run it to see it pass, then run the whole server suite**

Run: `bun test test/server.test.ts -t "opened folders"`
Expected: PASS.

Run: `bun test`
Expected: PASS everywhere. If an unrelated test fails, say which one and check whether it also fails on `main`. Don't change it.

- [ ] **Step 13: Docs**

In `docs/DESIGN.md`, add this sentence to the end of the `` `GET /folders/recent` `` paragraph:

```
Plus the folders opened from the phone (`POST /folders/opened`), with `lastUsed` the later of the open and the newest transcript, even in a temporary folder; hidden and deleted ones are left out, and the list is cut to 30 after.
```

After the `` `GET /folders/hidden` `` paragraph, add a new paragraph:

```
`POST /folders/opened` `{ "dir": string }` → `GET /folders/recent`'s list after it: the phone's folder browser opened `dir` as a project. 400 unless `dir` is a full path to a folder inside home. It shows the folder again if it was hidden, and keeps it in `<socket dir>/opened.json` (`src/opened.ts`, `{ "dirs": [{ "dir": string, "at": number /* ms */ }] }`, newest first, at most 30, mode 600), so the folder stays a project before Claude has run there.
```

- [ ] **Step 14: Commit**

```bash
git add src/opened.ts src/folders.ts src/server.ts test/opened.test.ts test/folders.test.ts test/server.test.ts docs/DESIGN.md
git commit -m "blimpd: POST /folders/opened keeps a folder the phone opened as a project (opened.json, newest first, at most 30, mode 600) and shows it again if it was hidden; GET /folders/recent lists opened folders from when they were opened, even in a temporary folder, before the cut to 30"
```

---

### Task 2: BlimpKit — the folder browser's rules and the column's order

**Files:**
- Modify: `ios/BlimpKit/Sources/BlimpKit/Models.swift` (next to `RecentFolder`, around line 418)
- Create: `ios/BlimpKit/Sources/BlimpKit/Folders.swift`
- Modify: `ios/BlimpKit/Sources/BlimpKit/Strip.swift` (`held`)
- Create: `ios/BlimpKit/Tests/BlimpKitTests/FoldersTests.swift`
- Modify: `ios/BlimpKit/Tests/BlimpKitTests/StripTests.swift` (add a test at the end)

**Interfaces:**
- Consumes: the `GET /fs/list` reply `{ "path": string, "entries": [{ "name", "kind": "dir"|"file", "size", "mtime" }] }` (it already exists, in `src/files.ts` `listDir`).
- Produces:
  - `public struct DirEntry: Codable, Sendable, Equatable, Identifiable { name: String; kind: String; size: Double; mtime: Double; id: String { name }; isFolder: Bool }`
  - `public struct DirListing: Codable, Sendable, Equatable { path: String; entries: [DirEntry] }`
  - `Folders.shown(_ entries: [DirEntry]) -> (folders: [DirEntry], files: [DirEntry])`
  - `Folders.nameProblem(_ name: String) -> String?`
  - `Folders.label(path: String, home: String) -> String`
  - `Strip.held(_ projects: [ProjectChoice], order: [String], shown: String? = nil) -> [ProjectChoice]`

- [ ] **Step 1: Write the failing tests**

Create `ios/BlimpKit/Tests/BlimpKitTests/FoldersTests.swift`:

```swift
import Foundation
import Testing
@testable import BlimpKit

// The phone's folder browser: what a folder shows, New Folder's names, and the path under the title.

private func entry(_ name: String, _ kind: String) -> DirEntry { DirEntry(name: name, kind: kind, size: 0, mtime: 0) }

@Test func aFolderListingDecodes() throws {
    let json = #"{"path":"/Users/max/code","entries":[{"name":"blimp","kind":"dir","size":4096,"mtime":1729850000000},{"name":"a.txt","kind":"file","size":3,"mtime":1}]}"#
    let listing = try JSONDecoder().decode(DirListing.self, from: Data(json.utf8))
    #expect(listing.path == "/Users/max/code")
    #expect(listing.entries.map(\.isFolder) == [true, false])
}

@Test func aFolderShowsItsFoldersThenItsFilesAndNothingStartingWithADot() {
    let shown = Folders.shown([entry(".config", "dir"), entry("api", "dir"), entry("blimp", "dir"), entry(".zshrc", "file"), entry("notes.txt", "file")])
    #expect(shown.folders.map(\.name) == ["api", "blimp"])
    #expect(shown.files.map(\.name) == ["notes.txt"])
}

@Test func newFolderRefusesASlashAndTheDotNames() {
    #expect(Folders.nameProblem("my-app") == nil)
    // empty: nothing to make, so nothing to say
    #expect(Folders.nameProblem("") == nil)
    #expect(Folders.nameProblem("a/b") == "A name can't contain / or be . or ..")
    #expect(Folders.nameProblem(".") != nil)
    #expect(Folders.nameProblem(" .. ") != nil)
    #expect(Folders.nameProblem(".hidden") == nil)
}

@Test func thePathUnderTheTitleSaysTildeForHome() {
    #expect(Folders.label(path: "/Users/max", home: "/Users/max") == "~")
    #expect(Folders.label(path: "/Users/max/code/app", home: "/Users/max") == "~/code/app")
    // only the home folder itself, not one whose name starts the same
    #expect(Folders.label(path: "/Users/maxine", home: "/Users/max") == "/Users/maxine")
}
```

At the end of `ios/BlimpKit/Tests/BlimpKitTests/StripTests.swift`, add:

```swift
@Test func aProjectJustOpenedFromTheBrowserGoesFirstNotLast() {
    let order = ["/a", "/b"]
    let now = [project("/new", activity: 1), project("/a", activity: 3), project("/b", activity: 2), project("/other", activity: 0)]
    #expect(Strip.held(now, order: order, shown: "/new").map(\.dir) == ["/new", "/a", "/b", "/other"])
    // one already held stays where it was
    #expect(Strip.held(now, order: order, shown: "/b").map(\.dir) == ["/a", "/b", "/new", "/other"])
    // nothing held yet: as they come, so the order the drawer opens with doesn't jump
    #expect(Strip.held(now, order: [], shown: "/b").map(\.dir) == ["/new", "/a", "/b", "/other"])
}
```

- [ ] **Step 2: Run them to see them fail (only if Swift is available here)**

Run: `cd ios/BlimpKit && swift test`
Expected: compile errors, because `DirEntry`, `DirListing`, `Folders` and `held(_:order:shown:)` don't exist yet. With no Swift here, skip this step. CI runs it in Task 5.

- [ ] **Step 3: Add the models**

In `ios/BlimpKit/Sources/BlimpKit/Models.swift`, right after the `RecentFolder` line, add:

```swift
/// One name in a folder on the computer (GET /fs/list): "dir" or "file", its size and when it last changed (ms).
public struct DirEntry: Codable, Sendable, Equatable, Identifiable {
    public let name: String
    public let kind: String
    public let size: Double
    public let mtime: Double
    public var id: String { name }
    public var isFolder: Bool { kind == "dir" }
}
/// A folder on the computer and what's in it, folders first, A to Z (GET /fs/list).
public struct DirListing: Codable, Sendable, Equatable { public let path: String; public let entries: [DirEntry] }
```

- [ ] **Step 4: Add Folders.swift**

Create `ios/BlimpKit/Sources/BlimpKit/Folders.swift`:

```swift
// The phone's folder browser (FolderBrowserView): what a folder shows, the name a new folder may have, and a path
// as the browser shows it under its title.
import Foundation

public enum Folders {
    /// A folder's folders, then its files (greyed in the browser), in blimpd's order (A to Z). None whose name starts
    /// with ".": on a phone they would fill the first screen of home.
    public static func shown(_ entries: [DirEntry]) -> (folders: [DirEntry], files: [DirEntry]) {
        let seen = entries.filter { !$0.name.hasPrefix(".") }
        return (seen.filter(\.isFolder), seen.filter { !$0.isFolder })
    }

    /// Why New Folder can't make `name` (the Mac's words), or nil when it can. Empty is nil too: there's nothing to make.
    public static func nameProblem(_ name: String) -> String? {
        let n = name.trimmingCharacters(in: .whitespaces)
        if n.contains("/") || n == "." || n == ".." { return "A name can't contain / or be . or .." }
        return nil
    }

    /// "~" for home, "~/code" inside it, else the path as it is.
    public static func label(path: String, home: String) -> String {
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + String(path.dropFirst(home.count)) }
        return path
    }
}
```

- [ ] **Step 5: Let Strip.held put a just-opened project first**

In `ios/BlimpKit/Sources/BlimpKit/Strip.swift`, replace `held`. Old:

```swift
    /// projects in `order` (their folders, as the drawer came out), then any new since in their own order. One
    /// gone since is left out.
    public static func held(_ projects: [ProjectChoice], order: [String]) -> [ProjectChoice] {
        let at = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        let kept = projects.filter { at[$0.dir] != nil }.sorted { at[$0.dir]! < at[$1.dir]! }
        return kept + projects.filter { at[$0.dir] == nil }
    }
```

New:

```swift
    /// projects in `order` (their folders, as the drawer came out), then any new since in their own order. `shown`, the
    /// project on screen, goes first instead when it's new since: a folder just opened from the browser. One gone since
    /// is left out. With nothing held yet, they're as they come.
    public static func held(_ projects: [ProjectChoice], order: [String], shown: String? = nil) -> [ProjectChoice] {
        let at = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        let kept = projects.filter { at[$0.dir] != nil }.sorted { at[$0.dir]! < at[$1.dir]! }
        let new = projects.filter { at[$0.dir] == nil }
        guard !order.isEmpty, let shown, new.contains(where: { $0.dir == shown }) else { return kept + new }
        return new.filter { $0.dir == shown } + kept + new.filter { $0.dir != shown }
    }
```

Also update the file's header comment. Its first line becomes `// The drawer's column of projects (DrawerView): an icon each, two letters from its folder's name, in the order`, and the rest stays as it is.

- [ ] **Step 6: Run the tests (only if Swift is available here)**

Run: `cd ios/BlimpKit && swift test`
Expected: PASS, including the existing `theStripKeepsTheOrderItOpenedWithWhileActivityChanges`, which passes no `shown`. With no Swift here, skip this step. CI runs it in Task 5.

- [ ] **Step 7: Commit**

```bash
git add ios/BlimpKit
git commit -m "iPhone, BlimpKit: a folder on the computer (DirEntry, DirListing from GET /fs/list), what the folder browser shows (folders, then files, nothing starting with a dot), New Folder's names (the Mac's words), the path with ~ for home, and a project just opened goes first in the drawer's column, not last"
```

---

### Task 3: The folder browser on the phone

**Files:**
- Modify: `ios/Blimp/Net/API.swift` (after `setHidden`, around line 34)
- Modify: `ios/Blimp/Model/Store.swift` (`serverVersion` at line 28; the `.open` case around line 182)
- Create: `ios/Blimp/Views/FolderBrowserView.swift`
- Modify: `ios/Blimp/Views/HomeView.swift` (state at line 41; the `.sheet` at line 103; after `hideProject`, around line 375)

**Interfaces:**
- Consumes: from Task 1, `POST /folders/opened`. From Task 2, `DirListing`, `DirEntry`, `Folders.shown`, `Folders.nameProblem` and `Folders.label`.
- Produces:
  - `API.list(path:) async throws -> DirListing`
  - `API.makeFolder(path:) async throws`
  - `API.openFolder(dir:) async throws -> [RecentFolder]`
  - `Store.serverHome: String?`
  - `FolderBrowserView(home: String, onOpen: @MainActor (String) async throws -> Void)`
  - `HomeView`'s `@State private var showFolders`. Task 4's + sets it.

- [ ] **Step 1: The API calls**

In `ios/Blimp/Net/API.swift`, after `func setHidden(…)`, add:

```swift
    /// A folder on the computer, inside home: its folders and files.
    func list(path: String) async throws -> DirListing {
        try await decode(call("GET", "/fs/list", query: [URLQueryItem(name: "path", value: path)]))
    }

    /// Makes a folder. One there already: blimpd's "that name is taken".
    func makeFolder(path: String) async throws {
        struct Body: Encodable { let path: String }
        _ = try await call("POST", "/fs/mkdir", body: JSONEncoder().encode(Body(path: path)))
    }

    /// Opens a folder as a project: blimpd shows it again if it was hidden and keeps it in the recent folders, which
    /// it answers with.
    func openFolder(dir: String) async throws -> [RecentFolder] {
        struct Body: Encodable { let dir: String }
        return try await decode(call("POST", "/folders/opened", body: JSONEncoder().encode(Body(dir: dir))))
    }
```

- [ ] **Step 2: The server's home in the Store**

In `ios/Blimp/Model/Store.swift`, after `private(set) var serverVersion: String?`, add:

```swift
    /// The server's home folder, from /health as serverVersion is: where the folder browser starts. nil until then.
    private(set) var serverHome: String?
```

In `update(_:)`'s `.open` case, replace:

```swift
                self?.serverVersion = health.version
```

with:

```swift
                self?.serverVersion = health.version
                self?.serverHome = health.home
```

- [ ] **Step 3: FolderBrowserView**

Create `ios/Blimp/Views/FolderBrowserView.swift`:

```swift
// + in the drawer: the computer's folders from home down (blimpd's /fs routes reach only inside home), to open one
// as a project. A tap on a folder goes in, back goes up. Each level lists its folders, then its files greyed so you
// can tell where you are, and nothing whose name starts with ".". New Folder makes one here and goes into it; Open
// <name> opens the folder shown (HomeView's openFolder, which closes the sheet). If blimpd refuses, the sheet stays
// and says why.
import BlimpKit
import SwiftUI

struct FolderBrowserView: View {
    let home: String
    /// Opens the folder as a project; throws when blimpd refuses.
    let onOpen: @MainActor (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    /// The folders gone into from home, each a full path.
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            // dismiss is read here, not in a level: a pushed level's dismiss would only go back up.
            FolderLevel(dir: home, home: home, path: $path, onOpen: onOpen, onCancel: { dismiss() })
                .navigationDestination(for: String.self) { dir in
                    FolderLevel(dir: dir, home: home, path: $path, onOpen: onOpen, onCancel: { dismiss() })
                }
        }
    }
}

/// One folder: its folders (a tap goes in), its files greyed, and the bar with New Folder and Open.
private struct FolderLevel: View {
    let dir: String
    let home: String
    @Binding var path: [String]
    let onOpen: @MainActor (String) async throws -> Void
    let onCancel: () -> Void
    @Environment(Store.self) private var store
    @State private var listing: DirListing?
    @State private var failure: String?
    @State private var naming = false
    @State private var newName = ""
    @State private var opening = false
    /// Why New Folder or Open didn't work, in an alert.
    @State private var problem: String?

    private var name: String { dir == "/" ? "/" : (dir as NSString).lastPathComponent }

    var body: some View {
        List {
            if let listing {
                let shown = Folders.shown(listing.entries)
                if shown.folders.isEmpty {
                    Text("No folders here.").foregroundStyle(.secondary).accessibilityIdentifier("folderBrowserEmpty")
                }
                ForEach(shown.folders) { f in
                    NavigationLink(value: (dir as NSString).appendingPathComponent(f.name)) {
                        Label(f.name, systemImage: "folder")
                    }
                    .accessibilityIdentifier("folder-" + f.name)
                }
                ForEach(shown.files) { f in
                    Label(f.name, systemImage: "doc").foregroundStyle(.tertiary)
                }
            } else if let failure {
                Text(failure).foregroundStyle(.red)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(name).font(.headline).lineLimit(1)
                    Text(Folders.label(path: dir, home: home)).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.head)
                }
            }
            // At the right on every level: the back button takes the left.
            ToolbarItem(placement: .topBarTrailing) { Button("Cancel", action: onCancel) }
            ToolbarItemGroup(placement: .bottomBar) {
                Button("New Folder", systemImage: "folder.badge.plus") {
                    newName = ""
                    naming = true
                }
                .labelStyle(.titleAndIcon)
                .accessibilityIdentifier("folderBrowserNewFolder")
                Spacer()
                Button { open() } label: { Text("Open \(name)").lineLimit(1) }
                    .buttonStyle(.borderedProminent)
                    .disabled(opening)
                    .accessibilityIdentifier("folderBrowserOpen")
            }
        }
        .alert("New Folder", isPresented: $naming) {
            TextField("Name", text: $newName)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("folderBrowserName")
            Button("Cancel", role: .cancel) {}
            Button("Make") { make() }
        } message: {
            Text("In \(Folders.label(path: dir, home: home))")
        }
        .plainAlert("Couldn't do that", message: $problem)
        // Again each time it shows, as a folder made in it while deeper changes it.
        .task(id: dir) { await load() }
    }

    private func load() async {
        guard let api = store.api else { return }
        do {
            listing = try await api.list(path: dir)
            failure = nil
        } catch {
            failure = Store.words(for: error)
        }
    }

    /// New Folder's Make: the folder is made here and the browser goes into it.
    private func make() {
        let n = newName.trimmingCharacters(in: .whitespaces)
        if n.isEmpty { return }
        if let p = Folders.nameProblem(n) {
            problem = p
            return
        }
        let target = (dir as NSString).appendingPathComponent(n)
        Task {
            guard let api = store.api else { return }
            do {
                try await api.makeFolder(path: target)
                path.append(target)
            } catch APIError.server(let message) where message == "that name is taken" {
                // blimpd's makeDir answers 409 with these words
                problem = "\(n) already exists."
            } catch {
                problem = Store.words(for: error)
            }
        }
    }

    private func open() {
        opening = true
        Task {
            defer { opening = false }
            do { try await onOpen(dir) } catch { problem = Store.words(for: error) }
        }
    }
}
```

- [ ] **Step 4: HomeView's sheet and openFolder**

In `ios/Blimp/Views/HomeView.swift`, after `@State private var showSettings = false`, add:

```swift
    /// The drawer's +: the folder browser (FolderBrowserView), over the drawer.
    @State private var showFolders = false
```

After `.sheet(isPresented: $showSettings) { SettingsView() }`, add:

```swift
        .sheet(isPresented: $showFolders) {
            if let home = store.serverHome {
                FolderBrowserView(home: home, onOpen: openFolder)
            } else {
                ContentUnavailableView("Can't reach the server", systemImage: "wifi.slash")
            }
        }
```

After the `hideProject(_:)` function, add:

```swift
    /// Open in the folder browser. blimpd shows the folder again if it was hidden and keeps it in the recent folders,
    /// so it stays in the column before Claude has run there. It then shows as if its icon was tapped: its inbox
    /// behind the drawer, which stays open, and first in the column (Strip.held). If blimpd refuses, this throws and
    /// the browser stays and says why.
    private func openFolder(_ dir: String) async throws {
        guard let api = store.api else { throw APIError.offline }
        folders = try await api.openFolder(dir: dir)
        hidden.remove(dir)
        showFolders = false
        pickProject(dir)
    }
```

- [ ] **Step 5: Check that nothing else is missing**

Run: `grep -n "serverHome\|showFolders\|openFolder" ios/Blimp/Views/HomeView.swift ios/Blimp/Model/Store.swift ios/Blimp/Net/API.swift`
Expected: the declarations and uses above, and no others. Nothing sets `showFolders = true` yet. Task 4 does that.

- [ ] **Step 6: Commit**

```bash
git add ios/Blimp/Net/API.swift ios/Blimp/Model/Store.swift ios/Blimp/Views/FolderBrowserView.swift ios/Blimp/Views/HomeView.swift
git commit -m "iPhone: the folder browser, a sheet from home down on the computer (folders, then files greyed, nothing starting with a dot), with New Folder (it goes into the new one; a / or . or .. name, or one taken, says why) and Open <name>, which opens the folder as a project through POST /folders/opened, shows it again if hidden, and leaves the sheet with why if blimpd refuses; the Store keeps the server's home from /health"
```

---

### Task 4: The drawer's column, + and Settings at its foot, New session above Active, and the UI test

**Files:**
- Modify: `ios/Blimp/Views/DrawerView.swift` (most of the file)
- Modify: `ios/Blimp/Views/HomeView.swift` (the header comment at lines 1-2; the `DrawerView(…)` call at line 95)
- Modify: `ios/BlimpUITests/BlimpUITests.swift` (the new test after `testSwitchProjectFromTheStrip`, around line 542; the new helper after `closeDrawer`, around line 620)
- Modify: `ios/e2e/setup.ts` (line 28 import; a new line near line 156)
- Modify: `.github/workflows/ios.yml` (shard lists at lines 99 and 102)
- Modify: `ios/README.md` (line 7)
- Modify: `docs/PHONE-CHECKLIST.md` (lines 52-56)

**Interfaces:**
- Consumes: from Task 2, `Strip.held(_:order:shown:)`. From Task 3, `HomeView`'s `showFolders`.
- Produces: `DrawerView`'s new parameter `onOpenFolder: () -> Void`, declared right after `onHide`.

- [ ] **Step 1: Write the failing UI test**

In `ios/e2e/setup.ts`, change the path import from `import { dirname, join } from "node:path";` to:

```ts
import { dirname, join, relative } from "node:path";
```

and after the line `writeFileSync(join(root, "quiz.in"), "");`, add:

```ts
// testOpenFolder's browser goes from home to the work folder one folder at a time, by these steps.
writeFileSync(join(root, "work-under-home"), relative(realpathSync(process.env.HOME!), realpathSync(work)));
```

In `ios/BlimpUITests/BlimpUITests.swift`, after `testSwitchProjectFromTheStrip()`, add:

```swift
    /// + at the foot of the drawer's column: the folder browser opens at home, and goes through to the job's work
    /// folder. New Folder makes a folder and goes into it, and Open shows it as a project, first in the column.
    /// Hidden, it comes back when opened again.
    func testOpenFolder() throws {
        try launchPaired()
        let steps = hostFile("work-under-home").split(separator: "/").map(String.init)
        if steps.isEmpty || steps.first == ".." { throw failed("setup.ts to write the work folder's path under home") }
        let name = "opened-\(Int(Date().timeIntervalSince1970))"

        try openDrawer()
        try browse(to: steps)
        let newFolder = element("folderBrowserNewFolder")
        try wait(newFolder, "New Folder")
        newFolder.tap()
        let field = element("folderBrowserName")
        try wait(field, "the new folder's name")
        try type(name, into: field)
        app.alerts.buttons["Make"].tap()
        try wait(element("folderBrowserEmpty"), "the browser in the new folder")
        shot("40-folder-browser")
        element("folderBrowserOpen").tap()
        try until(element("folderBrowserOpen"), "exists == false", "the browser to close on Open")
        try until(element("drawerProject"), "label == '\(name)'", "the drawer to show \(name)")
        try wait(element("strip-" + name), "\(name) in the column")
        shot("41-opened-folder")

        // Hide it, then open it again from the browser: it's back.
        element("strip-" + name).press(forDuration: 1.2)
        let hide = app.buttons["Hide \(name)"]
        try wait(hide, "Hide in the icon's menu")
        hide.tap()
        try until(element("strip-" + name), "exists == false", "\(name) to leave the column")
        try browse(to: steps + [name])
        element("folderBrowserOpen").tap()
        try wait(element("strip-" + name), "\(name) back in the column")
    }
```

After the `closeDrawer()` helper, add:

```swift
    /// Opens the folder browser from the open drawer's + and goes into each folder of `steps`, from home.
    private func browse(to steps: [String]) throws {
        let plus = element("drawerOpenFolder")
        try wait(plus, "+ at the foot of the drawer's column")
        plus.tap()
        for step in steps {
            let row = element("folder-" + step)
            // The list is lazy: a row below the screen isn't there until it's scrolled to.
            if !row.waitForExistence(timeout: 5) {
                for _ in 0..<15 where !row.exists { app.swipeUp() }
            }
            try wait(row, "\(step) in the folder browser", timeout: 10)
            row.tap()
        }
    }
```

In `.github/workflows/ios.yml`, add `testOpenFolder` to shard b's layout tests in both branches. Line 99 ends with `"testNewSessionFromTheDrawer testSwitchProjectFromTheStrip testServerBrowserTab"`, and that becomes `"testNewSessionFromTheDrawer testSwitchProjectFromTheStrip testOpenFolder testServerBrowserTab"`. Line 102 ends with `"testNewSessionFromTheDrawer testSwitchProjectFromTheStrip"`, and that becomes `"testNewSessionFromTheDrawer testSwitchProjectFromTheStrip testOpenFolder"`. (The workflow checks that every UI test is in a shard. A test that isn't would never run.)

This test fails until Step 2: `drawerOpenFolder` doesn't exist. It runs in CI (Task 5).

- [ ] **Step 2: Rework DrawerView**

In `ios/Blimp/Views/DrawerView.swift`:

(a) Replace the header comment (lines 1-10) with:

```swift
// The drawer from the left. Down its left side, the projects in a column: two letters each, with the mark of the
// session there that needs you most. A tap shows that project's inbox behind the drawer and its sessions in it, and
// the drawer stays open; press and hold one to hide it. At the column's foot, + (open a folder on the computer as a
// project, FolderBrowserView) and Settings. Beside it the project's name, New session (the inbox's box, ready to
// type into), its running sessions, the project's browser tabs (a dot on ones a session opened; a tap opens one full
// screen, New Tab opens one, a swipe right closes one), then its past conversations folded under Earlier (each newest
// activity first, with its mark, and under its title its branch, jobs and handoff). A tap opens one; a swipe right on
// a row or press and hold has its actions (Stop, Mark read, End; Resume a past one). It follows the finger: a swipe
// right in the chat pulls it out (HomeView's `pull`), a swipe left anywhere on it or beside it pushes it back, and
// letting go settles it open or closed by where it is and how fast it went. A tap beside it closes it too.
```

(b) After `let onHide: (String) -> Void`, add:

```swift
    /// Opens the folder browser (+ at the column's foot, or the button when there's no project yet).
    let onOpenFolder: () -> Void
```

(c) Delete the `stripFrame` state, both the doc comment and the line:

```swift
    /// Where the project row is on screen, so a sideways swipe that starts in it scrolls it instead of closing
    /// the drawer. Not observed: it changes on every step of a swipe, and only a swipe's start reads it.
    @State private var stripFrame = StripFrame()
```

(d) In `closing(width:)`, replace:

```swift
                    sideways = abs(v.translation.width) > abs(v.translation.height) && !stripFrame.rect.contains(v.startLocation)
```

with:

```swift
                    sideways = abs(v.translation.width) > abs(v.translation.height)
```

(e) Replace the whole `panel`, `strip` and `header` properties (from `private var panel: some View {` through the end of `header`, but **not** `stripIcon` or `label`, which stay as they are) with:

```swift
    private var panel: some View {
        HStack(spacing: 0) {
            strip
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                header.padding(.horizontal).padding(.top, 12).padding(.bottom, 8)
                if dir == nil {
                    empty
                } else {
                    newSession.padding(.horizontal).padding(.bottom, 8)
                    list
                }
            }
        }
        .onAppear { order = projects.map(\.dir) }
        .accessibilityAddTraits(.isModal)
    }

    private var list: some View {
        List {
            if rows.isEmpty {
                Text("No sessions here yet.").foregroundStyle(.secondary).listRowSeparator(.hidden)
            }
            if !active.isEmpty {
                Section("Active") { ForEach(active) { rowButton($0) } }
            }
            Section("Browser") {
                ForEach(tabs) { tabRow($0) }
                Button(action: onNewTab) {
                    Label("New Tab", systemImage: "plus").frame(maxWidth: .infinity, alignment: .leading)
                }
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("drawerNewTab")
            }
            if !past.isEmpty {
                Section {
                    // A row, not the section's header: a header doesn't reliably take taps.
                    Button { earlierOpen.toggle() } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(earlierOpen ? 90 : 0))
                            Text("Earlier")
                            Text("\(past.count)").foregroundStyle(.tertiary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .foregroundStyle(.secondary)
                    .listRowSeparator(.hidden)
                    .accessibilityLabel(earlierOpen ? "Earlier, \(past.count), open" : "Earlier, \(past.count), folded")
                    .accessibilityIdentifier("drawerEarlier")
                    if earlierOpen { ForEach(past) { rowButton($0) } }
                }
            }
        }
        .listStyle(.plain)
    }

    /// The projects in a column down the drawer's left side, two letters each with their mark, the one shown lit; the
    /// column scrolls when they don't all fit. Its foot, always in sight: + (open a folder) and Settings.
    private var strip: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(Strip.held(projects, order: order, shown: dir)) { stripIcon($0) }
                }
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            Button(action: onOpenFolder) {
                Image(systemName: "plus")
                    .font(.title3.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])))
            }
            .foregroundStyle(.secondary)
            .accessibilityLabel("Open a folder")
            .accessibilityIdentifier("drawerOpenFolder")
            .padding(.vertical, 8)
            Button(action: onSettings) {
                Image(systemName: "gearshape").font(.title3).frame(width: 44, height: 44)
            }
            .foregroundStyle(.secondary)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("settingsButton")
            .padding(.bottom, 8)
        }
        .frame(width: 60)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("drawerStrip")
    }

    /// The project's name.
    private var header: some View {
        Text(dir.map(Drawer.name(of:)) ?? "Projects")
            .font(.title3.bold())
            .lineLimit(1)
            .accessibilityIdentifier("drawerProject")
    }

    /// New session: the project's inbox, its box ready to type into.
    private var newSession: some View {
        Button(action: onNewSession) {
            Label("New session", systemImage: "plus")
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        }
        .accessibilityIdentifier("drawerNewSession")
    }

    /// No project yet (a fresh blimpd): where to start.
    private var empty: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Open a folder on the computer to start.").foregroundStyle(.secondary)
            Button("Open a Folder", systemImage: "folder.badge.plus", action: onOpenFolder)
                .buttonStyle(.borderedProminent)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
```

(f) Delete the `StripFrame` class at the bottom of the file, with its doc comment:

```swift
/// Where the drawer's project row is on screen (DrawerView's closing swipe).
@MainActor
final class StripFrame {
    var rect: CGRect = .zero
}
```

(g) Check:

Run: `grep -rn "StripFrame\|stripFrame\|onGeometryChange" ios/Blimp`
Expected: no output.

- [ ] **Step 3: Wire + in HomeView**

In `ios/Blimp/Views/HomeView.swift`, change the start of the `DrawerView(…)` call. Old:

```swift
            DrawerView(open: $drawer, pull: pull, dir: store.dir, projects: projects, onProject: pickProject, onHide: hideProject,
```

New:

```swift
            DrawerView(open: $drawer, pull: pull, dir: store.dir, projects: projects, onProject: pickProject, onHide: hideProject,
                       onOpenFolder: { showFolders = true },
```

In the file's header comment, change `with the project strip, New session and the project's sessions` to `with the projects' column (+ at its foot opens a folder on the computer), New session and the project's sessions`.

- [ ] **Step 4: Docs**

In `ios/README.md`, replace line 7 with the paragraph below. Everything from "In a chat, ‹ and the project's name" to the end is the old line's text, unchanged:

```
The drawer on the left (swipe right, or ☰ at the top left of a project's inbox) has a column of your projects down its left side: two letters each, with an amber question mark on one where a session asks you something and a blue dot on one with a new reply. Tap one: its inbox shows, and the drawer stays open with its sessions. Press and hold one and pick Hide to take it off the column (and off the Mac's recent folders); starting a session in that folder from the Mac brings it back. Hide needs a blimpd newer than 0.3.5. At the column's foot are + and Settings. + shows the computer's folders, from your home folder: tap a folder to go in, New Folder makes one, and Open makes the folder you're in a project, first in the column, even one you hid. Open needs a blimpd newer than 0.3.10. Folders in /tmp aren't offered as recent projects unless you opened them. Beside the column are the project's name, New session (which opens the inbox's box ready to type into), and the project's sessions. Opening the drawer hides the keyboard. In a chat, ‹ and the project's name at the top left go back to its inbox. The inbox lists what needs you in that project at the top. Another project's sessions are in its own inbox; a banner still tells you when one starts waiting. You can answer a permission or a simple question right there, without opening the chat. Swipe a row to stop, end or mark it read. Press and hold a row to continue it in a new session. Each row shows its branch and background jobs.
```

In `docs/PHONE-CHECKLIST.md`, replace lines 52-56 (from `- [ ] New session in the drawer.` through `- [ ] No scratch folders. …`) with:

```
- [ ] New session in the drawer. In a chat, open the drawer: New session, a wide button under the project's name. Tap it: the drawer closes, the project's inbox shows, and its box has the keyboard up, ready to type. Nothing starts until you send (the Mac lists no new session). The same from the inbox.
- [ ] The project column. Open the drawer: down its left side, an icon per project, two letters from its folder's name, newest activity first, in a column that scrolls up and down when they don't all fit. One where a session asks you something has an amber question mark; one with a new reply, a blue dot. Tap one: the drawer stays open with that project's sessions, its icon lit, and the inbox behind it is that project's. While the drawer is open, the icons don't move, even when another project gets newer activity.
- [ ] The drawer. Swipe right anywhere, in a chat too, or tap ☰ on the inbox: the project column on the left, and beside it the project's name, New session, the running sessions under Active, the Browser tabs, the past ones under Earlier, folded until you tap it (it stays as you left it). The newest activity on top in each. A swipe left, on the column too, or a tap beside it closes it. + and Settings (the gear) are at the column's foot.
- [ ] Hide a project. Press and hold a project's icon in the drawer's column and pick Hide: it leaves the column at once, even with a session running there. On the Mac, ⌘O: it isn't under the recent folders either. Hide the project on screen: the next one's inbox shows. On the Mac, start a session in that folder (type its path in Open Folder): open the phone's drawer again and it's back.
- [ ] Open a folder. In the drawer, tap + at the column's foot: your home folder on the computer, its folders A to Z, then its files greyed, nothing starting with a dot. Tap folders to go in, swipe back to go up. New Folder: type a name, and it's made and you're in it. A name with / in it, or one that's taken, says why. Open <name>: the sheet goes, and the drawer shows that project, its icon first in the column. Close and open the drawer again: it's still there, before any session ran in it. On the Mac, ⌘O: it's under the recent folders. Hide it, then open it again with +: it's back.
- [ ] No scratch folders. A folder in /tmp where Claude ran (a helper agent's scratchpad) shows neither in the drawer's column nor in the Mac's recent folders, unless you opened it with +.
```

- [ ] **Step 5: Look over the drawer's callers and the tests that use its ids**

Run: `grep -n "DrawerView(" ios/Blimp -r`
Expected: one call, in HomeView, now with `onOpenFolder:`.

Run: `grep -n "drawerStrip\|drawerNewSession\|settingsButton\|strip-" ios/BlimpUITests/BlimpUITests.swift`
Expected: the same ids as before. No test taps a + beside the project's name: `testNewSessionFromTheDrawer` (around line 470) uses `drawerNewSession`, which is now the wide button.

- [ ] **Step 6: Commit**

```bash
git add ios/Blimp/Views/DrawerView.swift ios/Blimp/Views/HomeView.swift ios/BlimpUITests/BlimpUITests.swift ios/e2e/setup.ts .github/workflows/ios.yml ios/README.md docs/PHONE-CHECKLIST.md
git commit -m "iPhone: the drawer's projects are a column down its left side again, with + (open a folder on the computer) and Settings at its foot, always in sight; New session is a wide button under the project's name, above Active; a sideways swipe on the column closes the drawer too; with no project yet it says to open a folder; testOpenFolder makes a folder from the browser, opens it, hides it and opens it again"
```

---

### Task 5: Verify in CI

**Files:** none (fixes go back into the task they belong to).

- [ ] **Step 1: Server suite, once more**

Run: `bun test`
Expected: PASS.

- [ ] **Step 2: Ask Max before pushing**

Pushing the branch starts the iOS workflow, which runs on the MacBook's runners. Ask Max with one line, for example: "ok to push phone-open-folder? it starts the iOS CI on the MacBook". Wait for a yes.

- [ ] **Step 3: Push and watch the push run**

Run: `git push -u origin phone-open-folder`

The push run builds BlimpKit (Linux and macOS), builds the app for the simulator, and runs the core e2e tests. Watch it in the background: start `gh run watch "$(gh run list --branch phone-open-folder --workflow iOS --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status` with `run_in_background`, and report when it finishes. Don't poll in the foreground. Swift compile errors show up here. Fix each one in the file it belongs to, commit with a message that says what was wrong, and push again.

- [ ] **Step 4: The layout tests, testOpenFolder among them**

Before starting, check that main's push iOS run isn't going: `gh run list --workflow iOS --branch main --limit 3`. If one is in progress, wait for it in the background.

Run: `gh workflow run iOS --ref phone-open-folder -f layout=true -f testflight=false`

Watch it in the background as in Step 3. Expected: every shard is green, including `testOpenFolder`, `testNewSessionFromTheDrawer`, `testSwitchProjectFromTheStrip` and `test9DrawerFromASwipe`. Look at screenshots `40-folder-browser` and `41-opened-folder` in the `iphone-e2e-b` artifact, and check that the column, +, the gear and the New session button look like the spec's drawer.

- [ ] **Step 5: Report to Max**

Lead with the result: green, or what failed and why. Then name the screenshots, and say that the phone checklist items "The project column", "The drawer" and "Open a folder" need a pass on the real phone.
