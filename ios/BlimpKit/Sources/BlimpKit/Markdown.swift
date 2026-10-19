import Foundation
// Just enough block-level Markdown to show Claude's replies. Inline marks stay in the strings.
public enum MarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullets([String])
    case numbered([String])
    case code(language: String, text: String)
    case quote(String)
    case table(String)
    case rule

    public static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var out: [MarkdownBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.hasPrefix("```") {
                let lang = line.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                i += 1
                while i < lines.count, !lines[i].hasPrefix("```") { body.append(lines[i]); i += 1 }
                i += 1  // the closing fence (or past the end)
                out.append(.code(language: lang, text: body.joined(separator: "\n")))
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                i += 1
            } else if let h = heading(line) {
                out.append(h); i += 1
            } else if ["---", "***", "___"].contains(line.trimmingCharacters(in: .whitespaces)) {
                out.append(.rule); i += 1
            } else if bulletText(line) != nil {
                var items: [String] = []
                while i < lines.count {
                    if let t = bulletText(lines[i]) { items.append(t) }
                    else if lines[i].hasPrefix("  "), !items.isEmpty, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                        items[items.count - 1] += " " + lines[i].trimmingCharacters(in: .whitespaces)
                    } else { break }
                    i += 1
                }
                out.append(.bullets(items))
            } else if numberedText(line) != nil {
                var items: [String] = []
                while i < lines.count, let t = numberedText(lines[i]) { items.append(t); i += 1 }
                out.append(.numbered(items))
            } else if line.hasPrefix(">") {
                var q: [String] = []
                while i < lines.count, lines[i].hasPrefix(">") {
                    var l = lines[i].dropFirst()
                    if l.hasPrefix(" ") { l = l.dropFirst() }
                    q.append(String(l)); i += 1
                }
                out.append(.quote(q.joined(separator: "\n")))
            } else if line.hasPrefix("|") {
                var t: [String] = []
                while i < lines.count, lines[i].hasPrefix("|") { t.append(lines[i]); i += 1 }
                out.append(.table(t.joined(separator: "\n")))
            } else {
                var p: [String] = []
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty, !startsBlock(lines[i]) {
                    p.append(lines[i]); i += 1
                }
                out.append(.paragraph(p.joined(separator: "\n")))
            }
        }
        return out
    }

    // A paragraph ends where any other block starts, even without a blank line between.
    private static func startsBlock(_ l: String) -> Bool {
        l.hasPrefix("```") || heading(l) != nil || bulletText(l) != nil || numberedText(l) != nil
            || l.hasPrefix(">") || l.hasPrefix("|") || ["---", "***", "___"].contains(l.trimmingCharacters(in: .whitespaces))
    }

    private static func heading(_ l: String) -> MarkdownBlock? {
        let hashes = l.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), l.dropFirst(hashes).hasPrefix(" ") else { return nil }
        return .heading(level: hashes, text: l.dropFirst(hashes + 1).trimmingCharacters(in: .whitespaces))
    }

    private static func bulletText(_ l: String) -> String? {
        guard let f = l.first, "-*+".contains(f), l.dropFirst().hasPrefix(" ") else { return nil }
        return String(l.dropFirst(2))
    }

    private static func numberedText(_ l: String) -> String? {
        let digits = l.prefix { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty, l.dropFirst(digits.count).hasPrefix(". ") else { return nil }
        return String(l.dropFirst(digits.count + 2))
    }
}
