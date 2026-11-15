import Foundation
import Testing
@testable import BlimpKit

@Test func aPhotoIsScaledSoItsLongSideIsAtMost2048() {
    #expect(Attach.photoSize(width: 4032, height: 3024) == (2048, 1536))
    #expect(Attach.photoSize(width: 3024, height: 4032) == (1536, 2048))
    // Never made larger, and a size already at the limit stays.
    #expect(Attach.photoSize(width: 800, height: 600) == (800, 600))
    #expect(Attach.photoSize(width: 2048, height: 2048) == (2048, 2048))
    // A very long picture keeps at least a pixel of its short side.
    #expect(Attach.photoSize(width: 100_000, height: 10) == (2048, 1))
    #expect(Attach.photoSize(width: 0, height: 0) == (1, 1))
    #expect(Attach.photoSize(width: 1000, height: 500, maxSide: 100) == (100, 50))
}

@Test func anUploadsNameIsOnePlainWordWithItsTime() {
    let zone = TimeZone(identifier: "America/New_York")!
    // 2026-11-15 22:41:07 in New York.
    let date = Date(timeIntervalSince1970: 1_794_800_467)
    #expect(Attach.name(.photo, at: date, in: zone) == "Photo-2026-11-15-at-22.41.07.jpg")
    #expect(Attach.name(.video, at: date, in: zone) == "Video-2026-11-15-at-22.41.07.mp4")
    #expect(Attach.name(.photo, at: Date(timeIntervalSince1970: 1_767_243_845), in: TimeZone(identifier: "UTC")!) == "Photo-2026-01-01-at-05.04.05.jpg")
    // Nothing blimpd's plain names would change.
    #expect(Attach.name(.video, at: date, in: zone).range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil)
}

@Test func aMessageWithFilesIsWaitedForLonger() {
    #expect(Attach.patience(files: 0) == 10)
    #expect(Attach.patience(files: 1) == 13)
    #expect(Attach.patience(files: Attach.maxFiles) == 40)
    #expect(Attach.patience(files: -1) == 10)
}

@Test func decodesTheFilesYouSent() {
    let e = ChatEvent.decode(Data(#"{"type":"append","messages":[{"id":"m#0","at":5,"role":"file","file":"/home/u/.blimp/uploads/Photo-1.jpg","name":"Photo-1.jpg","image":true,"summary":"Sent Photo-1.jpg"},{"id":"u1f0","at":6,"role":"file","file":"/home/u/.blimp/uploads/Video-1.mp4","name":"Video-1.mp4","summary":"Sent Video-1.mp4","gone":true}]}"#.utf8))
    guard case .append(let m) = e else { Issue.record("not append: \(e)"); return }
    #expect(m.map(\.role) == [.file, .file])
    #expect(m[0].file == "/home/u/.blimp/uploads/Photo-1.jpg" && m[0].name == "Photo-1.jpg" && m[0].image == true && m[0].gone == nil)
    #expect(m[1].image == nil && m[1].gone == true)
    // In the chat, and no tool step.
    var log = ChatLog()
    log.apply(.history(m))
    #expect(log.shown.map(\.id) == ["m#0", "u1f0"])
}
