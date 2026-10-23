import Foundation
import Testing
@testable import BlimpKit

// The drawer's project strip: each project's two letters, and an order that holds while the drawer is open.

private func project(_ dir: String, activity: Double) -> ProjectChoice {
    ProjectChoice(dir: dir, name: Drawer.name(of: dir), mark: .none, activity: activity)
}

@Test func aProjectsLettersAreItsFirstTwoOrTheFirstLettersOfItsFirstTwoWords() {
    #expect(Strip.letters("blimp") == "BL")
    #expect(Strip.letters("characterquilt") == "CH")
    #expect(Strip.letters("brain-memory") == "BM")
    #expect(Strip.letters("my_app") == "MA")
    #expect(Strip.letters("site.v2") == "SV")
    #expect(Strip.letters("two words here") == "TW")
    // a separator first or doubled makes no empty word
    #expect(Strip.letters("-tmp") == "TM")
    #expect(Strip.letters("a--b") == "AB")
    #expect(Strip.letters("x") == "X")
    #expect(Strip.letters("/") == "/")
}

@Test func theStripKeepsTheOrderItOpenedWithWhileActivityChanges() {
    let order = ["/a", "/b", "/c"]
    // /c gets the newest activity while the drawer is open: it stays where it was
    let now = [project("/c", activity: 9), project("/a", activity: 3), project("/b", activity: 2)]
    #expect(Strip.held(now, order: order).map(\.dir) == ["/a", "/b", "/c"])
    // a project new since goes last; one gone since is left out
    let later = [project("/d", activity: 10), project("/c", activity: 9), project("/a", activity: 3)]
    #expect(Strip.held(later, order: order).map(\.dir) == ["/a", "/c", "/d"])
    // nothing held yet: as they come
    #expect(Strip.held(now, order: []).map(\.dir) == ["/c", "/a", "/b"])
}
