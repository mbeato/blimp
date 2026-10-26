# Assistant, part 3 (the apps) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both apps show the assistant: the phone pins its icon at the top of the drawer's strip and puts a jobs bar on
top of its chat; the Mac pins an Assistant group at the top of every session list; both Settings get an Assistant
switch; blimpd serves `GET`/`PUT /assistant`, says on the events socket whether it's on, and never lists the
assistant's folder as a recent folder.

**Architecture:** blimpd gets one switch function (`setAssistantOn`, shared by `blimpd assistant on | off` and
`PUT /assistant`), an events message (`{ type: "assistant", on }`, on connect and from a 1 s check), and a `recent()`
helper that hides the assistant's folder. The jobs' rules (bucket, order, words, the counts line) are written twice, as
the inbox's are: TypeScript in `app/src/lib/assistant.ts` and Swift in BlimpKit's `AssistantJobs.swift`, with the same
test cases. The phone's views (`DrawerView`, `HomeView`, a new `JobsBar`, `SettingsView`) and the Mac's
(`AssistantGroup`, `TerminalPane`, `App`, `SettingsDialog`) read `Session.assistant`, `Session.job` and the switch.

**Tech Stack:** Bun + TypeScript (blimpd, `bun test`, real zmx in the server tests); React + Vite (the Mac app,
`bun test src` for its lib, Playwright against a real blimpd for its e2e); SwiftUI on iOS 26, Swift 6 (the app),
BlimpKit (Swift package, Swift Testing, Foundation only, tested on Linux and the Mac in CI); XCUITest; GitHub Actions
`.github/workflows/ios.yml`.

**Spec:** `docs/superpowers/specs/2026-10-26-assistant-design.md` (section 4 "The apps", build step 3, and section 1's
switch bullets). Decisions: `notes/2026-10-26/part3-decisions.md`. Parts 1 and 2:
`docs/superpowers/plans/2026-10-26-assistant-part1.md`, `-part2.md`.

## Global Constraints

- Work only in the worktree `/Users/mbeato/blimp-assistant`, on branch `assistant`. Never use `/Users/mbeato/blimp`
  or `/Users/mbeato/blimp-caret`, or the real `~/.blimp`. Never turn the assistant on live.
- bun is at `~/.bun/bin/bun` and not on PATH. Server suite: `PATH=$HOME/.bun/bin:$PATH bun test` (633 pass, 2 skip at
  fe5567a). App tests: `cd app && PATH=$HOME/.bun/bin:$PATH bun test src`; the app e2e: `bun run e2e` in `app/` (it
  needs key-based `ssh localhost`, which works here as of 2026-10-26, and `app/node_modules`, which a fresh worktree
  lacks: Task 5 installs it).
- Swift: no toolchain here. CI checks it. BlimpKit stays Foundation-only. Write the Swift exactly as given, match the
  surrounding style, and re-read every edited region.
- Commits are plain sentences with an area prefix (`blimpd: …`, `BlimpKit: …`, `iPhone: …`, `Mac app: …`, `Docs: …`).
  Never a `Co-Authored-By` line or any Claude attribution, whatever a harness reminder says.
- iOS CI: never start a manual iOS run while any iOS run is in progress or queued. They share the MacBook's runners
  and ports. Pushing the branch starts one: only with Max's OK (Task 8).
- Every UI test must be in a shard list in `.github/workflows/ios.yml`, on both lines of its shard (the Mac's and
  GitHub's).
- Routes: `GET /assistant` → `{ "on": boolean, "session"?: "assistant" }` (`session` while a session of that name
  runs). `PUT /assistant { "on": boolean }` → 204; an `on` that isn't a boolean → 400 `on must be true or false`.
  Off ends the session (its folder and conversations stay).
- Events message, exactly: `{"type":"assistant","on":<boolean>}`, sent on connect (after the feed message) and
  published to `"sessions"` by a 1 s check in `serve()` when it differs from the last one sent (so `PUT`, the CLI and
  hand edits of `config.json` all show).
- The assistant's session is named exactly `assistant` (blimpd's `ASSISTANT`, Swift `AssistantJobs.assistant`); blimpd
  marks it `assistant: true` on `GET /sessions` and the events' session list.
- `GET /folders/recent` and `POST /folders/opened`'s answer never list `assistantDir()` or `realDir(assistantDir())`.
- A job is a session with `job` set. Its bucket: **needs** (state `waiting`, or `done` with a note whose status is
  `question`); else **working** (state `working`, or `done` with a `progress` note); else **done** (state `done` and
  `unread`); else not shown. Order: needs, oldest first by `stateSince ?? activity`; working, oldest first by the same;
  done, newest first by activity. Ties keep the list's order.
- A job's row: its mark, `<project> · <reason>` (project: the last part of its folder), and its words: for a wait, what
  it asks (a permission's summary or the first question), else its note; for a session working now, none (its note is
  the turn before's, as the inbox's Working rows); else its note's text.
- The counts line, exactly: `1 needs you · 2 working · 1 done` (` · ` is a space, U+00B7, a space), in that order,
  empty buckets left out. No job to show: no line (TypeScript `""`, Swift `nil`), no phone bar.
- iPhone ids: `assistantIcon` (the strip's icon), `jobsBar` (the bar's fold button), `job-<session name>` (a row),
  `assistantSwitch` (Settings). The back arrow keeps `inboxBack`; from a job it reads "Assistant" and its label is
  "Back to Assistant".
- Mac: `section.assistant` (the group, `aria-label="Assistant"`), `.assistant-line[data-session="<name>"]` (its rows),
  `.assistant-job` (a job's row), localStorage `blimp.assistantOpen` (`"open"` / `"closed"`, open by default, read and
  written in try/catch), Settings checkbox `aria-label="Assistant"`, inline question `.settings-confirm`.
- Words: phone Settings footer "One Claude chat that isn't a project. It can look at every project and asks before it
  acts."; phone question "Turn off the assistant? Its chat ends; its folder and conversations stay." with a destructive
  "Turn Off" and "Cancel"; Mac question "Turn off the assistant? Its chat ends." with a danger "Turn Off" and "Cancel";
  Mac note: the phone's footer text.

## Deviations from the decisions

- **File names.** `app/src/lib/jobs.ts` and `jobs.test.ts` already exist (Claude's background jobs: `jobsWords`,
  `JobWatcher`), so the jobs bar's rules go in `app/src/lib/assistant.ts` and `assistant.test.ts`. BlimpKit has
  `Job` and `JobsText.swift` for the same background jobs, so its file is `AssistantJobs.swift` (with
  `AssistantJobsTests.swift`), not `Jobs.swift`.
- **No GET client and no BlimpKit response model.** `PUT /assistant` answers 204 with no body, and both apps learn the
  switch from the events message, so `Api.assistant()` (GET) and a BlimpKit response type would have no reader. The
  phone's PUT body is a local `Encodable` struct, as every other call in `API.swift` has. blimpd still serves
  `GET /assistant`.
- **The Mac's open path.** There is no `focusSession` for a session this window can show: `focusSession` only brings
  another window forward. Both a notification click (`onSelectSession` → `open`) and ⌘K (`pickSession`) end in
  `open(server, dir, session)`, which calls `rememberProject`. The group reuses `pickSession(l, name)`, and `open` skips
  `rememberProject` when the session is the assistant. So the assistant opens in a tab of its own folder, which is
  never remembered as a recent project.
- **Words on a job working now:** none, as the inbox's Working rows have, since its note is about the turn before. A
  job done with a `progress` note shows that note.
- **The back arrow's identifier** stays `inboxBack` from a job too (its label says Assistant): the UI tests'
  `homeButton()` finds the top-left button by `drawerButton` or `inboxBack`.
- **DESIGN.md's Assistant section** doesn't say "step 3" anywhere; Task 7 adds the switch to its first paragraph
  instead.
- **SECURITY.md** isn't in the decisions' docs list, but the spec's "Done when" 5 asks for the new routes there: the
  phone token's list of powers gains "turn the assistant on or off".
- **An older blimpd:** the Mac shows no switch for a server that never sent the assistant message (`assistantOn` is
  `null`); the phone keeps `assistantOn = false` as decided, so on an older blimpd its switch fails with blimpd's "not
  found" in the alert.

## File map

- blimpd: modify `src/assistant.ts` (`setAssistantOn`), `src/events.ts` (`assistantMessage`), `src/server.ts` (routes,
  `recent()`, the 1 s check). Test: `test/server.test.ts`.
- BlimpKit: modify `Models.swift` (`AssistantJob`, `Session.assistant`, `Session.job`, `EventsMessage.assistant`),
  `Home.swift` (`Drawer.projects`); create `AssistantJobs.swift`. Tests: create `AssistantJobsTests.swift`; modify
  `SessionFieldsTests.swift`, `ModelsTests.swift`, `HomeTests.swift`.
- iPhone app: modify `ios/Blimp/Net/API.swift`, `ios/Blimp/Model/Store.swift`, `ios/Blimp/Views/DrawerView.swift`,
  `ios/Blimp/Views/HomeView.swift`, `ios/Blimp/Views/SettingsView.swift`; create `ios/Blimp/Views/JobsBar.swift`.
- iPhone e2e: modify `ios/e2e/setup.ts`, `ios/BlimpUITests/BlimpUITests.swift`, `.github/workflows/ios.yml`.
- Mac lib: modify `app/src/lib/api.ts`, `app/src/lib/events.ts`, `app/src/lib/connection.ts`,
  `app/src/lib/connection.test.ts`; create `app/src/lib/assistant.ts`, `app/src/lib/assistant.test.ts`.
- Mac UI: create `app/src/components/AssistantGroup.tsx`, `app/e2e/assistant.spec.ts`; modify
  `app/src/components/TerminalPane.tsx`, `app/src/App.tsx`, `app/src/components/SettingsDialog.tsx`,
  `app/src/styles/app.css`.
- Docs: `docs/DESIGN.md`, `docs/SECURITY.md`, `README.md`, `ios/README.md`, `docs/PHONE-CHECKLIST.md`, the spec's status.

---

### Task 1: blimpd: `GET`/`PUT /assistant`, the events message, and the assistant's folder out of the recent folders

