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
