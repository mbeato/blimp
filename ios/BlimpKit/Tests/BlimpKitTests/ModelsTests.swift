import Foundation
import Testing
@testable import BlimpKit

let sessionJSON = """
{"name":"blimp-120301","pid":7,"clients":1,"created":1792445000,"dir":"/home/u/blimp","cmd":"claude","kind":"claude",
 "sessionId":"66bbb378-8c7d-45cc-ac77-41d3bfa10bf0","title":"Fix the tests","status":"waiting","updatedAt":1792445820000,
 "state":"waiting","stateSince":1792445820487,
 "prompt":{"kind":"permission","tool":"Bash","summary":"Ran `bun test`","options":["Yes","No"],"keys":["1","\\u001b"],"answerable":true,"at":1792445820487}}
"""

@Test func decodesASessionWithAPrompt() throws {
    let s = try JSONDecoder().decode(Session.self, from: Data(sessionJSON.utf8))
    #expect(s.name == "blimp-120301")
    #expect(s.state == .waiting)
    #expect(s.isClaude)
    #expect(s.prompt?.kind == .permission)
    #expect(s.prompt?.choices == ["Yes", "No"])
    #expect(s.prompt?.at == 1792445820487)
    #expect(s.activity == 1792445820487)
}

@Test func unknownStatesAndKindsDontFailDecoding() throws {
    let json = #"{"name":"x","created":1,"dir":"/","kind":"codex","title":"t","state":"sleeping","prompt":{"kind":"poll","answerable":false,"at":1}}"#
    let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    #expect(s.state == .unknown)
    #expect(s.prompt?.kind == .other)
    #expect(!s.isClaude)
}

@Test func questionChoicesAreTheFirstQuestionsLabels() throws {
    let json = #"{"kind":"question","answerable":true,"at":5,"questions":[{"question":"Color?","multiSelect":false,"options":[{"label":"Red","description":"r"},{"label":"Green"}]}]}"#
    let p = try JSONDecoder().decode(Prompt.self, from: Data(json.utf8))
    #expect(p.choices == ["Red", "Green"])
    #expect(p.questions?.first?.options.first?.description == "r")
}

@Test func decodesAFolderTrustPrompt() throws {
    let json = #"{"name":"blimp-1","created":1792445000,"dir":"/home/u/blimp","kind":"claude","title":"(new session)","state":"waiting","stateSince":1792445000000,"prompt":{"kind":"trust","folder":"/home/u/blimp","options":["Yes, I trust this folder","No, exit"],"answerable":true,"at":1792445000000}}"#
    let s = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
    #expect(s.state == .waiting)
    #expect(!s.isClaude)
    let p = try #require(s.prompt)
    #expect(p.kind == .trust)
    #expect(p.folder == "/home/u/blimp")
    #expect(p.at == 1792445000000)
    #expect(p.choices == ["Yes, I trust this folder", "No, exit"])
    #expect(p.singleChoice)
    #expect(p.spoken == "Claude Code asks if you trust the folder blimp. Yes or no?")
    #expect(VoiceAnswer.match("yes", choices: p.choices) == .clear(0))
    #expect(VoiceAnswer.match("no", choices: p.choices) == .clear(1))
    // Without its folder it still decodes and reads
    let bare = try JSONDecoder().decode(Prompt.self, from: Data(#"{"kind":"trust","options":["Yes, I trust this folder","No, exit"],"answerable":true,"at":1}"#.utf8))
    #expect(bare.folder == nil)
    #expect(bare.spoken == "Claude Code asks if you trust the folder. Yes or no?")
}

@Test func decodesChatEvents() {
    let h = ChatEvent.decode(Data(#"{"type":"history","messages":[{"id":"u1","at":1,"role":"user","text":"hi"},{"id":"a#0","at":2,"role":"tool","name":"Bash","summary":"Ran `ls`","input":"ls"}]}"#.utf8))
    guard case .history(let m) = h else { Issue.record("not history: \(h)"); return }
    #expect(m.map(\.id) == ["u1", "a#0"])
    #expect(m[1].role == .tool && m[1].summary == "Ran `ls`")
    let c = ChatEvent.decode(Data(#"{"type":"append","messages":[{"id":"c1","at":3,"role":"compacted"}]}"#.utf8))
    guard case .append(let cm) = c else { Issue.record("not append: \(c)"); return }
    #expect(cm.map(\.role) == [.compacted])
    #expect(ChatEvent.decode(Data(#"{"type":"reset"}"#.utf8)) == .reset)
    #expect(ChatEvent.decode(Data(#"{"type":"unreadable"}"#.utf8)) == .unreadable)
    #expect(ChatEvent.decode(Data(#"{"type":"ack","id":"m1"}"#.utf8)) == .ack(id: "m1"))
    #expect(ChatEvent.decode(Data(#"{"type":"error","id":"m1","error":"the question changed"}"#.utf8)) == .failed(id: "m1", error: "the question changed"))
    #expect(ChatEvent.decode(Data("nope".utf8)) == .other)
}

@Test func decodesTheSessionsEventAndIgnoresOthers() {
    let m = EventsMessage.decode(Data("{\"type\":\"sessions\",\"sessions\":[\(sessionJSON)]}".utf8))
    guard case .sessions(let list) = m else { Issue.record("not sessions"); return }
    #expect(list.count == 1)
    #expect(EventsMessage.decode(Data(#"{"type":"ports","ports":[]}"#.utf8)) == .other)
}

@Test func encodesCommandsExactly() throws {
    let enc = JSONEncoder()
    enc.outputFormatting = .sortedKeys
    let s = { (c: ChatCommand) in String(decoding: try enc.encode(c), as: UTF8.self) }
    #expect(try s(.input(id: "m1", text: "hi")) == #"{"id":"m1","text":"hi","type":"input"}"#)
    #expect(try s(.answer(id: "a1", at: 5, pick: 2, label: "No")) == #"{"at":5,"id":"a1","label":"No","pick":2,"type":"answer"}"#)
    #expect(try s(.interrupt(id: "i1")) == #"{"id":"i1","type":"interrupt"}"#)
    #expect(try s(.dismiss(id: "d1", at: 5)) == #"{"at":5,"id":"d1","type":"interrupt"}"#)
}

@Test func aMalformedSessionIsDroppedNotTheWholeList() {
    let good = #"{"name":"a","created":1,"dir":"/","kind":"claude","title":"t","state":"done"}"#
    let bad = #"{"name":"b","created":1,"dir":"/","kind":"claude","state":"done"}"#
    let m = EventsMessage.decode(Data(#"{"type":"sessions","sessions":[\#(good),\#(bad)]}"#.utf8))
    guard case .sessions(let s) = m else { Issue.record("not sessions: \(m)"); return }
    #expect(s.map(\.name) == ["a"])
}

@Test func decodesAppend() {
    let e = ChatEvent.decode(Data(#"{"type":"append","messages":[{"id":"u2","at":3,"role":"user","text":"yo"}]}"#.utf8))
    guard case .append(let m) = e else { Issue.record("not append: \(e)"); return }
    #expect(m.map(\.id) == ["u2"])
}
