// Commands Claude hands over in a reply, for the Run button: blimpd's rules (src/runnable.ts, the same
// cases in the tests), so the phone and blimpd agree on what a command is. A command is a fenced code block
// marked bash, sh, shell, zsh or console (the whole block; if it shows "$ " prompts, only the prompted lines,
// prompts taken off, as the rest is their output), or inline code that starts with a command word
// (`bun test`) or with "! " (any command), one line each. A bare `cd <dir>` isn't one. Newest first, at
// most 5, each at most 4000 characters.
// blimpd runs only a command it listed itself (Session.runnable, the latest reply's), so a code block gets a
// Run button only when its command is in that list (`offered`).
import Foundation

public enum RunnableCommand {
    static let langs = ["bash", "sh", "shell", "zsh", "console"]
    static let words = ["bash", "sh", "zsh", "python", "python3", "node", "bun", "npx", "npm", "cd"]
    static let most = 5
    static let longest = 4000

    /// A reply's commands, newest first, as blimpd lists them. texts: the reply's text blocks, oldest first.
    public static func all(in texts: [String]) -> [String] {
        var seen = Set<String>()
        let found = texts.flatMap(commands).reversed().filter { $0.utf16.count <= longest && seen.insert($0).inserted }
        return Array(found.prefix(most))
    }

    /// The command a code block (MarkdownBlock.code) offers, nil if none. language: the text after its fence.
    public static func block(language: String, text: String) -> String? {
        let lang = String(language.prefix { $0.isASCII && ($0.isLetter || $0.isNumber || "_+-".contains($0)) })
        guard let c = blockCommand(lang: lang, lines: text.components(separatedBy: "\n")), c.utf16.count <= longest else { return nil }
        return c
    }

    /// The block's command when blimpd offers it for the latest reply (runnable: Session.runnable), else nil.
    public static func offered(language: String, text: String, runnable: [String]?) -> String? {
        guard let c = block(language: language, text: text), runnable?.contains(c) == true else { return nil }
        return c
    }

    /// A command on one line, for a button: its lines joined with ⏎.
    public static func oneLine(_ command: String) -> String {
        command.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ⏎ ")
    }

    // One text's commands, in the order they appear.
    static func commands(_ text: String) -> [String] {
        var out: [String] = []
        let lines = text.components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            guard let open = fence(lines[i]) else {
                out += inlineCode(lines[i]).compactMap(inlineCommand)
                i += 1
                continue
            }
            // Unclosed: what follows is all code, and none of it is a whole command.
            guard let end = lines.indices.first(where: { $0 > i && closes(lines[$0], open) }) else { break }
            let body = lines[(i + 1)..<end].map { $0.hasPrefix(open.indent) ? String($0.dropFirst(open.indent.count)) : $0 }
            if let c = blockCommand(lang: open.lang, lines: body) { out.append(c) }
            i = end + 1
        }
        return out
    }

    // A fenced block's command: the whole block, or with "$ " prompts only the prompted lines (and the lines
    // one continues onto with a trailing \).
    static func blockCommand(lang: String, lines: [String]) -> String? {
        guard langs.contains(lang.lowercased()) else { return nil }
        var block = lines
        if block.contains(where: { $0.hasPrefix("$ ") }) {
            var more = false
            block = block.compactMap { l in
                let take: String? = l.hasPrefix("$ ") ? String(l.dropFirst(2)) : more ? l : nil
                more = take?.hasSuffix("\\") ?? false
                return take
            }
        }
        var body = Substring(block.joined(separator: "\n"))
        while body.first == "\n" { body = body.dropFirst() }
        while let last = body.last, last.isWhitespace { body = body.dropLast() }
        return body.isEmpty ? nil : String(body)
    }

    struct Fence { let indent: String; let mark: Character; let length: Int; let lang: String }

    // "```bash", "  ~~~~sh": three or more backticks or tildes after any indent, then the language's word.
    static func fence(_ line: String) -> Fence? {
        let indent = line.prefix { $0.isWhitespace }
        let rest = line.dropFirst(indent.count)
        guard let mark = rest.first, mark == "`" || mark == "~" else { return nil }
        let run = rest.prefix { $0 == mark }.count
        guard run >= 3 else { return nil }
        let after = rest.dropFirst(run).drop { $0.isWhitespace }
        let lang = after.prefix { $0.isASCII && ($0.isLetter || $0.isNumber || "_+-".contains($0)) }
        return Fence(indent: String(indent), mark: mark, length: run, lang: String(lang))
    }

    // A fence of the same mark, at least as long, alone on its line.
    static func closes(_ line: String, _ open: Fence) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.count >= open.length && t.allSatisfy { $0 == open.mark }
    }

    // `like this`, not ``this``: one backtick each side, not next to another.
    static func inlineCode(_ line: String) -> [String] {
        let c = Array(line)
        var out: [String] = []
        var i = 0
        while i < c.count {
            guard c[i] == "`", i == 0 || c[i - 1] != "`",
                  let j = c[(i + 1)...].firstIndex(of: "`"), j > i + 1, j + 1 == c.count || c[j + 1] != "`" else { i += 1; continue }
            out.append(String(c[(i + 1)..<j]))
            i = j + 1
        }
        return out
    }

    // Inline code that is a command: "! <anything>", or one that starts with a command word and a space.
    // A bare `cd <dir>` does nothing in a run of its own.
    static func inlineCommand(_ code: String) -> String? {
        let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
        var cmd: String?
        if code.hasPrefix("! ") {
            let rest = code.dropFirst().drop { $0 == " " }
            if let f = rest.first, !f.isWhitespace { cmd = String(rest) }
        } else if words.contains(where: { code.hasPrefix($0 + " ") }) {
            cmd = code
        }
        guard let cmd, !bareCd(cmd) else { return nil }
        return cmd
    }

    static func bareCd(_ c: String) -> Bool {
        guard c.hasPrefix("cd"), let f = c.dropFirst(2).first, f.isWhitespace else { return false }
        return !c.contains(where: { ";&|".contains($0) })
    }
}

extension Session {
    /// The newest run of `command` for this Claude session since its latest reply began (in `sessions`, the
    /// server's list): one from an older reply with the same command would show an old result.
    public func latestRun(of command: String, in sessions: [Session]) -> Session? {
        sessions.filter { $0.run?.parent == name && $0.run?.command == command && ($0.run?.startedAt ?? 0) >= (runnableAt ?? 0) }
            .max { ($0.run?.startedAt ?? 0) < ($1.run?.startedAt ?? 0) }
    }
}