**Files:**
- Modify: `src/assistant.ts` (a new `setAssistantOn` above `runAssistant`; `runAssistant`'s `on` and `off`)
- Modify: `src/events.ts` (header comment; import; `assistantMessage` after `browserMessage`; `openEvents`)
- Modify: `src/server.ts` (imports; `recent()` above `route`; routes after `POST /assistant/jobs`; `/folders/recent`
  and `/folders/opened`; a 1 s check in `serve()`)
- Test: `test/server.test.ts` (an import; two tests at the end of `describe("assistant")`)

**Interfaces:**
- Consumes: `saveConfig` (src/names.ts); `sessionExists`, `killSession`, `realDir` (src/sessions.ts, already imported in
  assistant.ts and server.ts); `ASSISTANT`, `assistantDir`, `assistantOn` (src/assistant.ts); `recentFolders`,
  `tempRoots` (src/folders.ts); `readHidden` (src/hidden.ts); `readOpened`, `addOpened` (src/opened.ts); `HttpError`.
- Produces:
  - `setAssistantOn(on: boolean): Promise<void>` (src/assistant.ts)
  - `assistantMessage(): string` (src/events.ts), `{"type":"assistant","on":boolean}`
  - `GET /assistant` → `{ on: boolean, session?: "assistant" }`; `PUT /assistant { on: boolean }` → 204, 400 otherwise
  - `GET /folders/recent` and `POST /folders/opened` leave out the assistant's folder

- [ ] **Step 1: Write the failing server tests**

In `test/server.test.ts`, after the line `import { projectFolderName } from "../src/folders";`, add:

```ts
import { addOpened } from "../src/opened";
```

In `describe("assistant", () => {`, after the end of its only test, which ends:

```ts
    expect(await cli(["assistant", "maybe"])).toMatchObject({ code: 1, err: "blimpd assistant: usage: blimpd assistant on | off | status" });
  }, 45000);
```

add (inside the describe, before its closing `});`):

```ts

  test("GET and PUT /assistant: the switch and, while it runs, the session's name; off ends it; the events socket says so on connect and when it changes", async () => {
    made.push("assistant");
    const put = (on: unknown) => api("/assistant", { method: "PUT", body: JSON.stringify({ on }) });
    const e = await socket("/events");
    const told = () => e.messages.filter((m) => m.type === "assistant").map((m) => m.on);
    try {
      await until(() => told().length === 1, "the assistant message on connect");
      expect(told()).toEqual([false]);
      expect(await (await api("/assistant")).json()).toEqual({ on: false });
      for (const bad of ["yes", 1, null]) expect((await put(bad)).status).toBe(400);
      expect((await api("/assistant", { method: "PUT", body: "{}" })).status).toBe(400);

      expect((await put(true)).status).toBe(204);
      expect(JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"))).toMatchObject({ names: false, assistant: true });
      await until(() => told().at(-1) === true, "the assistant message saying it's on", 3000);
      await until(async () => (await (await api("/assistant")).json()).session === "assistant", "GET /assistant to name the session", 15000);
      expect(await (await api("/assistant")).json()).toEqual({ on: true, session: "assistant" });

      expect((await put(false)).status).toBe(204);
      expect(zmxNames()).not.toContain("assistant");
      expect(await (await api("/assistant")).json()).toEqual({ on: false });
      await until(() => told().at(-1) === false, "the assistant message saying it's off", 3000);
      expect(told()).toEqual([false, true, false]);
    } finally {
      e.ws.close();
      await put(false);
    }
  }, 30000);

  test("the assistant's folder is never one of the recent folders, even when it was opened as one", async () => {
    mkdirSync(dir, { recursive: true });
    // An opened folder skips the temp-folder check that a transcript's folder gets, so this one would show.
    addOpened(dir, Date.now(), join(tmp, "opened.json"));
    const recent = ((await (await api("/folders/recent")).json()) as { dir: string }[]).map((f) => f.dir);
    expect(recent).not.toContain(dir);
    expect(recent).not.toContain(realpathSync(dir));
  });
```

(`dir` is the describe's `const dir = join(tmp, "assistant")`. The server's fake `claude` on PATH makes `PUT {on:true}`
start a harmless stand-in; the test turns it off again in `finally`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "PUT /assistant|never one of the recent folders"`
Expected: FAIL, 2 tests: "timed out waiting for the assistant message on connect", and `expect(recent).not.toContain(dir)`
(the opened folder is listed).

- [ ] **Step 3: `setAssistantOn` in `src/assistant.ts`**

Above the comment `// blimpd assistant on | off | status. Off ends the session; its folder and conversations stay, and on again`,
add:

```ts
// The switch, for `blimpd assistant on | off` and PUT /assistant: off also ends the session.
export async function setAssistantOn(on: boolean) {
  saveConfig({ assistant: on });
  if (!on && (await sessionExists(ASSISTANT))) await killSession(ASSISTANT);
}

```

In `runAssistant`, replace:

```ts
  if (what === "on") {
    saveConfig({ assistant: true });
```

with:

```ts
  if (what === "on") {
    await setAssistantOn(true);
```

and replace:

```ts
    saveConfig({ assistant: false });
    if (await sessionExists(ASSISTANT)) await killSession(ASSISTANT);
```

with:

```ts
    await setAssistantOn(false);
```

- [ ] **Step 4: The events message in `src/events.ts`**

Replace the header's first two lines:

```ts
// The events socket: the session list whenever it changes, the ports programs in sessions listen on (ports.ts),
// the server browser's tabs (browser/service.ts), the phone feed's switch and unseen count (feed/store.ts), and
```

with:

```ts
// The events socket: the session list whenever it changes, the ports programs in sessions listen on (ports.ts),
// the server browser's tabs (browser/service.ts), the phone feed's switch and unseen count (feed/store.ts), whether
// the assistant is on (assistant.ts), and
```

Before `import { browserTabs } from "./browser/service";`, add:

```ts
import { assistantOn } from "./assistant";
```

After `export const browserMessage = () => JSON.stringify({ type: "browser", tabs: browserTabs() });`, add:

```ts
// The apps' Assistant switch: on connect, and from serve()'s 1 s check when it changes.
export const assistantMessage = () => JSON.stringify({ type: "assistant", on: assistantOn() });
```

In `openEvents`, after `  ws.send(feedMessage());`, add:

```ts
  ws.send(assistantMessage());
```

- [ ] **Step 5: Routes, recent folders and the check in `src/server.ts`**

Replace:

```ts
import { ASSISTANT, startAssistant } from "./assistant";
```

with:

```ts
import { ASSISTANT, assistantDir, assistantOn, setAssistantOn, startAssistant } from "./assistant";
```

Replace:

```ts
import { browserMessage, closeEvents, type EventsData, eventsData, eventsMessage, openEvents } from "./events";
```

with:

```ts
import { assistantMessage, browserMessage, closeEvents, type EventsData, eventsData, eventsMessage, openEvents } from "./events";
```

Above `async function route(req: Request, url: URL, server: Server, phone?: string): Promise<Response | undefined> {`,
add:

```ts
// The recent folders: not the hidden ones, nor the assistant's folder, which isn't a project (by its path and its
// real path: Claude's transcripts can name either).
const recent = () => recentFolders(claudeDir(), tempRoots(), new Set([...readHidden(), assistantDir(), realDir(assistantDir())]), readOpened());

```

After the `POST /assistant/jobs` block, which ends:

```ts
    saveJob(session, words, Date.now());
    return new Response(null, { status: 204 });
  }
```

add:

```ts
  // The assistant's switch, for the apps' Settings: GET says whether it's on, and names its session while one runs;
  // PUT turns it on or off (off ends the session), as `blimpd assistant on | off` does.
  if (path === "/assistant" && get) return Response.json({ on: assistantOn(), ...((await sessionExists(ASSISTANT)) && { session: ASSISTANT }) });
  if (path === "/assistant" && req.method === "PUT") {
    const { on } = ((await req.json()) ?? {}) as Record<string, unknown>;
    if (typeof on !== "boolean") throw new HttpError(400, "on must be true or false");
    await setAssistantOn(on);
    return new Response(null, { status: 204 });
  }
```

Replace:

```ts
  if (path === "/folders/recent" && get) return Response.json(recentFolders(claudeDir(), tempRoots(), new Set(readHidden()), readOpened()));
```

with:

```ts
  if (path === "/folders/recent" && get) return Response.json(recent());
```

In the `/folders/opened` block, replace:

```ts
    addOpened(full);
    return Response.json(recentFolders(claudeDir(), tempRoots(), new Set(readHidden()), readOpened()));
```

with:

```ts
    addOpened(full);
    return Response.json(recent());
```

In `serve()`, after the line `  startAssistant(); // off unless {"assistant": true} in <socket dir>/config.json`, add:

```ts
  // Whether the assistant is on, published when it changes: PUT /assistant, `blimpd assistant on | off`, or
  // config.json edited by hand, each within a second.
  let lastAssistant = assistantMessage();
  setInterval(() => {
    const m = assistantMessage();
    if (m !== lastAssistant) server.publish("sessions", (lastAssistant = m));
  }, 1000);
```

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test test/server.test.ts -t "PUT /assistant|never one of the recent folders|starts a session named assistant|hidden folder|opened from the phone"`
Expected: PASS (the two new tests, part 1's `blimpd assistant` test, and the hidden and opened folders tests).

- [ ] **Step 7: Run the whole server suite**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test`
Expected: 0 fail (2 more pass than before this task).

- [ ] **Step 8: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add src/assistant.ts src/events.ts src/server.ts test/server.test.ts && git commit -m "blimpd: GET and PUT /assistant for the apps' switch (sharing setAssistantOn with blimpd assistant on | off), the events socket's assistant message on connect and within a second of a change, and the assistant's folder never one of the recent folders"
```

---

### Task 2: BlimpKit: the assistant's session and jobs, the events message, the jobs bar's rules, and the strip

**Files:**
- Modify: `ios/BlimpKit/Sources/BlimpKit/Models.swift` (`AssistantJob` after `Job`; `Session`'s fields, `CodingKeys`
  and `init(from:)`; `EventsMessage`)
- Create: `ios/BlimpKit/Sources/BlimpKit/AssistantJobs.swift`
- Modify: `ios/BlimpKit/Sources/BlimpKit/Home.swift` (`Drawer.projects`)
- Test: create `ios/BlimpKit/Tests/BlimpKitTests/AssistantJobsTests.swift`; modify `SessionFieldsTests.swift` (a test at
  the end), `ModelsTests.swift` (a test after `decodesTheSessionsEventAndIgnoresOthers`), `HomeTests.swift` (a test
  after `aHiddenProjectLeavesTheStripEvenWithSessionsRunningThere`)

**Interfaces:**
- Consumes: `Session`, `SessionState`, `Note`, `NoteStatus`, `Prompt`, `RecentFolder`, `Mark`, `Session.mark`,
  `Session.activity`, `Drawer.name(of:)`, `Inbox.asked(_:)` (all in BlimpKit already).
- Produces:
  - `public struct AssistantJob: Codable, Sendable, Equatable { public let reason: String; public let at: Double }`
  - `Session.assistant: Bool?`, `Session.job: AssistantJob?` (both default `nil`, decoded with `try?`)
  - `EventsMessage.assistant(on: Bool)`
  - `public enum JobBucket: String, Equatable, Sendable { case needs, working, done }`
  - `public struct AssistantJobRow: Equatable, Identifiable, Sendable { session: String; project: String; reason: String; bucket: JobBucket; words: String?; mark: Mark; id: String }`
  - `AssistantJobs.assistant: String` (`"assistant"`), `AssistantJobs.rows(_ sessions: [Session]) -> [AssistantJobRow]`,
    `AssistantJobs.counts(_ rows: [AssistantJobRow]) -> String?`
  - `Drawer.projects` leaves out sessions with `assistant == true`, and their folder

Swift is compiled only in CI (Global Constraints). Write exactly this, and re-read it.

- [ ] **Step 1: Write the failing tests**

Create `ios/BlimpKit/Tests/BlimpKitTests/AssistantJobsTests.swift`:

```swift
import Testing
@testable import BlimpKit

// The same cases as the Mac's (app/src/lib/assistant.test.ts).

private func s(_ name: String, dir: String = "/h/web", state: SessionState = .done, since: Double? = nil, updated: Double = 1000,
               unread: Bool? = nil, prompt: Prompt? = nil, note: Note? = nil, job: String? = nil) -> Session {
    var x = Session(name: name, created: 1, dir: dir, kind: "claude", label: nil, sessionId: name + "-id", title: name.uppercased(),
                    updatedAt: updated, state: state, stateSince: since, prompt: prompt, unread: unread)
    x.note = note
    x.job = job.map { AssistantJob(reason: $0, at: 1) }
    return x
}

private func n(_ status: NoteStatus, _ text: String) -> Note { Note(status: status, text: text, at: 1) }

private func lines(_ sessions: [Session]) -> [String] {
    AssistantJobs.rows(sessions).map { "\($0.session) \($0.bucket.rawValue) \($0.project) · \($0.reason): \($0.words ?? "")" }
}

@Test func eachJobIsInOneBucketNeedsYouWorkingOrDoneAndTheRestArentShown() {
    let permission = Prompt(kind: .permission, at: 1, answerable: true, tool: "Bash", summary: "Ran `bun test`", options: ["Yes", "No"], questions: nil)
    #expect(lines([
        s("wait", dir: "/h/api", state: .waiting, since: 3000, updated: 3000, prompt: permission, job: "run the tests"),
        s("ask", since: 1000, updated: 1000, note: n(.question, "ship v0.2.16?"), job: "ship it"),
        s("work", state: .working, since: 2000, updated: 2500, note: n(.done, "an earlier turn"), job: "fix CI"),
        s("prog", since: 1500, updated: 1500, unread: true, note: n(.progress, "half the pages done"), job: "the docs"),
        s("fin", updated: 4000, unread: true, note: n(.done, "released v0.2.16"), job: "release"),
        s("fin2", updated: 6000, unread: true, job: "tidy"),
        s("read", updated: 7000, unread: false, note: n(.done, "read already"), job: "old"),
        s("plain", state: .waiting, updated: 500),
        s("idle", state: .unknown, updated: 8000, job: "shell"),
    ]) == [
        "ask needs web · ship it: ship v0.2.16?",
        "wait needs api · run the tests: Ran `bun test`",
        "prog working web · the docs: half the pages done",
        "work working web · fix CI: ",
        "fin2 done web · tidy: ",
        "fin done web · release: released v0.2.16",
    ])
}

