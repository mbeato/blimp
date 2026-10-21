import Foundation
import Testing
@testable import BlimpKit

// The same cases as the Mac's (app/src/lib/inbox.test.ts).

private func s(_ name: String, state: SessionState = .done, updated: Double = 1000, unread: Bool? = nil, prompt: Prompt? = nil,
               note: Note? = nil) -> Session {
    var x = Session(name: name, created: 1, dir: "/p", kind: "claude", label: nil, sessionId: name + "-id", title: name.uppercased(),
                    updatedAt: updated, state: state, stateSince: nil, prompt: prompt, unread: unread)
    x.note = note
    return x
}

private func c(_ id: String, updated: Double = 500, unread: Bool? = nil, note: Note? = nil) -> Conversation {
    Conversation(sessionId: id, title: id.uppercased(), updatedAt: updated, unread: unread, note: note)
}

private func n(_ status: NoteStatus, _ text: String) -> Note { Note(status: status, text: text, at: 1) }

private func permission(_ summary: String) -> Prompt {
    Prompt(kind: .permission, at: 1, answerable: true, tool: "Bash", summary: summary, options: ["Yes", "No"], questions: nil)
}

private func question(_ q: String) -> Prompt {
    Prompt(kind: .question, at: 1, answerable: true, tool: nil, summary: nil, options: nil,
           questions: [Question(question: q, header: nil, multiSelect: false, options: [])])
}

private func lines(_ l: [InboxLine]) -> [String] { l.map { "\($0.title): \($0.words ?? "")" } }

@Test func waitingOnYouIsASessionThatWaitsWithWhatItAsksOrOneDoneWithAQuestionNote() {
    let i = Inbox(dir: "/p", sessions: [
        s("perm", state: .waiting, prompt: permission("Ran `bun test`"), note: n(.done, "old")),
        s("ask", state: .waiting, prompt: question("Which layout?")),
        s("other", state: .waiting, prompt: Prompt(kind: .other, at: 1, answerable: false, tool: nil, summary: nil, options: nil, questions: nil),
          note: n(.question, "release it?")),
        s("prose", note: n(.question, "ship v0.2.16?")),
    ], earlier: [])
    #expect(lines(i.waiting) == ["PERM: Ran `bun test`", "ASK: Which layout?", "OTHER: release it?", "PROSE: ship v0.2.16?"])
}

/// Work still going on is under Working, the longest-running first; a turn done mid-way (a progress note), even
/// unread, isn't news yet and folds with the project's other sessions.
@Test func workStillGoingOnIsUnderWorkingLongestFirstAndATurnDoneMidWayFolds() {
    let busy = Session(name: "busy", created: 1, dir: "/p", kind: "claude", label: nil, sessionId: "b", title: "BUSY", updatedAt: 9000,
                   state: .working, stateSince: 5000, prompt: nil, unread: true)
    let older = Session(name: "older", created: 1, dir: "/p", kind: "claude", label: nil, sessionId: "o", title: "OLDER", updatedAt: 9500,
                        state: .working, stateSince: 2000, prompt: nil)
    let i = Inbox(dir: "/p", sessions: [busy, older, s("part", unread: true, note: n(.progress, "fixing a flaky test"))], earlier: [])
    #expect(i.working.map(\.id) == ["session-older", "session-busy"])
    #expect(i.working.map(\.since) == [2000, 5000])
    #expect(i.other.map(\.id) == ["session-part"])
    #expect(i.waiting.isEmpty && i.done.isEmpty)
}

/// Shells, runs and sessions already read fold as the project's other sessions, newest first.
@Test func shellsRunsAndReadSessionsFoldAsOtherNewestFirst() {
    let sh = Session(name: "sh", created: 1, dir: "/p", kind: "shell", label: nil, sessionId: nil, title: "zsh", updatedAt: 3000,
                     state: .unknown, stateSince: nil, prompt: nil)
    let i = Inbox(dir: "/p", sessions: [s("read", updated: 2000, unread: false), sh], earlier: [])
    #expect(i.other.map(\.id) == ["session-sh", "session-read"])
    #expect(i.other.map(\.words) == [nil, nil])
}

@Test func doneIsASessionDoneAndUnreadWithItsNote() {
    let i = Inbox(dir: "/p", sessions: [s("new", unread: true, note: n(.done, "v0.2.16 out")), s("read", unread: false, note: n(.done, "x")),
                                        s("bare", unread: true)], earlier: [])
    #expect(lines(i.done) == ["NEW: v0.2.16 out", "BARE: "])
}

@Test func earlierConversationsOnlyUnreadUnderTheHeadingTheirNoteGives() {
    let i = Inbox(dir: "/p", sessions: [], earlier: [
        c("a", unread: true, note: n(.done, "fixed")), c("b", unread: true, note: n(.progress, "half way")),
        c("q", unread: true, note: n(.question, "which?")), c("d", unread: false, note: n(.done, "x")), c("e", unread: true),
    ])
    #expect(lines(i.waiting) == ["Q: which?"])
    #expect(lines(i.done) == ["A: fixed", "E: "])
}

@Test func newestFirstAndOnlyThisProjectAndNotAConversationARunningSessionHasOpen() {
    let other = Session(name: "elsewhere", created: 1, dir: "/q", kind: "claude", label: nil, sessionId: "x", title: "X", updatedAt: 2000,
                    state: .done, stateSince: nil, prompt: nil, unread: true)
    let i = Inbox(dir: "/p", sessions: [s("old", updated: 100_000, unread: true), s("newer", updated: 900_000, unread: true), other],
                  earlier: [c("mid", updated: 500_000, unread: true), c("newer-id", updated: 2_000_000, unread: true)])
    #expect(i.done.map(\.id) == ["session-newer", "past-mid", "session-old"])
    #expect(!i.isEmpty)
    #expect(Inbox(dir: "/p", sessions: [other], earlier: []).isEmpty)
}

@Test func decodesNotes() throws {
    let data = Data(#"{"sessionId":"a","title":"A","updatedAt":1,"unread":true,"note":{"status":"progress","text":"half way","at":2}}"#.utf8)
    let conv = try JSONDecoder().decode(Conversation.self, from: data)
    #expect(conv.note == Note(status: .progress, text: "half way", at: 2))
    let odd = try JSONDecoder().decode(Note.self, from: Data(#"{"status":"later","text":"x","at":1}"#.utf8))
    #expect(odd.status == .done)
}

@Test func aDigestsLinksNameItsSessions() {
    let d = Digest(text: "[The login fix](1) needs you; [the limiter](2) is still going, and [x](9) is gone.", sessions: ["s1", "s2"], at: 1)
    #expect(d.parts == [
        .init(text: "The login fix", session: "s1"), .init(text: " needs you; ", session: nil),
        .init(text: "the limiter", session: "s2"), .init(text: " is still going, and ", session: nil),
        .init(text: "x", session: nil), .init(text: " is gone.", session: nil),
    ])
    #expect(Digest(text: "No links [here] (1).", sessions: ["s1"], at: 1).parts == [.init(text: "No links [here] (1).", session: nil)])
}

@Test func theSessionsEventCarriesEachFoldersDigest() {
    let data = Data(#"{"type":"sessions","sessions":[],"digests":{"/p":{"text":"[A](1) is done.","sessions":["s1"],"at":5},"/bad":{"text":1}}}"#.utf8)
    #expect(EventsMessage.digests(data) == ["/p": Digest(text: "[A](1) is done.", sessions: ["s1"], at: 5)])
    #expect(EventsMessage.digests(Data(#"{"type":"sessions","sessions":[]}"#.utf8)) == [:])
}
