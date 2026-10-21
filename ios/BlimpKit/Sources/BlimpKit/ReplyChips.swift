// One-tap replies above the input, for when the box is empty and Claude isn't asking anything: the usual
// short answers, or, when Claude's last reply ends in a numbered list (the options it offers), the
// numbers and "all".
import Foundation

public enum ReplyChips {
    public static let defaults = ["go", "continue", "yes go ahead", "status?"]

    /// A list this long or shorter is choices; a longer one is more likely steps or findings.
    static let most = 9
    /// After the list, at most one paragraph this long ("Which one?") still leaves it the reply's end.
    static let tail = 160

    /// The chips for Claude's last reply (Markdown); the defaults without one.
    public static func chips(after reply: String?) -> [String] {
        guard let reply, let list = trailingList(reply) else { return defaults }
        return (list.start..<(list.start + list.count)).map(String.init) + ["all"]
    }

    // The numbered list the reply ends with: its first number and how many items, if 2 to `most`.
    static func trailingList(_ reply: String) -> (start: Int, count: Int)? {
        var blocks = MarkdownBlock.parse(reply)
        if case .paragraph(let p) = blocks.last, p.count <= tail, blocks.count > 1 { blocks.removeLast() }
        guard case .numbered(let start, let items) = blocks.last, (2...most).contains(items.count) else { return nil }
        return (start, items.count)
    }
}