@Test func theCountsLineLeavesOutEmptyBucketsAndNoJobsIsNoLine() {
    let rows = AssistantJobs.rows([
        s("a", state: .waiting, job: "x"), s("b", state: .working, job: "y"), s("c", state: .working, job: "z"), s("d", unread: true, job: "w"),
    ])
    #expect(AssistantJobs.counts(rows) == "1 needs you · 2 working · 1 done")
    #expect(AssistantJobs.counts(AssistantJobs.rows([s("b", state: .working, job: "y")])) == "1 working")
    #expect(AssistantJobs.counts(AssistantJobs.rows([s("e", state: .waiting)])) == nil)
}
```

At the end of `ios/BlimpKit/Tests/BlimpKitTests/SessionFieldsTests.swift`, add:

```swift

@Test func decodesTheAssistantAndItsJobsAndALeftOutOneThatDoesntDecode() throws {
    let base = #""created":1,"dir":"/home/u/web","kind":"claude","title":"t","state":"done""#
    let decode = { (json: String) in try JSONDecoder().decode(Session.self, from: Data(json.utf8)) }
    let a = try decode(#"{"name":"assistant",\#(base),"assistant":true}"#)
    #expect(a.assistant == true && a.job == nil)
    let j = try decode(#"{"name":"web-1",\#(base),"job":{"reason":"fix the tests","at":1792624236489}}"#)
    #expect(j.job == AssistantJob(reason: "fix the tests", at: 1792624236489) && j.assistant == nil)
    let bad = try decode(#"{"name":"web-2",\#(base),"job":{"reason":3},"assistant":"yes"}"#)
    #expect(bad.name == "web-2" && bad.job == nil && bad.assistant == nil)
}
```

In `ios/BlimpKit/Tests/BlimpKitTests/ModelsTests.swift`, after `decodesTheSessionsEventAndIgnoresOthers` (it ends with
`#expect(EventsMessage.decode(Data(#"{"type":"ports","ports":[]}"#.utf8)) == .other)` and `}`), add:

```swift

@Test func decodesTheAssistantsSwitch() {
    #expect(EventsMessage.decode(Data(#"{"type":"assistant","on":true}"#.utf8)) == .assistant(on: true))
    #expect(EventsMessage.decode(Data(#"{"type":"assistant","on":false}"#.utf8)) == .assistant(on: false))
    #expect(EventsMessage.decode(Data(#"{"type":"assistant"}"#.utf8)) == .other)
}
```

In `ios/BlimpKit/Tests/BlimpKitTests/HomeTests.swift`, after `aHiddenProjectLeavesTheStripEvenWithSessionsRunningThere`
(it ends with `#expect(Drawer.projects(sessions: sessions, recent: recent, hidden: []).map(\.name) == ["alpha", "gamma", "beta"])`
and `}`), add:

```swift

@Test func theAssistantsFolderIsntAProjectInTheStrip() {
    var assistant = session("assistant", dir: "/h/.blimp/assistant", created: 4, state: .waiting, updated: 9_000)
    assistant.assistant = true
    let sessions = [session("a1", dir: "/h/alpha", created: 1, updated: 5_000), assistant]
    let recent = [RecentFolder(dir: "/h/.blimp/assistant", lastUsed: 99_000)]
    #expect(Drawer.projects(sessions: sessions, recent: recent).map(\.name) == ["alpha"])
}
```

- [ ] **Step 2: They can't run here**

There's no Swift toolchain on this machine: CI runs them (Task 8). Until Steps 3 to 5 they wouldn't compile:
`AssistantJobs`, `AssistantJob`, `Session.job`, `Session.assistant` and `.assistant(on:)` don't exist yet.

- [ ] **Step 3: The model (`Models.swift`)**

After the `Job` struct, which ends:

```swift
    /// A running command's or Monitor's last output line, at most 10 s old.
    public var lastLine: String? = nil
}
```

add:

```swift

/// On a session the assistant started or messaged (blimpd's jobs.ts): why, in a few words, and when it last acted on
/// it (ms).
public struct AssistantJob: Codable, Sendable, Equatable {
    public let reason: String
    public let at: Double
}
```

In `Session`, after:

```swift
    /// Its checkout, branch and pull requests.
    public var work: Work? = nil
```

add:

```swift
    /// On the assistant's own session (blimpd's assistant.ts): true.
    public var assistant: Bool? = nil
    /// On a session the assistant started or messaged: why, and when.
    public var job: AssistantJob? = nil
```

In `extension Session`'s `CodingKeys`, replace:

```swift
        case jobs, context, git, handoff, parent, runnable, runnableAt, run, work
```

with:

```swift
        case jobs, context, git, handoff, parent, runnable, runnableAt, run, work, assistant, job
```

In `init(from:)`, after `        work = try? c.decodeIfPresent(Work.self, forKey: .work)`, add:

```swift
        assistant = try? c.decodeIfPresent(Bool.self, forKey: .assistant)
        job = try? c.decodeIfPresent(AssistantJob.self, forKey: .job)
```

In `EventsMessage`, replace:

```swift
    /// The server browser's tabs (Browser.swift), every folder's. The feed's switch and how many cards haven't been
    /// seen (Feed.swift).
    case sessions([Session]), browser([BrowserTab]), feed(on: Bool, unseen: Int), other
```

with:

```swift
    /// The server browser's tabs (Browser.swift), every folder's. The feed's switch and how many cards haven't been
    /// seen (Feed.swift). Whether the assistant is on (Settings' switch).
    case sessions([Session]), browser([BrowserTab]), feed(on: Bool, unseen: Int), assistant(on: Bool), other
```

and in `decode`, after `        if w.type == "feed", let on = w.on { return .feed(on: on, unseen: max(0, w.unseen ?? 0)) }`, add:

```swift
        if w.type == "assistant", let on = w.on { return .assistant(on: on) }
```

- [ ] **Step 4: The jobs bar's rules (`AssistantJobs.swift`)**

Create `ios/BlimpKit/Sources/BlimpKit/AssistantJobs.swift`:

```swift
// The assistant's jobs (docs/superpowers/specs/2026-10-26-assistant-design.md, sections 3 and 4): the sessions it
// started or messaged (Session.job), as the phone's jobs bar shows them, with the Mac's rules (app/src/lib/assistant.ts).
// A job is in one bucket: needs you (it waits, or its turn ended with a question), working (it works, or its turn ended
// saying it's still at it), or done (its turn ended with a reply you haven't seen); else it isn't shown.
import Foundation

public enum JobBucket: String, Equatable, Sendable {
    case needs, working, done
}

public struct AssistantJobRow: Equatable, Identifiable, Sendable {
    /// The job's session, by its zmx name.
    public let session: String
    /// The last part of its folder.
    public let project: String
    public let reason: String
    public let bucket: JobBucket
    /// For a wait, what it asks (else its note); none while it works (its note is the turn before's); else its note.
    public let words: String?
    public let mark: Mark
    public var id: String { session }
}

public enum AssistantJobs {
    /// The assistant's session's name (blimpd's ASSISTANT).
    public static let assistant = "assistant"

    /// Needs you, the oldest wait first; working, the longest first; done, the newest first.
    public static func rows(_ sessions: [Session]) -> [AssistantJobRow] {
        var needs: [Session] = [], working: [Session] = [], done: [Session] = []
        for s in sessions where s.job != nil {
            guard let b = bucket(s) else { continue }
            switch b {
            case .needs: needs.append(s)
            case .working: working.append(s)
            case .done: done.append(s)
            }
        }
        let since = { (s: Session) -> Double in s.stateSince ?? s.activity }
        let ordered = stable(needs, by: since, newest: false) + stable(working, by: since, newest: false) + stable(done, by: \.activity, newest: true)
        return ordered.compactMap(row)
    }

    /// "1 needs you · 2 working · 1 done", leaving out the empty ones; nil with no job to show.
    public static func counts(_ rows: [AssistantJobRow]) -> String? {
        var parts: [String] = []
        for (bucket, words) in [(JobBucket.needs, "needs you"), (JobBucket.working, "working"), (JobBucket.done, "done")] {
            let n = rows.filter { $0.bucket == bucket }.count
            if n > 0 { parts.append("\(n) \(words)") }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func bucket(_ s: Session) -> JobBucket? {
        if s.state == .waiting || (s.state == .done && s.note?.status == .question) { return .needs }
        if s.state == .working || (s.state == .done && s.note?.status == .progress) { return .working }
        if s.state == .done && s.unread == true { return .done }
        return nil
    }

    private static func row(_ s: Session) -> AssistantJobRow? {
        guard let job = s.job, let b = bucket(s) else { return nil }
        let words: String?
        if s.state == .waiting { words = Inbox.asked(s.prompt) ?? s.note?.text }
        else if s.state == .working { words = nil }
        else { words = s.note?.text }
        return AssistantJobRow(session: s.name, project: Drawer.name(of: s.dir), reason: job.reason, bucket: b, words: words, mark: s.mark)
    }

    // Ties keep the list's order.
    private static func stable(_ l: [Session], by key: (Session) -> Double, newest: Bool) -> [Session] {
        l.enumerated().sorted {
            let a = key($0.element), b = key($1.element)
            return a != b ? (newest ? a > b : a < b) : $0.offset < $1.offset
        }.map(\.element)
    }
}
```

- [ ] **Step 5: The strip leaves the assistant out (`Home.swift`)**

In `Drawer.projects`, replace the body:

```swift
        let running = Dictionary(grouping: sessions, by: \.dir).map { dir, list in
            ProjectChoice(dir: dir, name: name(of: dir), mark: Mark.top(list.map(\.mark)), activity: list.map(\.activity).max() ?? 0)
        }
        let dirs = Set(running.map(\.dir))
        let idle = recent.filter { !dirs.contains($0.dir) }.map {
            ProjectChoice(dir: $0.dir, name: name(of: $0.dir), mark: .none, activity: $0.lastUsed)
        }
        return (running + idle).filter { !hidden.contains($0.dir) }
            .sorted { $0.activity != $1.activity ? $0.activity > $1.activity : $0.dir < $1.dir }
```

with:

```swift
        // The assistant's folder isn't a project (blimpd leaves it out of the recent folders too).
        let assistant = Set(sessions.filter { $0.assistant == true }.map(\.dir))
        let running = Dictionary(grouping: sessions.filter { $0.assistant != true }, by: \.dir).map { dir, list in
            ProjectChoice(dir: dir, name: name(of: dir), mark: Mark.top(list.map(\.mark)), activity: list.map(\.activity).max() ?? 0)
        }
        let dirs = Set(running.map(\.dir))
        let idle = recent.filter { !dirs.contains($0.dir) }.map {
            ProjectChoice(dir: $0.dir, name: name(of: $0.dir), mark: .none, activity: $0.lastUsed)
        }
        return (running + idle).filter { !hidden.contains($0.dir) && !assistant.contains($0.dir) }
            .sorted { $0.activity != $1.activity ? $0.activity > $1.activity : $0.dir < $1.dir }
```

and add to its doc comment's end (after `A hidden one is left out, even with sessions running there.`) the sentence
` So is the assistant's folder.`

- [ ] **Step 6: Re-read every edited region**

Check: `AssistantJob` sits outside `Job`'s braces; the two new `Session` vars come after `work` (the memberwise init's
existing calls in the tests pass neither); `CodingKeys` lists `assistant, job`; `EventsMessage.Wire` already has
`on: Bool?`; the app's only exhaustive `switch` on `EventsMessage` is in `Store.swift` (Task 3 adds the case);
`AssistantJobs.swift` imports only Foundation; the test helper `s` and `n` are `private` (InboxTests has its own).
Run: `cd /Users/mbeato/blimp-assistant && git diff --check` — expected: no output.

- [ ] **Step 7: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add ios/BlimpKit/Sources/BlimpKit/Models.swift ios/BlimpKit/Sources/BlimpKit/AssistantJobs.swift ios/BlimpKit/Sources/BlimpKit/Home.swift ios/BlimpKit/Tests/BlimpKitTests/AssistantJobsTests.swift ios/BlimpKit/Tests/BlimpKitTests/SessionFieldsTests.swift ios/BlimpKit/Tests/BlimpKitTests/ModelsTests.swift ios/BlimpKit/Tests/BlimpKitTests/HomeTests.swift && git commit -m "BlimpKit: the assistant's session and jobs (Session.assistant and Session.job, decoded leniently), the events' assistant message, the jobs bar's rules (AssistantJobs: needs you, working, done, and the counts line), and the strip leaving the assistant's folder out of the projects"
```

---

### Task 3: iPhone app: the pinned icon, the jobs bar, back to the assistant, and the Settings switch

**Files:**
- Modify: `ios/Blimp/Net/API.swift` (after `feedSaved`)
- Modify: `ios/Blimp/Model/Store.swift` (`assistantOn`; the events switch; `setAssistant`; `signOut`)
- Create: `ios/Blimp/Views/JobsBar.swift`
- Modify: `ios/Blimp/Views/DrawerView.swift` (`onAssistant`; `strip`; the icon)
- Modify: `ios/Blimp/Views/HomeView.swift` (header; `fromAssistant`; the `DrawerView` call; `chat`; the toolbar;
  `backName`; `show`)
- Modify: `ios/Blimp/Views/SettingsView.swift` (header; state; the Assistant section; `setAssistant`; the alert)

**Interfaces:**
- Consumes: `AssistantJobs.assistant`, `AssistantJobs.rows(_:)`, `AssistantJobs.counts(_:)`, `AssistantJobRow`,
  `Session.assistant`, `EventsMessage.assistant(on:)` (Task 2); `PUT /assistant` (Task 1); `MarkView`, `BlimpMark`,
  `plainAlert` (app); `Store.words(for:)`.
- Produces: `API.setAssistant(on: Bool) async throws`; `Store.assistantOn: Bool`, `Store.setAssistant(on: Bool) async throws`;
  `JobsBar(rows: [AssistantJobRow], onOpen: (String) -> Void)`; `DrawerView.onAssistant: () -> Void`;
  `HomeView.show(_:fromAssistant:)`; ids `assistantIcon`, `jobsBar`, `job-<name>`, `assistantSwitch` (Task 4's UI test
  uses the first three).

- [ ] **Step 1: The call (`ios/Blimp/Net/API.swift`)**

After `feedSaved(id:saved:)`, which ends:

```swift
        _ = try await call("POST", "/feed/saved", body: JSONEncoder().encode(Body(id: id, saved: saved)))
    }
```

add:

```swift

    /// The assistant's switch: on, blimpd keeps its chat running; off ends it (its folder and conversations stay). An
    /// older blimpd has no such route: "not found".
    func setAssistant(on: Bool) async throws {
        struct Body: Encodable { let on: Bool }
        _ = try await call("PUT", "/assistant", body: JSONEncoder().encode(Body(on: on)))
    }
```

- [ ] **Step 2: The store (`ios/Blimp/Model/Store.swift`)**

After `    var feedUnseen = 0`, add:

```swift
    /// The assistant's switch, from the events' assistant message: Settings' Assistant switch. Off until blimpd says
    /// (an older one never does).
    var assistantOn = false
```

In `connect()`'s message switch, replace:

```swift
                case .feed(let on, let unseen):
                    self.feedOn = on
                    self.feedUnseen = unseen
                case .other:
```

with:

```swift
                case .feed(let on, let unseen):
                    self.feedOn = on
                    self.feedUnseen = unseen
                case .assistant(let on):
                    self.assistantOn = on
                case .other:
```

In `signOut()`, after `        feedUnseen = 0`, add:

```swift
        assistantOn = false
```

After `closeTab(_:)`, which ends:

```swift
        guard let api else { throw APIError.offline }
        try await api.closeTab(id)
    }
