import Foundation
import Testing
@testable import BlimpKit

@Test func decodesVisualMessages() {
    let e = ChatEvent.decode(Data(#"{"type":"append","messages":[{"id":"a#0","at":5,"role":"visual","title":"Test results","visual":"0123456789ab","summary":"Showed Test results"},{"id":"b#0","at":6,"role":"visual","title":"Old","visual":"00000000ffff","summary":"Showed Old","gone":true}]}"#.utf8))
    guard case .append(let m) = e else { Issue.record("not append: \(e)"); return }
    #expect(m.map(\.role) == [.visual, .visual])
    #expect(m[0].title == "Test results" && m[0].visual == "0123456789ab" && m[0].gone == nil)
    #expect(m[1].gone == true)
}

@Test func aVisualShowsInTheChatAndIsNoToolStep() {
    let visual = ChatMessage(id: "v#0", at: 2, role: .visual, text: nil, name: nil, summary: "Showed Runs", input: nil, output: nil, error: nil,
                             title: "Runs", visual: "0123456789ab")
    let step = ChatMessage(id: "t#0", at: 1, role: .tool, text: nil, name: "Bash", summary: "Ran `ls`", input: "ls", output: nil, error: nil)
    var log = ChatLog()
    log.apply(.history([step, visual]))
    #expect(log.shown.map(\.id) == ["v#0"])
    #expect(log.latestStep?.id == "t#0")
}

@Test func aVisualsPageIsTheServerTheKeyAndTheId() {
    let key = String(repeating: "ab", count: 32)
    let server = URL(string: "https://box.tail1234.ts.net")!
    #expect(VisualLink.page(server: server, key: key, id: "0123456789ab")?.absoluteString == "https://box.tail1234.ts.net/visuals/\(key)/0123456789ab")
    #expect(VisualLink.page(server: URL(string: "https://box.tail1234.ts.net/")!, key: key, id: "0123456789ab")?.absoluteString
        == "https://box.tail1234.ts.net/visuals/\(key)/0123456789ab")
    #expect(VisualLink.page(server: server, key: key, id: "../../token") == nil)
    #expect(VisualLink.page(server: server, key: key, id: "0123456789AB") == nil)
    #expect(VisualLink.page(server: server, key: "nope", id: "0123456789ab") == nil)
}
