import Foundation
import Testing
@testable import BlimpKit

// What blimpd sends on /events for the server browser's tabs, and on a tab's live view.
let browserTabs = #"""
{"type":"browser","tabs":[
{"id":"A1","folder":"/home/u/web","url":"http://localhost:3000/","title":"Web","openedBy":"web-1"},
{"id":"B2","folder":"/home/u/web","url":"https://github.com/x/y/pulls","title":""},
{"id":"C3","folder":"/home/u/api","url":"about:blank","title":"","bad":1},
{"folder":"/home/u/web"}
]}
"""#

@Test func eventsCarryTheBrowsersTabs() {
    guard case .browser(let tabs) = EventsMessage.decode(Data(browserTabs.utf8)) else { Issue.record("not a browser message"); return }
    // A malformed one is left out, not the whole list.
    #expect(tabs.map(\.id) == ["A1", "B2", "C3"])
    #expect(tabs[0] == BrowserTab(id: "A1", folder: "/home/u/web", url: "http://localhost:3000/", title: "Web", openedBy: "web-1"))
    #expect(tabs[0].label == "Web")
    // No title yet: the address's host.
    #expect(tabs[1].label == "github.com")
    #expect(tabs[1].openedBy == nil)
    #expect(BrowserTab.inFolder(tabs, "/home/u/web").map(\.id) == ["A1", "B2"])
}

@Test func sessionsStillDecode() {
    #expect(EventsMessage.decode(Data(#"{"type":"sessions","sessions":[]}"#.utf8)) == .sessions([]))
    #expect(EventsMessage.decode(Data(#"{"type":"ports","ports":[]}"#.utf8)) == .other)
}

@Test func typedAddressesFollowTheMacsRules() {
    #expect(BrowserAddress.typed("  ") == nil)
    #expect(BrowserAddress.typed("https://a.com/x") == "https://a.com/x")
    #expect(BrowserAddress.typed("localhost:3000/x") == "http://localhost:3000/x")
    #expect(BrowserAddress.typed("127.0.0.1") == "http://127.0.0.1")
    #expect(BrowserAddress.typed("devbox:8080") == "http://devbox:8080")
    #expect(BrowserAddress.typed("example.com") == "https://example.com")
    #expect(BrowserAddress.typed("how do i") == "https://www.google.com/search?q=how%20do%20i")
    #expect(BrowserAddress.typed("mailto:a@b.c") == "https://www.google.com/search?q=mailto%3Aa%40b.c")
    #expect(BrowserAddress.typed("swift") == "https://www.google.com/search?q=swift")
    #expect(BrowserAddress.host(of: "http://localhost:3000/a") == "localhost:3000")
    #expect(BrowserAddress.host(of: "nonsense") == "nonsense")
}

private func json(_ c: BrowserCommand) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(c)) as! [String: Any]
}

@Test func commandsAreWhatTheViewReads() throws {
    let size = try json(.size(width: 390, height: 700))
    #expect(size["type"] as? String == "size" && size["width"] as? Int == 390 && size["height"] as? Int == 700)
    #expect(size["scale"] as? Double == 2 && size["mobile"] as? Bool == true)

    let touch = try json(.touch(.move, [TouchPoint(x: 10.5, y: 20, id: 3)]))
    #expect(touch["type"] as? String == "touch" && touch["event"] as? String == "touchMove")
    let points = touch["points"] as? [[String: Any]]
    #expect(points?.first?["x"] as? Double == 10.5 && points?.first?["id"] as? Int == 3)
    #expect(try json(.touch(.end, []))["event"] as? String == "touchEnd")

    #expect(try json(.text("hé")) as NSDictionary == ["type": "text", "text": "hé"])
    #expect(try json(.go("https://a.com")) as NSDictionary == ["type": "go", "url": "https://a.com"])
    #expect(try json(.nav(.back)) as NSDictionary == ["type": "nav", "action": "back"])
    #expect(try json(.ack) as NSDictionary == ["type": "ack"])
    #expect(try json(.dialog(accept: true, text: "x")) as NSDictionary == ["type": "dialog", "accept": true, "text": "x"])
    #expect(try json(.dialog(accept: false, text: nil)) as NSDictionary == ["type": "dialog", "accept": false])

    // A key is pressed and let go; Enter types a return.
    let enter = try BrowserCommand.press(.enter).map(json)
    #expect(enter.map { $0["event"] as? String } == ["keyDown", "keyUp"])
    #expect(enter[0]["key"] as? String == "Enter" && enter[0]["keyCode"] as? Int == 13 && enter[0]["text"] as? String == "\r")
    let back = try BrowserCommand.press(.backspace).map(json)
    #expect(back[0]["key"] as? String == "Backspace" && back[0]["keyCode"] as? Int == 8 && back[0]["text"] == nil)
}

@Test func eventsFromTheView() {
    func decode(_ s: String) -> BrowserEvent { BrowserEvent.decode(Data(s.utf8)) }
    #expect(decode(#"{"type":"frame","width":390,"height":700}"#) == .frame(width: 390, height: 700))
    #expect(decode(#"{"type":"info","url":"https://a.com/","title":"A","loading":true,"canGoBack":true,"canGoForward":false}"#)
        == .info(BrowserInfo(url: "https://a.com/", title: "A", loading: true, canGoBack: true, canGoForward: false)))
    #expect(decode(#"{"type":"dialog","kind":"prompt","message":"Name?","defaultPrompt":"x"}"#) == .dialog(BrowserDialog(kind: "prompt", message: "Name?", defaultPrompt: "x")))
    #expect(decode(#"{"type":"dialog-closed"}"#) == .dialogClosed)
    #expect(decode(#"{"type":"focus","editable":true}"#) == .focus(editable: true))
    #expect(decode(#"{"type":"copied","text":"x"}"#) == .other)
    #expect(decode("not json") == .other)
}

@Test func fingersLandOnThePageAsDrawn() {
    // The phone owns the size: the page is drawn at its own size.
    #expect(PageFit.scale(pageWidth: 390, viewWidth: 390) == 1)
    // Another screen (the Mac) set it: the page is scaled to fit the width, and a finger maps back.
    let k = PageFit.scale(pageWidth: 800, viewWidth: 400)
    #expect(k == 0.5)
    #expect(PageFit.toPage(x: 100, y: 50, scale: k) == TouchPoint(x: 200, y: 100, id: 0))
    // Nothing drawn yet.
    #expect(PageFit.scale(pageWidth: nil, viewWidth: 400) == 1)
    #expect(PageFit.scale(pageWidth: 0, viewWidth: 400) == 1)
}

@Test func sendToSessionNamesTheTab() {
    #expect(BrowserTab.mention(title: "Web\napp", url: "http://localhost:3000/") == #"Browser tab "Web app" http://localhost:3000/ "#)
}
