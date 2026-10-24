import Foundation
import Testing
@testable import BlimpKit

private func choice(_ pick: Int, _ label: String) -> [String: Any] { ["pick": pick, "label": label] }

@Test func aPermissionsNotificationHasItsSessionTheWaitAndYesAndNo() {
    let info: [AnyHashable: Any] = [
        "aps": ["alert": ["title": "Fix the drawer is waiting", "body": "Run bun test"], "category": "permission"],
        "session": "blimp-1", "kind": "ask", "at": 1_800_000_000_000.0, "yes": choice(0, "Yes"), "no": choice(2, "No"),
    ]
    let note = PushNote(info)
    #expect(note?.session == "blimp-1")
    #expect(note?.kind == .ask)
    #expect(note?.at == 1_800_000_000_000)
    #expect(note?.yes == PushNote.Choice(pick: 0, label: "Yes"))
    #expect(note?.no == PushNote.Choice(pick: 2, label: "No"))
}

@Test func aQuestionOrAFinishHasNoWaitAndNoButtons() {
    let ask = PushNote(["session": "s", "kind": "ask"])
    #expect(ask?.kind == .ask)
    #expect(ask?.at == nil)
    #expect(ask?.yes == nil)
    #expect(ask?.no == nil)
    #expect(PushNote(["session": "s", "kind": "finish"])?.kind == .finish)
}

@Test func halfAPermissionHasNoButtons() {
    let note = PushNote(["session": "s", "kind": "ask", "at": 5, "yes": choice(0, "Yes")])
    #expect(note?.session == "s")
    #expect(note?.at == nil)
    #expect(note?.yes == nil)
    #expect(note?.no == nil)
}

@Test func aNotificationThatIsntBlimpdsIsNone() {
    #expect(PushNote([:]) == nil)
    #expect(PushNote(["session": "s"]) == nil)
    #expect(PushNote(["session": "", "kind": "ask"]) == nil)
    #expect(PushNote(["session": "s", "kind": "other"]) == nil)
    #expect(PushNote(["session": 5, "kind": "ask"]) == nil)
}

@Test func aDeviceTokenIsLowercaseHexTwoDigitsAByte() {
    #expect(DeviceToken.hex(Data([0x00, 0x0f, 0xa5, 0xff])) == "000fa5ff")
    #expect(DeviceToken.hex(Data()) == "")
}