```

add:

```swift

    /// Settings' Assistant switch (PUT /assistant). The events' assistant message says it changed.
    func setAssistant(on: Bool) async throws {
        guard let api else { throw APIError.offline }
        try await api.setAssistant(on: on)
    }
```

- [ ] **Step 3: The jobs bar (`ios/Blimp/Views/JobsBar.swift`)**

Create `ios/Blimp/Views/JobsBar.swift`:

```swift
// The assistant's jobs bar, on top of its chat (docs/superpowers/specs/2026-10-26-assistant-design.md, section 4):
// folded, one line of counts ("1 needs you · 2 working · 1 done"); a tap unfolds a row per job, each with its mark,
// "project · reason" and what it asks or its note. A row opens that job's chat, whose back arrow comes back here. No
// job to show: no bar. Folded each time the chat opens.
import BlimpKit
import SwiftUI

struct JobsBar: View {
    let rows: [AssistantJobRow]
    /// Opens a job's chat, by its session's name.
    let onOpen: (String) -> Void
    @State private var open = false

    var body: some View {
        if let counts = AssistantJobs.counts(rows) {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.snappy) { open.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .rotationEffect(.degrees(open ? 90 : 0))
                        Text(counts).font(.subheadline)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .foregroundStyle(.primary)
                .accessibilityLabel("Jobs, \(counts)")
                .accessibilityHint(open ? "Folds the jobs away" : "Shows each job")
                .accessibilityIdentifier("jobsBar")
                if open {
                    ForEach(rows) { row($0) }
                }
                Divider()
            }
            .background(.bar)
        }
    }

    private func row(_ r: AssistantJobRow) -> some View {
        Button { onOpen(r.session) } label: {
            HStack(alignment: .top, spacing: 8) {
                MarkView(mark: r.mark)
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.project + " · " + r.reason).font(.subheadline).lineLimit(1)
                    if let words = r.words {
                        Text(words).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .foregroundStyle(.primary)
        .accessibilityIdentifier("job-" + r.session)
    }
}
```

- [ ] **Step 4: The pinned icon (`ios/Blimp/Views/DrawerView.swift`)**

After:

```swift
    /// Opens the feed (FeedView).
    let onFeed: () -> Void
```

add:

```swift
    /// Opens the assistant's chat (its icon at the top of the strip).
    let onAssistant: () -> Void
```

Replace:

```swift
    /// The projects in a column down the drawer's left side, two letters each with their mark, the one shown lit; the
    /// column scrolls when they don't all fit. Its foot, always in sight: + (open a folder), Feed (while it's on) and
    /// Settings.
    private var strip: some View {
        VStack(spacing: 0) {
            ScrollView {
```

with:

```swift
    /// The projects in a column down the drawer's left side, two letters each with their mark, the one shown lit; the
    /// column scrolls when they don't all fit. Above it, while the assistant runs, the assistant's icon and a thin line.
    /// Its foot, always in sight: + (open a folder), Feed (while it's on) and Settings.
    private var strip: some View {
        VStack(spacing: 0) {
            if let assistant {
                assistantIcon(assistant)
                    .padding(.top, 12)
                    .padding(.bottom, 10)
                Divider().frame(width: 40)
            }
            ScrollView {
```

Before `    /// "blimp, asking you something", "mbeato, new reply", "api-server".`, add:

```swift
    /// The assistant's session while it runs (blimpd marks it).
    private var assistant: Session? { store.sessions.first { $0.assistant == true } }

    /// The assistant: the blimp, with its session's mark. A tap opens its chat, with the drawer closed.
    private func assistantIcon(_ s: Session) -> some View {
        Button(action: onAssistant) {
            BlimpMark(width: 30)
                .frame(width: 40, height: 40)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                .overlay(alignment: .topTrailing) { MarkView(mark: s.mark).offset(x: 4, y: -4) }
        }
        .accessibilityLabel(Self.assistantLabel(s.mark))
        .accessibilityIdentifier("assistantIcon")
    }

    /// "Assistant, asking you something", "Assistant, new reply", "Assistant".
    private static func assistantLabel(_ mark: Mark) -> String {
        switch mark {
        case .asking: "Assistant, asking you something"
        case .unread: "Assistant, new reply"
        case .working, .none: "Assistant"
        }
    }

```

In the file's header comment, replace `// project, FolderBrowserView), Feed (while the feed is on, with a dot while it has cards not seen) and Settings.`
with:

```swift
// project, FolderBrowserView), Feed (while the feed is on, with a dot while it has cards not seen) and Settings. Above
// the projects, while the assistant runs, its blimp icon with its mark opens its chat.
```

- [ ] **Step 5: Navigation (`ios/Blimp/Views/HomeView.swift`)**

In the header comment, replace:

```swift
// from the drawer opens full screen over all of it (BrowserView), and not under the lock's cover. The feed from the
// drawer's Feed button opens the same way (FeedView).
```

with:

```swift
// from the drawer opens full screen over all of it (BrowserView), and not under the lock's cover. The feed from the
// drawer's Feed button opens the same way (FeedView). The assistant's icon at the top of the strip opens its chat (its
// folder isn't a project, so the project stays), with its jobs bar (JobsBar) on top; a job opened there goes back to it.
```

After `    @State private var away: Double?`, add:

```swift
    /// The chat on screen is a job opened from the assistant's jobs bar: its back arrow goes back to the assistant.
    @State private var fromAssistant = false
```

In the `DrawerView(…)` call, replace:

```swift
                       onFeed: { drawer = false; showFeed = true },
                       actions: actions, onOpen: { show(.session($0)) },
```

with:

```swift
                       onFeed: { drawer = false; showFeed = true },
                       onAssistant: { show(.session(AssistantJobs.assistant)) },
                       actions: actions, onOpen: { show(.session($0)) },
```

In `chat`, replace:

```swift
        case .session(let name):
            SessionView(name: name, onOpen: { show(.session($0)) })
```

with:

```swift
        case .session(let name):
            SessionView(name: name, onOpen: { show(.session($0)) })
                // The assistant's chat: its jobs bar on top (no job to show: none).
                .safeAreaInset(edge: .top, spacing: 0) {
                    if name == AssistantJobs.assistant {
                        JobsBar(rows: AssistantJobs.rows(store.sessions)) { show(.session($0), fromAssistant: true) }
                    }
                }
```

In `toolbar`, replace:

```swift
                // In a chat: back to the project's inbox, with the same mark. A swipe right opens the drawer.
                Button { show(.inbox) } label: {
                    HStack(spacing: 2) {
                        Image(systemName: "chevron.left").font(.body.weight(.semibold))
                        Text(projectName).lineLimit(1).frame(maxWidth: 120, alignment: .leading)
                    }
                    .overlay(alignment: .topTrailing) { badge.offset(x: 8, y: -3) }
                }
                .accessibilityLabel(badgeLabel.map { "Back to \(projectName), \($0)" } ?? "Back to \(projectName)")
```

with:

```swift
                // In a chat: back to the project's inbox, with the same mark; in a job opened from the assistant's jobs
                // bar, back to the assistant. A swipe right opens the drawer.
                Button {
                    if fromAssistant { show(.session(AssistantJobs.assistant)) } else { show(.inbox) }
                } label: {
                    HStack(spacing: 2) {
                        Image(systemName: "chevron.left").font(.body.weight(.semibold))
                        Text(backName).lineLimit(1).frame(maxWidth: 120, alignment: .leading)
                    }
                    .overlay(alignment: .topTrailing) { badge.offset(x: 8, y: -3) }
                }
                .accessibilityLabel(badgeLabel.map { "Back to \(backName), \($0)" } ?? "Back to \(backName)")
```

After `    private var projectName: String { store.dir.map(Drawer.name(of:)) ?? "blimp" }`, add:

```swift

    /// The back arrow's words: Assistant in a job its jobs bar opened, else the project's name.
    private var backName: String { fromAssistant ? "Assistant" : projectName }
```

Replace `show(_:)`:

```swift
    /// A session from another project (a banner's) brings its project along. Opening one
    /// ends "since you left".
    private func show(_ o: Opened) {
        if case .session(let name) = o {
            away = nil
            if let s = store.sessions.first(where: { $0.name == name }), s.dir != store.dir { store.dir = s.dir }
        }
        opened = o
        drawer = false
    }
```

with:

```swift
    /// A session from another project (a banner's) brings its project along; the assistant's doesn't, as its folder
    /// isn't a project. Opening one ends "since you left". fromAssistant: a job opened from the assistant's jobs bar,
    /// whose back arrow then goes back to the assistant; opening anything any other way clears it.
    private func show(_ o: Opened, fromAssistant: Bool = false) {
        if case .session(let name) = o {
            away = nil
            if let s = store.sessions.first(where: { $0.name == name }), s.assistant != true, s.dir != store.dir { store.dir = s.dir }
        }
        self.fromAssistant = fromAssistant
        opened = o
        drawer = false
    }
```

(`Drawer.badge` and `mark` stay as they are: the top-left badge counts the assistant like any session.)

- [ ] **Step 6: The switch (`ios/Blimp/Views/SettingsView.swift`)**

Replace the header line:

```swift
// Settings: which server this phone is paired with, notifications, the voice replies are read in, and sign out.
```

with:

```swift
// Settings: which server this phone is paired with, notifications, the assistant's switch, the voice replies are read
// in, and sign out.
```

After `    @State private var notify = !Push.off`, add:

```swift
    /// The Assistant switch going off asks first (its chat ends); a refusal from blimpd shows in an alert.
    @State private var confirmOff = false
    @State private var assistantFailure: String?
```

After the Notifications section, which ends:

```swift
                        : "When a session waits on you or a long turn ends, even with blimp closed. The server needs its push key first (blimpd push-key).")
                }
```

add:

```swift
                Section {
                    Toggle("Assistant", isOn: Binding(get: { store.assistantOn }, set: { on in
                        if on { setAssistant(true) } else { confirmOff = true }
                    }))
                    .tint(.green)
                    .accessibilityIdentifier("assistantSwitch")
                    .confirmationDialog("Turn off the assistant? Its chat ends; its folder and conversations stay.",
                                        isPresented: $confirmOff, titleVisibility: .visible) {
                        Button("Turn Off", role: .destructive) { setAssistant(false) }
                        Button("Cancel", role: .cancel) {}
                    }
                } footer: {
                    Text("One Claude chat that isn't a project. It can look at every project and asks before it acts.")
                }
```

Replace:

```swift
            .onAppear { voices = Speaker.installed }
            .onDisappear { Speaker.shared.stop() }
```

with:

```swift
            .onAppear { voices = Speaker.installed }
            .onDisappear { Speaker.shared.stop() }
            .plainAlert("Couldn't change the assistant", message: $assistantFailure)
```

Before `    private func voiceRow(_ name: String, detail: String, id: String?) -> some View {`, add:

```swift
    /// The switch shows its new place at once, and goes back if blimpd refused, saying why. The events' assistant
    /// message then says the same.
    private func setAssistant(_ on: Bool) {
        store.assistantOn = on
        Task {
            do { try await store.setAssistant(on: on) } catch {
                store.assistantOn = !on
                assistantFailure = Store.words(for: error)
            }
        }
    }

```

- [ ] **Step 7: Re-read every edited region**

Check: `DrawerView`'s new `let onAssistant` comes right after `onFeed`, and `HomeView` passes `onAssistant:` right after
`onFeed:` (the memberwise init's order); `DrawerView` and `HomeView` already import BlimpKit, and `JobsBar.swift` does;
`SettingsView` needs no BlimpKit (`Store`, `plainAlert` are the app's); `Store`'s `switch` now has `.assistant`;
`show` is the only place that sets `fromAssistant`, and every caller but the jobs bar's leaves it `false`;
`MarkView` and `BlimpMark` are internal views in the app module. Run `cd /Users/mbeato/blimp-assistant && git diff --check`
— expected: no output.

- [ ] **Step 8: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add ios/Blimp/Net/API.swift ios/Blimp/Model/Store.swift ios/Blimp/Views/JobsBar.swift ios/Blimp/Views/DrawerView.swift ios/Blimp/Views/HomeView.swift ios/Blimp/Views/SettingsView.swift && git commit -m "iPhone: the assistant's icon pinned at the top of the drawer's strip opens its chat (its folder never becomes the project), a jobs bar on top of its chat that folds to its counts and opens each job with a back arrow to the assistant, and an Assistant switch in Settings that asks before turning it off"
```

---

### Task 4: iPhone e2e: a stand-in assistant with a job, and `testAssistantIconAndJobsBar`

**Files:**
- Modify: `ios/e2e/setup.ts` (header comment; the stand-in and the jobs file before the feed; `config.json`)
- Modify: `ios/BlimpUITests/BlimpUITests.swift` (a test above `// MARK: - Helpers`)
- Modify: `.github/workflows/ios.yml` (both of shard a's lines)

**Interfaces:**
- Consumes: ids `assistantIcon`, `jobsBar`, `job-demo-ask`, `inboxBack` (Task 3); `standIn`, `user`, `said`, `sock`
  (setup.ts); `launchPaired`, `openDrawer`, `element`, `message`, `wait`, `until`, `shot`, `failed` (BlimpUITests).
- Produces: a session named `assistant` in `<socket dir>/assistant` with the user message "What's waiting on me?";
  `assistant-jobs.json` with demo-ask as a job (reason "run the test suite"); `"assistant": true` in `config.json`.

- [ ] **Step 1: The stand-ins (`ios/e2e/setup.ts`)**

In the header comment, after the line
`//              testFeed restores this fixture at its start ($E2E_DIR/feed-fixture.json to the path in $E2E_DIR/feed-path)`,
add:

```ts
//   assistant  in the socket folder's assistant/ (not a project, so not in the strip): a stand-in for the assistant,
//              with a conversation; demo-ask is its job ("run the test suite", in assistant-jobs.json), and config.json
//              turns the assistant on once it runs, so blimpd's keep-alive never starts one of its own
```

Before the line `// The feed (testFeed): feed.json before the switch, so blimpd's job never sees it on with no lastRun.`, add:

```ts
// The assistant (testAssistantIconAndJobsBar). The job updates blimpd types into it go nowhere.
await standIn("assistant", join(dirname(sock), "assistant"), "exec cat > /dev/null", "e2e00000-0000-0000-0000-000000000008",
  [user("u1", "What's waiting on me?"), said("a1", "demo-ask in api-server wants to run npm test.")]);
writeFileSync(join(dirname(sock), "assistant-jobs.json"), JSON.stringify({ "demo-ask": { reason: "run the test suite", at: Date.now() } }));
console.log("assistant: a stand-in, with demo-ask as its job");

```

Replace:

```ts
writeFileSync(join(dirname(sock), "config.json"), JSON.stringify({ feed: { on: true } }));
console.log("feed: on, three cards");
```

with:

```ts
writeFileSync(join(dirname(sock), "config.json"), JSON.stringify({ feed: { on: true }, assistant: true }));
console.log("feed: on, three cards; assistant: on");
```

Check: `grep -c "000000000008" ios/e2e/setup.ts` prints 1 (no other stand-in uses that id), and
`cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun build --target=bun ios/e2e/setup.ts > /dev/null` exits 0.

- [ ] **Step 2: The UI test (`ios/BlimpUITests/BlimpUITests.swift`)**

Before the line `    // MARK: - Helpers`, add:

```swift
    // MARK: - The assistant

    /// The assistant (setup.ts's stand-in, a session named assistant whose folder isn't a project) is pinned at the top
    /// of the drawer's strip: its icon opens its chat, whose jobs bar, folded, says "1 needs you" (demo-ask is its job).
    /// Unfolded, demo-ask's row opens demo-ask's chat, whose back arrow says Assistant and goes back to the assistant's
    /// chat. (In shard a, after test1 answered demo-ask: its status file still says it waits.)
    func testAssistantIconAndJobsBar() throws {
        try launchPaired()
        try openDrawer()
        let icon = element("assistantIcon")
        try wait(icon, "the assistant's icon at the top of the strip")
        if element("strip-assistant").exists { throw failed("no assistant folder among the projects") }
        icon.tap()
        try until(element("drawerStrip"), "exists == false", "the drawer to close as the assistant's chat opens")
        try wait(message("message.user", "What's waiting on me?"), "the assistant's chat from its icon")
        let bar = element("jobsBar")
        try wait(bar, "the jobs bar on top of the assistant's chat")
        try until(bar, "label CONTAINS '1 needs you'", "the jobs bar's counts")
        let row = element("job-demo-ask")
        if row.exists { throw failed("the jobs bar to start folded") }
        shot("51-assistant")
        bar.tap()
        try wait(row, "demo-ask's row in the unfolded jobs bar")
        try until(row, "label CONTAINS 'api-server · run the test suite'", "demo-ask's project and reason on its row")
        shot("52-jobs-bar")
        row.tap()
        try wait(message("message.user", "Run the test suite"), "demo-ask's chat from its row")
        let back = element("inboxBack")
        try until(back, "label CONTAINS 'Assistant'", "the back arrow to say Assistant")
        back.tap()
        try wait(message("message.user", "What's waiting on me?"), "the assistant's chat again from the back arrow")
        try wait(element("jobsBar"), "the jobs bar again")
    }

```

Check `grep -n 'shot("5[12]\|screen("5[12]' ios/BlimpUITests/BlimpUITests.swift` finds only these two.

- [ ] **Step 3: The shard lists (`.github/workflows/ios.yml`)**

Add `testAssistantIconAndJobsBar` after `testStuckStart` in shard a's core tests (the 4th argument) on both lines.
The Mac's: replace

```yaml
            shard a 7425 7431 "test1PairChatAndAnswer test2FaceIDLock test3Stop test7AnswerQuestions test8TrustFolder testStuckStart" "test9DrawerFromASwipe testInbox"
```

with

```yaml
            shard a 7425 7431 "test1PairChatAndAnswer test2FaceIDLock test3Stop test7AnswerQuestions test8TrustFolder testStuckStart testAssistantIconAndJobsBar" "test9DrawerFromASwipe testInbox"
```

and GitHub's: replace

```yaml
            shard a 7425 7431 "test1PairChatAndAnswer test2FaceIDLock test8TrustFolder testStuckStart" "test9DrawerFromASwipe testInbox"
```

with

```yaml
            shard a 7425 7431 "test1PairChatAndAnswer test2FaceIDLock test8TrustFolder testStuckStart testAssistantIconAndJobsBar" "test9DrawerFromASwipe testInbox"
```

Check: `grep -c testAssistantIconAndJobsBar .github/workflows/ios.yml` prints 2. Change nothing else.

- [ ] **Step 4: Re-read every edited region**

Check: `standIn` is declared above the new block (it is, near the top); `dirname` and `join` are already imported in
setup.ts; the stand-in assistant starts before `config.json` turns the assistant on; the UI test sits inside the class,
above `// MARK: - Helpers`, and uses only helpers that exist there.

- [ ] **Step 5: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add ios/e2e/setup.ts ios/BlimpUITests/BlimpUITests.swift .github/workflows/ios.yml && git commit -m "iPhone: the e2e's stand-in assistant with demo-ask as its job, and testAssistantIconAndJobsBar (the icon opens its chat, the jobs bar opens demo-ask, its back arrow returns to the assistant), in shard a on both lists"
```

---

### Task 5: Mac app lib: the session's fields, the events message, `ServerLink`, `Api`, and the jobs' rules

**Files:**
- Modify: `app/src/lib/api.ts` (`Session`'s fields; `AssistantJob` after `Job`; `Api.setAssistant` after `removeZaiKey`)
- Modify: `app/src/lib/events.ts` (header; `EventHandlers.onAssistant`; the branch)
- Modify: `app/src/lib/connection.ts` (`assistantOn`; the handler; `setAssistant`)
- Create: `app/src/lib/assistant.ts`, `app/src/lib/assistant.test.ts`
- Modify: `app/src/lib/connection.test.ts` (the fake socket; a test at the end)

**Interfaces:**
- Consumes: `Session`, `Note` (api.ts); `askedWords` (lib/inbox.ts); `lastActivity` (lib/sessions.ts); `baseName`
  (lib/files.ts); `PUT /assistant` and the events message (Task 1).
- Produces:
  - `type AssistantJob = { reason: string; at: number }`; `Session.assistant?: true`; `Session.job?: AssistantJob`
  - `Api.setAssistant(on: boolean): Promise<void>`
  - `EventHandlers.onAssistant: (on: boolean) => void`
  - `ServerLink.assistantOn: boolean | null`; `ServerLink.setAssistant(on: boolean): Promise<void>`
  - `type JobBucket = "needs" | "working" | "done"`;
    `type JobRow = { session: Session; project: string; reason: string; bucket: JobBucket; words?: string }`;
    `jobRows(sessions: Session[]): JobRow[]`; `jobCounts(rows: JobRow[]): string`

- [ ] **Step 1: Install the app's packages if this worktree has none**

Run: `cd /Users/mbeato/blimp-assistant/app && (test -d node_modules || PATH=$HOME/.bun/bin:$PATH bun install --frozen-lockfile)`
Expected: exits 0 (bun.lock unchanged: `git status --short app/bun.lock` prints nothing).

- [ ] **Step 2: Write the failing tests**

Create `app/src/lib/assistant.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { Note, Session } from "./api";
import { jobCounts, jobRows } from "./assistant";

// The same cases as the phone's (ios/BlimpKit/Tests/BlimpKitTests/AssistantJobsTests.swift).

const s = (name: string, extra: Partial<Session> = {}): Session => ({
  name,
  kind: "claude",
  pid: 1,
  clients: 0,
  created: 1,
  dir: "/h/web",
  cmd: "claude",
  sessionId: name + "-id",
  title: name.toUpperCase(),
  status: "idle",
  state: "done",
  updatedAt: 1000,
  ...extra,
});
const job = (reason: string) => ({ job: { reason, at: 1 } });
const note = (status: Note["status"], text: string): Note => ({ status, text, at: 1 });
const lines = (sessions: Session[]) => jobRows(sessions).map((r) => `${r.session.name} ${r.bucket} ${r.project} · ${r.reason}: ${r.words ?? ""}`);

test("each job is in one bucket: needs you, working or done; the rest aren't shown", () => {
  expect(
    lines([
      s("wait", { ...job("run the tests"), dir: "/h/api", state: "waiting", stateSince: 3000, updatedAt: 3000, prompt: { kind: "permission", summary: "Ran `bun test`" } }),
      s("ask", { ...job("ship it"), stateSince: 1000, updatedAt: 1000, note: note("question", "ship v0.2.16?") }),
      s("work", { ...job("fix CI"), state: "working", stateSince: 2000, updatedAt: 2500, note: note("done", "an earlier turn") }),
      s("prog", { ...job("the docs"), stateSince: 1500, updatedAt: 1500, unread: true, note: note("progress", "half the pages done") }),
      s("fin", { ...job("release"), updatedAt: 4000, unread: true, note: note("done", "released v0.2.16") }),
      s("fin2", { ...job("tidy"), updatedAt: 6000, unread: true }),
      s("read", { ...job("old"), updatedAt: 7000, unread: false, note: note("done", "read already") }),
      s("plain", { state: "waiting", updatedAt: 500 }),
      s("idle", { ...job("shell"), state: "unknown", updatedAt: 8000 }),
    ]),
  ).toEqual([
    "ask needs web · ship it: ship v0.2.16?",
    "wait needs api · run the tests: Ran `bun test`",
    "prog working web · the docs: half the pages done",
    "work working web · fix CI: ",
    "fin2 done web · tidy: ",
    "fin done web · release: released v0.2.16",
  ]);
});

test("the counts line leaves out empty buckets; no job to show, no line", () => {
  const rows = jobRows([
    s("a", { ...job("x"), state: "waiting" }),
    s("b", { ...job("y"), state: "working" }),
    s("c", { ...job("z"), state: "working" }),
    s("d", { ...job("w"), unread: true }),
  ]);
  expect(jobCounts(rows)).toBe("1 needs you · 2 working · 1 done");
  expect(jobCounts(jobRows([s("b", { ...job("y"), state: "working" })]))).toBe("1 working");
  expect(jobCounts(jobRows([s("e", { state: "waiting" })]))).toBe("");
});
```

In `app/src/lib/connection.test.ts`, replace:

```ts
// A blimpd that answers /health while `healthy` is true, and whose events socket sends an empty
// session list as soon as it opens. The base URL's port (1) is the tunnel's local port.
```

with:

```ts
// A blimpd that answers /health (and any other call) while `healthy` is true, and whose events socket sends an
// empty session list, then that the assistant is on, as soon as it opens. The base URL's port (1) is the tunnel's
// local port.
```

and replace:

```ts
  constructor() {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "sessions", sessions: [] }) }));
  }
```

with:

```ts
  constructor() {
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ type: "sessions", sessions: [] }) });
      this.onmessage?.({ data: JSON.stringify({ type: "assistant", on: true }) });
    });
  }
