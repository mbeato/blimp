import Foundation
import Testing
@testable import BlimpKit

// The phone's folder browser: what a folder shows, New Folder's names, and the path under the title.

private func entry(_ name: String, _ kind: String) -> DirEntry { DirEntry(name: name, kind: kind, size: 0, mtime: 0) }

@Test func aFolderListingDecodes() throws {
    let json = #"{"path":"/Users/max/code","entries":[{"name":"blimp","kind":"dir","size":4096,"mtime":1729850000000},{"name":"a.txt","kind":"file","size":3,"mtime":1}]}"#
    let listing = try JSONDecoder().decode(DirListing.self, from: Data(json.utf8))
    #expect(listing.path == "/Users/max/code")
    #expect(listing.entries.map(\.isFolder) == [true, false])
}

@Test func aFolderShowsItsFoldersThenItsFilesAndNothingStartingWithADot() {
    let shown = Folders.shown([entry(".config", "dir"), entry("api", "dir"), entry("blimp", "dir"), entry(".zshrc", "file"), entry("notes.txt", "file")])
    #expect(shown.folders.map(\.name) == ["api", "blimp"])
    #expect(shown.files.map(\.name) == ["notes.txt"])
}

@Test func newFolderRefusesASlashAndTheDotNames() {
    #expect(Folders.nameProblem("my-app") == nil)
    // empty: nothing to make, so nothing to say
    #expect(Folders.nameProblem("") == nil)
    #expect(Folders.nameProblem("a/b") == "A name can't contain / or be . or ..")
    #expect(Folders.nameProblem(".") != nil)
    #expect(Folders.nameProblem(" .. ") != nil)
    #expect(Folders.nameProblem(".hidden") == nil)
}

@Test func thePathUnderTheTitleSaysTildeForHome() {
    #expect(Folders.label(path: "/Users/max", home: "/Users/max") == "~")
    #expect(Folders.label(path: "/Users/max/code/app", home: "/Users/max") == "~/code/app")
    // only the home folder itself, not one whose name starts the same
    #expect(Folders.label(path: "/Users/maxine", home: "/Users/max") == "/Users/maxine")
}
