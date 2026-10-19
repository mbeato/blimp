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

@Test func decodesChatEvents() {
    let h = ChatEvent.decode(Data(#"{"type":"history","messages":[{"id":"u1","at":1,"role":"user","text":"hi"},{"id":"a#0","at":2,"role":"tool","name":"Bash","summary":"Ran `ls`","input":"ls"}]}"#.utf8))
    guard case .history(let m) = h else { Issue.record("not history: \(h)"); return }
    #expect(m.map(\.id) == ["u1", "a#0"])
    #expect(m[1].role == .tool && m[1].summary == "Ran `ls`")
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
    #expect(try s(.answer(id: "a1", at: 5, pick: 2)) == #"{"at":5,"id":"a1","pick":2,"type":"answer"}"#)
    #expect(try s(.interrupt(id: "i1")) == #"{"id":"i1","type":"interrupt"}"#)
}