```

At the end of the file, add:

```ts

test("assistantOn is null until the events socket says, then what it says; setAssistant shows the new one at once", async () => {
  const quiet = new ServerLink({ host: "quiet" }, () => {});
  expect(quiet.assistantOn).toBeNull();
  quiet.stop();
  healthy = true;
  const link = await connected("assistant");
  expect(link.assistantOn).toBe(true);
  await link.setAssistant(false);
  expect(link.assistantOn).toBe(false);
  link.stop();
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd /Users/mbeato/blimp-assistant/app && PATH=$HOME/.bun/bin:$PATH bun test src/lib/assistant.test.ts src/lib/connection.test.ts`
Expected: FAIL: `Cannot find module './assistant'`, and `expect(received).toBeNull()` with `undefined`.

- [ ] **Step 4: The session and the call (`app/src/lib/api.ts`)**

In `Session`, after `  work?: Work; // its checkout, branch and pull requests (older blimpd: absent)`, add:

```ts
  assistant?: true; // the assistant's own session (blimpd's assistant.ts; older blimpd: absent)
  job?: AssistantJob; // a session the assistant started or messaged: why, and when (older blimpd, or none: absent)
```

After the `Job` type, which ends:

```ts
  exit?: number;
  lastLine?: string;
};
```

add:

```ts

// On a session the assistant started or messaged (blimpd's jobs.ts): why, in a few words, and when it last acted on
// it (ms).
export type AssistantJob = { reason: string; at: number };
```

After `removeZaiKey()`, which ends:

```ts
  async removeZaiKey() {
    await this.req("/keys/zai", { method: "DELETE" });
  }
```

add:

```ts

  // The assistant's switch: on, blimpd keeps its chat running; off ends it (its folder and conversations stay).
  async setAssistant(on: boolean) {
    await this.req("/assistant", { method: "PUT", body: JSON.stringify({ on }), headers: { "Content-Type": "application/json" } });
  }
```

- [ ] **Step 5: The events message (`app/src/lib/events.ts`)**

Replace:

```ts
// The /events WebSocket: the session list as it changes, the ports sessions listen on, the
// server browser's tabs, and changes to watched paths.
```

with:

```ts
// The /events WebSocket: the session list as it changes, the ports sessions listen on, the
// server browser's tabs, whether the assistant is on, and changes to watched paths.
```

After `  onBrowser: (tabs: BrowserTab[]) => void;`, add:

```ts
  onAssistant: (on: boolean) => void; // the assistant's switch (Settings)
```

After `      else if (msg.type === "browser" && Array.isArray(msg.tabs)) this.h.onBrowser(msg.tabs);`, add:

```ts
      else if (msg.type === "assistant" && typeof msg.on === "boolean") this.h.onAssistant(msg.on);
```

- [ ] **Step 6: The link (`app/src/lib/connection.ts`)**

After `  browserTabs: BrowserTab[] = [];`, add:

```ts
  // The assistant's switch, from the events socket's assistant message; null until it says (an older blimpd never
  // does, and Settings then shows no switch for it).
  assistantOn: boolean | null = null;
```

In `open()`'s handlers, after:

```ts
        onBrowser: (tabs) => {
          this.browserTabs = tabs;
          this.onChange(this);
        },
```

add:

```ts
        onAssistant: (on) => {
          this.assistantOn = on;
          this.onChange(this);
        },
```

Before `  // Also during a connect: disconnect cancels a tunnel that is still starting.`, add:

```ts
  // Settings' Assistant switch: PUT /assistant, shown at once (blimpd's events message says the same within a second).
  async setAssistant(on: boolean) {
    if (!this.api) throw new Error("Not connected.");
    await this.api.setAssistant(on);
    this.assistantOn = on;
    this.onChange(this);
  }

```

- [ ] **Step 7: The jobs' rules (`app/src/lib/assistant.ts`)**

Create `app/src/lib/assistant.ts`:

```ts
// The assistant (docs/superpowers/specs/2026-10-26-assistant-design.md, section 4): its jobs, the sessions it started
// or messaged (Session.job), as the session list's pinned Assistant group shows them. The phone's jobs bar has the same
// rules and tests (ios/BlimpKit AssistantJobs.swift). A job is in one bucket: needs you (it waits, or its turn ended
// with a question), working (it works, or its turn ended saying it's still at it), or done (its turn ended with a reply
// you haven't seen); else it isn't shown.

import type { Session } from "./api";
import { baseName } from "./files";
import { askedWords } from "./inbox";
import { lastActivity } from "./sessions";

export type JobBucket = "needs" | "working" | "done";
// words: for a wait, what it asks (else its note); none while it works (its note is the turn before's); else its note.
export type JobRow = { session: Session; project: string; reason: string; bucket: JobBucket; words?: string };

function bucket(s: Session): JobBucket | undefined {
  if (s.state === "waiting" || (s.state === "done" && s.note?.status === "question")) return "needs";
  if (s.state === "working" || (s.state === "done" && s.note?.status === "progress")) return "working";
  if (s.state === "done" && s.unread) return "done";
}

const since = (s: Session) => s.stateSince ?? lastActivity(s);

// Needs you, the oldest wait first; working, the longest first; done, the newest first. Sorts are stable: ties keep
// the list's order.
export function jobRows(sessions: Session[]): JobRow[] {
  const rows: JobRow[] = [];
  for (const s of sessions) {
    const b = bucket(s);
    if (!s.job || !b) continue;
    const words = s.state === "waiting" ? (askedWords(s.prompt) ?? s.note?.text) : s.state === "working" ? undefined : s.note?.text;
    rows.push({ session: s, project: baseName(s.dir), reason: s.job.reason, bucket: b, words });
  }
  const of = (b: JobBucket) => rows.filter((r) => r.bucket === b);
  return [
    ...of("needs").sort((a, b) => since(a.session) - since(b.session)),
    ...of("working").sort((a, b) => since(a.session) - since(b.session)),
    ...of("done").sort((a, b) => lastActivity(b.session) - lastActivity(a.session)),
  ];
}

// "1 needs you · 2 working · 1 done", leaving out the empty ones; "" with no job to show.
export function jobCounts(rows: JobRow[]): string {
  const n = (b: JobBucket) => rows.filter((r) => r.bucket === b).length;
  return [n("needs") && `${n("needs")} needs you`, n("working") && `${n("working")} working`, n("done") && `${n("done")} done`].filter(Boolean).join(" · ");
}
```

- [ ] **Step 8: Run them to verify they pass**

Run: `cd /Users/mbeato/blimp-assistant/app && PATH=$HOME/.bun/bin:$PATH bun test src/lib/assistant.test.ts src/lib/connection.test.ts`
Expected: PASS (2 tests in assistant.test.ts; connection.test.ts's tests, the new one too).

- [ ] **Step 9: All of the app's lib tests and the type check**

Run: `cd /Users/mbeato/blimp-assistant/app && PATH=$HOME/.bun/bin:$PATH bun test src && PATH=$HOME/.bun/bin:$PATH bun x tsc --noEmit`
Expected: 0 fail, and no type errors.

- [ ] **Step 10: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add app/src/lib/api.ts app/src/lib/events.ts app/src/lib/connection.ts app/src/lib/connection.test.ts app/src/lib/assistant.ts app/src/lib/assistant.test.ts && git commit -m "Mac app: the assistant's session and jobs on Session, the events socket's assistant message kept as ServerLink.assistantOn, PUT /assistant (Api and ServerLink.setAssistant), and the jobs' rules in lib/assistant.ts with the phone's cases"
```

---

### Task 6: Mac app UI: the pinned Assistant group, opening its sessions, and Settings > Assistant

**Files:**
- Create: `app/src/components/AssistantGroup.tsx`
- Modify: `app/src/components/TerminalPane.tsx` (import; the `onPick` prop; the group above `InboxSummary`)
- Modify: `app/src/App.tsx` (`open`; `TerminalPane`'s `onPick`)
- Modify: `app/src/components/SettingsDialog.tsx` (header; the Assistant section; an `Assistant` component)
- Modify: `app/src/styles/app.css` (after `.inbox-words`; after `.settings-error`)
- Test: create `app/e2e/assistant.spec.ts`

**Interfaces:**
- Consumes: `jobRows`, `jobCounts`, `JobRow` (Task 5's lib/assistant.ts); `Session.assistant`; `ServerLink.assistantOn`,
  `ServerLink.setAssistant` (Task 5); `StateMark` (components/StateMark.tsx); `sessionTitle` (lib/sessions.ts);
  App's `pickSession(l, name)` and `open(server, dir, session)`; e2e helpers `e2e`, `fixtureDir`, `frontTab`,
  `killSession`, `openApp`, `sessionRow`, `startSession`, `zmxEnv`.
- Produces: `AssistantGroup(props: { sessions: Session[]; onOpen: (name: string) => void })`;
  `TerminalPane`'s prop `onPick: (name: string) => void`.

- [ ] **Step 1: Write the failing e2e spec**

Create `app/e2e/assistant.spec.ts`:

```ts
// The assistant (docs/superpowers/specs/2026-10-26-assistant-design.md, section 4): pinned at the top of every tab's
// session list while its session runs, with its jobs under it. Here a stand-in session named assistant in its folder
// under the test blimpd's socket folder, and a job of its: a waiting session in another folder, listed in
// assistant-jobs.json. The group shows both and folds to its counts; a job's row opens that session in its folder's
// tab; the assistant's row opens it without its folder joining the recent projects; Settings has the switch, and
// turning it off asks first, then ends the assistant.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { e2e, fixtureDir, frontTab, killSession, openApp, sessionRow, startSession, zmxEnv } from "./helpers";

const job = `blimpe2e-asstjob-${process.pid}`;
const other = `blimpe2e-asstother-${process.pid}`;
// The test blimpd's socket folder: its config.json, assistant-jobs.json and the assistant's folder.
const blimpDir = () => dirname(e2e().statusDir);
const config = () => join(blimpDir(), "config.json");
let saved: string | null = null;

// The assistant's name must be exactly assistant, which helpers.ts's startSession and killSession refuse (they keep
// to blimpe2e-*). The test blimpd has its own zmx folder (setup.ts's ZMX_DIR), so the name touches nothing else.
const zmx = (args: string[], cwd?: string) => execFileSync("zmx", args, { cwd, env: zmxEnv(), stdio: "ignore", timeout: 10_000 });

test.afterAll(() => {
  // The switch back first, so blimpd doesn't start an assistant of its own once the stand-in is gone.
  if (saved === null) rmSync(config(), { force: true });
  else writeFileSync(config(), saved);
  try {
    zmx(["kill", "assistant"]);
  } catch {}
  killSession(job);
  killSession(other);
});

test("the pinned Assistant group shows the assistant and its job, folds, and opens each; Settings turns it off after asking", async ({ page }) => {
  const home = fixtureDir("asst-home");
  const work = fixtureDir("asst-work");
  const mine = join(blimpDir(), "assistant");
  mkdirSync(mine, { recursive: true });
  startSession(other, home);
  startSession(job, work);
  zmx(["attach", "assistant", "cat"], mine);
  writeFileSync(join(e2e().statusDir, `${job}.json`), JSON.stringify({ state: "waiting", at: Date.now() }));
  writeFileSync(join(blimpDir(), "assistant-jobs.json"), JSON.stringify({ [job]: { reason: "fix the tests", at: Date.now() } }));
  saved = existsSync(config()) ? readFileSync(config(), "utf8") : null;
  writeFileSync(config(), JSON.stringify({ ...(saved ? JSON.parse(saved) : {}), assistant: true }));

  await openApp(page, { dir: home, session: other });
  const group = frontTab(page).locator("section.assistant");
  const mineRow = group.locator('.assistant-line[data-session="assistant"]');
  const jobRow = group.locator(`.assistant-job[data-session="${job}"]`);
  await expect(mineRow).toBeVisible({ timeout: 5000 });
  await expect(jobRow).toContainText("asst-work · fix the tests");

  // Folded: one line with its counts, kept on this computer.
  const fold = group.locator(".slist-fold");
  await fold.click();
  await expect(fold).toHaveText(/Assistant · 1 needs you/);
  await expect(jobRow).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("blimp.assistantOpen"))).toBe("closed");
  await fold.click();

  // A job's row opens it in its own folder's tab.
  await jobRow.click();
  await expect(sessionRow(page, job)).toHaveClass(/selected/);

  // The assistant's row opens it; its folder never joins the recent projects.
  await mineRow.click();
  await expect(sessionRow(page, "assistant")).toHaveClass(/selected/);
  expect(await page.evaluate(() => localStorage.getItem("blimp.recent") ?? "")).not.toContain(mine);

  // Settings: on; Turn Off asks first; Cancel keeps it; Turn Off ends it, and the group goes.
  await page.keyboard.press("Meta+,");
  const dialog = page.locator(".dialog.settings");
  const box = dialog.getByRole("checkbox", { name: "Assistant" });
  await expect(box).toBeChecked();
  const ask = dialog.locator(".settings-confirm");
  await box.click();
  await expect(ask).toContainText("Turn off the assistant? Its chat ends.");
  await expect(box).toBeChecked();
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await box.click();
  await ask.getByRole("button", { name: "Turn Off" }).click();
  await expect(box).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator("section.assistant")).toHaveCount(0, { timeout: 5000 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/mbeato/blimp-assistant/app && PATH=$HOME/.bun/bin:$PATH bun run e2e assistant.spec.ts`
Expected: FAIL at `expect(mineRow).toBeVisible` (there is no `section.assistant`). If it fails earlier, in global
setup (no `ssh localhost`, or Playwright's Chromium missing: `PATH=$HOME/.bun/bin:$PATH bun x playwright install chromium`),
fix that first and don't go on until it fails at `mineRow`.

- [ ] **Step 3: The group (`app/src/components/AssistantGroup.tsx`)**

Create `app/src/components/AssistantGroup.tsx`:

```tsx
import { useState } from "react";
import type { Session } from "../lib/api";
import { jobCounts, jobRows } from "../lib/assistant";
import { sessionTitle } from "../lib/sessions";
import { StateMark } from "./StateMark";

const OPEN_KEY = "blimp.assistantOpen";

// The assistant, pinned at the top of every tab's session list while its session runs: its row with its mark, then its
// jobs indented under it, each "project · reason" with its mark and what it asks or its note. A click opens that
// session where it lives (onOpen: App's ⌘K path, which never keeps the assistant's folder as a recent project). It
// folds to one line ("Assistant · 1 needs you · 2 working"); the choice is kept on this computer.
export function AssistantGroup(props: { sessions: Session[]; onOpen: (name: string) => void }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? "closed" : "open");
      } catch {}
      return !o;
    });
  const assistant = props.sessions.find((s) => s.assistant === true);
  if (!assistant) return null;
  const rows = jobRows(props.sessions);
  const counts = jobCounts(rows);
  return (
    <section className="assistant" aria-label="Assistant">
      <button className="slist-label slist-fold" aria-expanded={open} onClick={toggle}>
        <span className={"tree-twisty" + (open ? " open" : "")}>›</span>
        {open || !counts ? "Assistant" : `Assistant · ${counts}`}
      </button>
      {open && (
        <>
          <button className="assistant-line" data-session={assistant.name} title={`${sessionTitle(assistant)}\n${assistant.name}`} onClick={() => props.onOpen(assistant.name)}>
            <span className={"srow-mark state-" + assistant.state}>
              <StateMark s={assistant} />
            </span>
            <span className="assistant-title">{sessionTitle(assistant)}</span>
          </button>
          {rows.map((r) => (
            <button
              key={r.session.name}
              className="assistant-line assistant-job"
              data-session={r.session.name}
              title={`${r.project} · ${r.reason}${r.words ? `\n${r.words}` : ""}\n${r.session.name}`}
              onClick={() => props.onOpen(r.session.name)}
            >
              <span className={"srow-mark state-" + r.session.state}>
                <StateMark s={r.session} />
              </span>
              <span className="assistant-text">
                <span className="assistant-title">
                  {r.project} · {r.reason}
                </span>
                {r.words && <span className="assistant-words">{r.words}</span>}
              </span>
            </button>
          ))}
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 4: In every tab's list (`app/src/components/TerminalPane.tsx`)**

After `import { InboxSummary } from "./InboxSummary";`, add:

```tsx
import { AssistantGroup } from "./AssistantGroup";
```

In `TerminalPane`'s props, replace:

```tsx
  // The chevron's "Models and keys…": Settings, at Models.
  onModels: () => void;
  actions: { current: PaneActions };
```

with:

```tsx
  // The chevron's "Models and keys…": Settings, at Models.
  onModels: () => void;
  // A row of the pinned Assistant group: that session, opened where it lives, as ⌘K opens one (App's pickSession).
  onPick: (name: string) => void;
  actions: { current: PaneActions };
```

Replace:

```tsx
        <div className="slist-scroll" ref={scroll}>
          <InboxSummary
```

with:

```tsx
        <div className="slist-scroll" ref={scroll}>
          <AssistantGroup sessions={link.sessions ?? []} onOpen={props.onPick} />
          <InboxSummary
```

In the comment above `export function TerminalPane(props: {`, after the line
`// earlier conversations. Dragging a running session from the list onto a terminal splits it.`, add:

```tsx
// Above them all, in every tab, the assistant and its jobs (AssistantGroup) while it runs.
```

- [ ] **Step 5: Opening them (`app/src/App.tsx`)**

Replace:

```tsx
  const open = (server: string, dir: string | null, session?: string) => {
    setDialog(null);
    if (session) takeSession(`${server}/${session}`);
    setLayout((l) => l && openTab(l, server, dir, session));
    if (dir) void rememberProject(server, dir);
  };
```

with:

```tsx
  const open = (server: string, dir: string | null, session?: string) => {
    setDialog(null);
    if (session) takeSession(`${server}/${session}`);
    setLayout((l) => l && openTab(l, server, dir, session));
    // The assistant's folder isn't a project: opening the assistant (its pinned row, a notification, ⌘K) gives it a
    // tab but never makes it a recent project.
    const assistant = !!session && links.get(server)?.sessions?.find((s) => s.name === session)?.assistant === true;
    if (dir && !assistant) void rememberProject(server, dir);
  };
```

In the `<TerminalPane` element, replace:

```tsx
                onModels={() => {
                  setSettingsAt("models");
                  setDialog("settings");
                }}
                actions={refFor(actions, key, noActions)}
```

with:

```tsx
                onModels={() => {
                  setSettingsAt("models");
                  setDialog("settings");
                }}
                onPick={(n) => void pickSession(l, n)}
                actions={refFor(actions, key, noActions)}
```

- [ ] **Step 6: Settings > Assistant (`app/src/components/SettingsDialog.tsx`)**

Replace:

```tsx
// Settings (⌘,): every change applies at once, in every window, and is kept on this Mac.
// Models is the exception: keys and sign-ins belong to each server, where sessions run.
```

with:

```tsx
// Settings (⌘,): every change applies at once, in every window, and is kept on this Mac.
// Models and Assistant are the exceptions: keys, sign-ins and the assistant belong to each server, where sessions run.
```

Between the Models section and the Updates section, that is after:

```tsx
          {props.links.map((l) => (
            <Models key={l.key} link={l} named={props.links.length > 1} onCodexSignIn={() => props.onCodexSignIn(l)} />
          ))}
        </section>
```

add:

```tsx
        <section aria-label="Assistant">
          <h3>Assistant</h3>
          {props.links.length === 0 && <p className="settings-note">Connect to a server to turn it on.</p>}
          {props.links.map((l) => (
            <Assistant key={l.key} link={l} named={props.links.length > 1} />
          ))}
        </section>
```

Before the comment `// One server's keys and sign-ins. A key typed here is sent once (PUT /keys/zai) and the field`, add:

```tsx
// One server's assistant (PUT /assistant): on, blimpd keeps one Claude chat running that isn't a project; off ends that
// chat, after a question here (not confirm()). The box follows link.assistantOn, which blimpd's events message keeps;
// an older blimpd never sends it, and its server shows nothing here.
function Assistant(props: { link: ServerLink; named: boolean }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const on = props.link.assistantOn;
  if (on === null) return null;
  const turn = (v: boolean) => {
    setAsking(false);
    props.link.setAssistant(v).then(
      () => setError(""),
      (e) => setError(errorText(e)),
    );
  };
  return (
    <div className="models" data-server={props.link.key}>
      {props.named && <h4>{props.link.key}</h4>}
      <Row label="Assistant" note="One Claude chat that isn't a project. It can look at every project and asks before it acts.">
        <input type="checkbox" aria-label="Assistant" checked={on} onChange={(e) => (e.target.checked ? turn(true) : setAsking(true))} />
      </Row>
      {asking && (
        <div className="settings-confirm">
          <span>Turn off the assistant? Its chat ends.</span>
          <button className="danger" onClick={() => turn(false)}>
            Turn Off
          </button>
          <button onClick={() => setAsking(false)}>Cancel</button>
        </div>
      )}
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}

```

- [ ] **Step 7: Styles (`app/src/styles/app.css`)**

After:

```css
.inbox-words {
  color: var(--fg-dim);
}
```

add:

```css

/* The assistant, pinned above the inbox in every tab's list: its row, then its jobs indented under it. */
.assistant {
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line);
}

.assistant-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: 3px 12px;
  text-align: left;
  font-size: 12px;
}

.assistant-line:hover {
  background: var(--hover);
}

.assistant-job {
  padding-left: 30px;
}

.assistant-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.assistant-title,
.assistant-words {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assistant-words {
  color: var(--fg-dim);
}
```

After:

```css
.settings-error {
  margin: 4px 0;
  font-size: 12px;
  color: var(--danger);
}
```

add:

```css

/* Settings > Assistant: Turn Off's question, in place of a confirm() box. */
.settings-confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  font-size: 12px;
}

.settings-confirm span {
  flex: 1;
}

.settings-confirm button {
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 5px;
}

.settings-confirm button.danger {
  color: var(--danger);
}
```

- [ ] **Step 8: Type check, then run the spec to verify it passes**

Run: `cd /Users/mbeato/blimp-assistant/app && PATH=$HOME/.bun/bin:$PATH bun x tsc --noEmit && PATH=$HOME/.bun/bin:$PATH bun run e2e assistant.spec.ts`
Expected: no type errors; 1 passed.

- [ ] **Step 9: Commit**

```bash
cd /Users/mbeato/blimp-assistant && git add app/src/components/AssistantGroup.tsx app/src/components/TerminalPane.tsx app/src/App.tsx app/src/components/SettingsDialog.tsx app/src/styles/app.css app/e2e/assistant.spec.ts && git commit -m "Mac app: the Assistant group pinned at the top of every tab's session list (the assistant, then its jobs; it folds, kept on this computer; a click opens the session as ⌘K does, never keeping the assistant's folder as a recent project), and Settings > Assistant with a question in place before Turn Off"
```

---

### Task 7: Docs

**Files:**
- Modify: `docs/DESIGN.md` (Events; `### Assistant`; "The app" item 5 and Settings)
- Modify: `docs/SECURITY.md` (the phone token's powers)
- Modify: `README.md` (`### The assistant`)
- Modify: `ios/README.md` (a paragraph after the drawer's)
- Modify: `docs/PHONE-CHECKLIST.md` (a section at the end)
- Modify: `docs/superpowers/specs/2026-10-26-assistant-design.md` (status line)

- [ ] **Step 1: DESIGN.md**

In `### Events`, after the bullet that starts `` - `{ "type": "feed", "on": boolean, "unseen": number }` ``, add:

```markdown
- `{ "type": "assistant", "on": boolean }`: whether the assistant is on (see Assistant), sent on connect and within a second of a change (`PUT /assistant`, `blimpd assistant on | off`, or `config.json` edited by hand: blimpd checks every second).
```

In `### Assistant`'s first paragraph, replace:

```markdown
`blimpd assistant on | off | status` sets it (`off` also ends the session; its folder and conversations stay).
```

with:

```markdown
`blimpd assistant on | off | status` sets it, and so does the Assistant switch in either app's Settings (`PUT /assistant`); `off` also ends the session; its folder and conversations stay.
```

Before the line `` - `src/client.ts` is how these reach blimpd: its socket, the Mac's token. ``, insert:

```markdown
- **Switch:** `GET /assistant` → `{ on: boolean, session?: "assistant" }` (`session` while a session of that name runs). `PUT /assistant { on: boolean }` → 204, 400 when `on` isn't true or false; it and `blimpd assistant on | off` both call `setAssistantOn` (off also ends the session). The events socket's `assistant` message says when it changed. The assistant's folder, by its path and its real path, is never in `GET /folders/recent` (nor in `POST /folders/opened`'s answer), so neither app offers it as a project.
- **Apps:** the phone pins the assistant's icon (the blimp, with its session's mark) above the drawer's projects, leaves its session and folder out of the projects (`Drawer.projects`), and opening its chat leaves the project as it was. On top of its chat a jobs bar folds to one line, `1 needs you · 2 working · 1 done`, and unfolds to a row per job (its mark, `project · reason`, what it asks or its note); a row opens that job's chat, whose back arrow says Assistant and goes back to it. The Mac pins an Assistant group above every tab's inbox (The app, item 5). Settings in both has the switch, and turning it off asks first. The jobs' rules are written twice, as the inbox's are (`app/src/lib/assistant.ts`, BlimpKit's `AssistantJobs.swift`, the same tests): needs you (waiting, or done with a `question` note), the oldest wait first; working (working, or done with a `progress` note), the longest first; done (done and unread), the newest first; any other job isn't shown. A job working now shows no words (its note is the turn before's). The widgets and the Dock badge count the assistant like any session.
```

In "The app", item 5, replace:

```markdown
5. **Session list (right of the terminal, 230 px, resizable).** At its top, the project's inbox (Inbox, above), when it has anything:
```

with:

```markdown
5. **Session list (right of the terminal, 230 px, resizable).** At its very top, while the assistant runs, the Assistant group, in every tab's list (`components/AssistantGroup.tsx`): the assistant's row with its mark, then its jobs indented under it (`project · reason`, the job's mark, what it asks or its note; see Assistant). A click opens that session as ⌘K does (in its folder's tab; the assistant's folder gets a tab of its own but never joins the recent projects). It folds to `Assistant · <counts>`, kept on this computer (`blimp.assistantOpen`). Under it, the project's inbox (Inbox, above), when it has anything:
```

After the paragraph that starts `**Settings > Models** (per connected server):`, add a blank line and:

```markdown
**Settings > Assistant** (per connected server whose blimpd has sent the events' `assistant` message): a checkbox that follows that message. On sends `PUT /assistant { on: true }`; off first asks in place ("Turn off the assistant? Its chat ends.", Turn Off and Cancel), then sends `{ on: false }`. The box shows the change at once; an error shows under it.
```

- [ ] **Step 2: SECURITY.md**

In the bullet that starts `- **The phone token can do everything the Mac's can.**`, replace
`A phone that is paired can start, type into and end sessions, start runs,` with
`A phone that is paired can start, type into and end sessions, turn the assistant on or off (`PUT /assistant`), start runs,`.

- [ ] **Step 3: README.md**

In `### The assistant`, replace:

```markdown
The assistant is one Claude chat that isn't tied to a project. Ask it general questions, send it on errands in the browser, or ask what's going on across your projects. It's off until you turn it on, on the server:
```

with:

```markdown
The assistant is one Claude chat that isn't tied to a project. Ask it general questions, send it on errands in the browser, or ask what's going on across your projects. It's off until you turn it on: with the Assistant switch in Settings, in the phone app or the Mac app, or on the server:
```

After the bullet that starts `- When it starts a session or messages one, that session becomes one of its jobs.`, add:

```markdown
- On the phone, it's the blimp at the top of the drawer's column of projects. On top of its chat, a bar counts its jobs (needs you, working, done); tap it to see each one, and tap a job to open it. On the Mac, it's pinned at the top of every session list, with its jobs under it.
```

Replace:

```markdown
- `blimpd assistant off` ends it. Its folder and chats stay, and turning it on again carries on the latest.
```

with:

```markdown
- `blimpd assistant off`, or the switch in Settings (which asks first), ends it. Its folder and chats stay, and turning it on again carries on the latest.
```

- [ ] **Step 4: ios/README.md**

After the paragraph that starts `The drawer on the left (swipe right, or ☰ at the top left of a project's inbox)` (it
ends `Each row shows its branch and background jobs.`), add a blank line and:

```markdown
**The assistant.** While the assistant is on (see the main README), the blimp at the top of the drawer's column, above your projects, opens its chat. It has the usual amber question mark or blue dot. Its folder isn't a project, so it isn't in the column. On top of its chat, a bar counts its jobs, for example `1 needs you · 2 working · 1 done`. Tap it for a row per job: its project, why the assistant started it, and what it asks or its note. A row opens that job's chat, and ‹ Assistant at its top left goes back. Settings has an Assistant switch; turning it off asks first, as it ends the assistant's chat. Its folder and conversations stay.
```

- [ ] **Step 5: PHONE-CHECKLIST.md**

At the end of `docs/PHONE-CHECKLIST.md`, add a blank line and:

```markdown
## Assistant

- [ ] With the assistant off, the drawer's column has no blimp at its top, and Settings > Assistant is off.
- [ ] Settings > Assistant on: within a few seconds the blimp shows at the top of the column, above the projects, with a thin line under it. Its folder (assistant) is not in the column.
- [ ] Tap the blimp: the drawer closes and the assistant's chat opens. ‹ at the top left goes to the same project's inbox as before.
- [ ] Ask it to start something in a project and Allow it. On top of its chat, a folded bar says "1 working". Tap it: a row with the project, the reason, the mark and the note.
- [ ] Tap the row: that session's chat opens, and its top left says ‹ Assistant. Tap it: back in the assistant's chat, the bar folded again.
- [ ] When the job finishes or asks something, the bar's count changes (done, needs you). Opening a done job takes it off the bar.
- [ ] Settings > Assistant off: it asks first ("Turn off the assistant? …"). Cancel keeps it on. Turn Off: the blimp leaves the column within a few seconds.
```

- [ ] **Step 6: The spec's status**

In `docs/superpowers/specs/2026-10-26-assistant-design.md`, replace
`Status: steps 1 and 2 built (plans docs/superpowers/plans/2026-10-26-assistant-part1.md and -part2.md); step 3 (the apps) not yet.`
with
`Status: steps 1-3 built (plans docs/superpowers/plans/2026-10-26-assistant-part1.md, -part2.md and -part3.md).`

- [ ] **Step 7: Check and commit**

Run: `cd /Users/mbeato/blimp-assistant && git diff --stat` — expected: only the six files.

```bash
cd /Users/mbeato/blimp-assistant && git add docs/DESIGN.md docs/SECURITY.md README.md ios/README.md docs/PHONE-CHECKLIST.md docs/superpowers/specs/2026-10-26-assistant-design.md && git commit -m "Docs: the assistant in the apps: GET and PUT /assistant, the events message, the phone's icon and jobs bar and the Mac's group (DESIGN.md), the phone token's reach (SECURITY.md), turning it on from Settings (README), the phone's icon, jobs bar and switch (ios/README, the phone checklist), and the spec's status"
```

---

### Task 8: Final runs

**Files:** none, unless a run finds something; then a fix with its own commit, and the runs again.

- [ ] **Step 1: The server suite**

Run: `cd /Users/mbeato/blimp-assistant && PATH=$HOME/.bun/bin:$PATH bun test`
Expected: 0 fail.

- [ ] **Step 2: The app's lib tests and type check**

Run: `cd /Users/mbeato/blimp-assistant/app && PATH=$HOME/.bun/bin:$PATH bun test src && PATH=$HOME/.bun/bin:$PATH bun x tsc --noEmit`
Expected: 0 fail; no type errors.

- [ ] **Step 3: The app's e2e, all of it**

Run: `cd /Users/mbeato/blimp-assistant/app && PATH=$HOME/.bun/bin:$PATH bun run e2e`
Expected: every spec passes (it uses its own temp blimpd, zmx folder and Claude folder; nothing touches `~/.blimp`).

- [ ] **Step 4: iOS is verified by CI only**

There's no Swift toolchain here. BlimpKit's tests (kit-linux and the Mac), the app's build and the iPhone e2e (with
`testAssistantIconAndJobsBar` in shard a) run in `.github/workflows/ios.yml` when the branch is pushed. The controller
does this, not the implementer: ask Max first in one plain line (for example "ok to push the assistant branch? it starts
the iOS CI on the MacBook"); before pushing, check that no iOS run is in progress or queued
(`gh run list --workflow iOS --limit 5`); only then `git push -u origin assistant`, and watch the run in the background
(`gh run watch <id> --exit-status --interval 30`). Compile errors or failing tests get one fix commit each, then the
same check before the next push.

- [ ] **Step 5: Report**

Lead with the result: the server suite, the app's tests and e2e, and the iOS CI run (or that it waits for Max's OK).
Don't turn the assistant on against the live `~/.blimp`; Max tries it on his phone and Mac with
`docs/PHONE-CHECKLIST.md`'s Assistant section once a build has it.
