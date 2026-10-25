// The drawer's column of projects (DrawerView): an icon each, two letters from its folder's name, in the order
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

    /// projects in `order` (their folders, as the drawer came out), then any new since in their own order. `shown`, the
    /// project on screen, goes first instead when it's new since: a folder just opened from the browser. One gone since
    /// is left out. With nothing held yet, they're as they come.
    public static func held(_ projects: [ProjectChoice], order: [String], shown: String? = nil) -> [ProjectChoice] {
        let at = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        let kept = projects.filter { at[$0.dir] != nil }.sorted { at[$0.dir]! < at[$1.dir]! }
        let new = projects.filter { at[$0.dir] == nil }
        guard !order.isEmpty, let shown, new.contains(where: { $0.dir == shown }) else { return kept + new }
        return new.filter { $0.dir == shown } + kept + new.filter { $0.dir != shown }
    }
}
