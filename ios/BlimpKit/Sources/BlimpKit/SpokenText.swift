import Foundation

/// Turns a Markdown reply into text that is fine to read aloud: no code, no marks, short paths.
public enum SpokenText {
    public static func from(markdown: String) -> String {
        var sentences: [String] = []
        func add(_ s: String) {
            let t = collapse(s)
            guard !t.isEmpty else { return }
            sentences.append(endsSentence(t) ? t : t + ".")
        }
        for block in MarkdownBlock.parse(markdown) {
            switch block {
            case .paragraph(let t), .quote(let t): add(inline(t))
            case .heading(_, let t): add(inline(t))
            case .bullets(let items), .numbered(let items): items.forEach { add(inline($0)) }
            case .code, .table: sentences.append("code skipped.")
            case .rule: break
            }
        }
        return sentences.joined(separator: " ")
    }

    static func collapse(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func endsSentence(_ s: String) -> Bool {
        guard let c = s.last else { return true }
        return ".!?:".contains(c)
    }

    private static func replace(_ s: String, _ pattern: String, _ template: String) -> String {
        s.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
    }

    // Inline code is cut out first so nothing inside it is touched; the text between is cleaned.
    private static func inline(_ s: String) -> String {
        let parts = s.components(separatedBy: "`")
        var out = ""
        for (i, part) in parts.enumerated() {
            if i % 2 == 1 && i < parts.count - 1 {
                out += part.count > 40 ? "code skipped" : part
            } else {
                out += plain(i % 2 == 1 ? "`" + part : part)
            }
        }
        return out
    }

    private static func plain(_ s: String) -> String {
        var t = replace(s, #"\[([^\]]*)\]\([^)]*\)"#, "$1")
        t = replace(t, #"https?://\S*[^\s.,;:!?)]"#, "link")
        t = t.replacingOccurrences(of: "*", with: "")
        t = replace(t, #"(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])"#, "")
        t = replace(t, #"(?:[\w.~-]*/){3,}([\w.~-]+)"#, "$1")
        return t
    }
}
