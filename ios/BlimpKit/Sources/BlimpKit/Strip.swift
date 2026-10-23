// The drawer's strip of projects (DrawerView): an icon each, two letters from its folder's name, in the order
// the drawer came out with, so an icon never moves under a finger while it's open.
import Foundation

public enum Strip {
    /// Two capital letters for a project's name: the first letters of its first two words when it has words
    /// split by "-", "_", "." or a space ("brain-memory" → "BM"), else its first two letters ("blimp" → "BL").
    public static func letters(_ name: String) -> String {
        let words = name.split(whereSeparator: { "-_. ".contains($0) })
        if words.count >= 2 { return (words[0].prefix(1) + words[1].prefix(1)).uppercased() }
        return String((words.first ?? Substring(name)).prefix(2)).uppercased()
    }

    /// projects in `order` (their folders, as the drawer came out), then any new since in their own order. One
    /// gone since is left out.
    public static func held(_ projects: [ProjectChoice], order: [String]) -> [ProjectChoice] {
        let at = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        let kept = projects.filter { at[$0.dir] != nil }.sorted { at[$0.dir]! < at[$1.dir]! }
        return kept + projects.filter { at[$0.dir] == nil }
    }
}
