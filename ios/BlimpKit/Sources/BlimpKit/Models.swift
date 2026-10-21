// blimpd's API types (docs/DESIGN.md). Decoding is lenient: a state or kind this app doesn't
// know yet decodes as unknown/other instead of failing the whole list.
import Foundation

public enum SessionState: String, Codable, Sendable, Equatable {
    case working, waiting, done, unknown
    public init(from decoder: Decoder) throws {
        self = SessionState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

public enum PromptKind: String, Codable, Sendable, Equatable {
    case permission, question, other
    /// Claude Code asks whether to trust the session's folder, before anything else (blimpd reads it off the screen).
    case trust
    public init(from decoder: Decoder) throws {
        self = PromptKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

public struct QuestionOption: Codable, Sendable, Equatable {
    public let label: String
    public let description: String?
}

public struct Question: Codable, Sendable, Equatable {
    public let question: String
    public let header: String?
    public let multiSelect: Bool
    public let options: [QuestionOption]
}

public struct Prompt: Codable, Sendable, Equatable {
    public let kind: PromptKind
    public let at: Double
    public let answerable: Bool
    public let tool: String?
    public let summary: String?
    public let options: [String]?
    public let questions: [Question]?
    /// The folder a trust prompt asks about.
    public var folder: String?

    /// What the buttons say, in order; the index is what `answer` sends as `pick`.
    public var choices: [String] {
        switch kind {
        case .permission, .trust: options ?? []
        case .question: questions?.first?.options.map(\.label) ?? []
        case .other: []
        }
    }

    /// One set of choices a single pick answers, by a tap or by voice: a permission, or one single-choice
    /// question. Anything more is answered a question at a time (QuestionDraft), by tap only.
    public var singleChoice: Bool {
        guard answerable, !choices.isEmpty else { return false }
        switch kind {
        case .permission, .trust: return true
        case .question: return questions?.count == 1 && questions?.first?.multiSelect == false
        case .other: return false
        }
    }

    /// What the phone reads aloud.
    public var spoken: String {
        switch kind {
        case .permission:
            var head = "Claude wants to continue"
            if let s = summary, let said = Prompt.spokenSummary(s) { head = "Claude wants to " + said }
            return (head + ". " + Prompt.askAloud(choices)).trimmingCharacters(in: .whitespaces)
        case .question:
            return (questions ?? []).map { q in
                // SpokenText adds a full stop to a question that has none, which is the break before the options.
                (Prompt.say(q.question) + " " + Prompt.askAloud(q.options.map(\.label))).trimmingCharacters(in: .whitespaces)
            }.joined(separator: " ")
        case .trust:
            let name = folder.map { " " + URL(fileURLWithPath: $0).lastPathComponent } ?? ""
            return "Claude Code asks if you trust the folder\(name). Yes or no?"
        case .other:
            return "Claude is asking something. Open it on the Mac."
        }
    }

    private static func say(_ s: String) -> String { SpokenText.from(markdown: s) }

    // The summary as speech, without reading a long command or a full path.
    private static func spokenSummary(_ s: String) -> String? {
        let verbs: [(String, String, Bool)] = [("Ran ", "run ", false), ("Edited ", "edit ", true), ("Wrote ", "write ", true),
                                                ("Read ", "read ", true), ("Searched for ", "search for ", false)]
        var text = s
        if let v = verbs.first(where: { s.hasPrefix($0.0) }) {
            let parts = String(s.dropFirst(v.0.count)).components(separatedBy: "`")
            let code = parts.indices.filter { $0 % 2 == 1 && $0 < parts.count - 1 }.map { parts[$0] }
            if v.0 == "Ran ", code.contains(where: { $0.count > 40 }) { return "run a command" }
            let joined = parts.enumerated().map { i, p in
                v.2 && i % 2 == 1 ? String(p.split(separator: "/").last ?? Substring(p)) : p
            }.joined()
            text = v.1 + joined
        }
        var said = say(text)
        while let l = said.last, ".!?:".contains(l) { said.removeLast() }
        return said.isEmpty ? nil : said
    }

    // "A, B, or C?" (two: "A or B?"). A long label is cut at " for " or at a comma after its first word.
    private static func askAloud(_ labels: [String]) -> String {
        let short = labels.map { label -> String in
            var cut = label
            if let sp = label.firstIndex(where: { $0.isWhitespace }) {
                let ends = [label.range(of: " for ", range: sp..<label.endIndex)?.lowerBound,
                            label[label.index(after: sp)...].firstIndex(of: ",")].compactMap { $0 }
                if let e = ends.min() { cut = String(label[..<e]) }
            }
            var t = say(cut)
            while let l = t.last, ".!?:".contains(l) { t.removeLast() }
            return t
        }
        switch short.count {
        case 0: return ""
        case 1: return short[0] + "?"
        case 2: return short[0] + " or " + short[1] + "?"
        default: return short.dropLast().joined(separator: ", ") + ", or " + short[short.count - 1] + "?"
        }
    }
}

public struct Session: Codable, Sendable, Equatable, Identifiable {
    public let name: String
    public let created: Double
    public let dir: String
    public let kind: String
    public let label: String?
    public let sessionId: String?
    public let title: String
    public let updatedAt: Double?
    public let state: SessionState
    public let stateSince: Double?
    public let prompt: Prompt?
    /// Claude replied since the phone or the Mac last had it on screen (nil from an older blimpd).
    public var unread: Bool? = nil
    /// Haiku's note on its last turn (nil from an older blimpd, or with names off).
    public var note: Note? = nil

    public var id: String { name }
    /// blimpd can show a session as chat only when Claude Code runs in it.
    public var isClaude: Bool { sessionId != nil }
    /// Milliseconds: the latest thing that happened in it.
    public var activity: Double { max(updatedAt ?? 0, stateSince ?? 0, created * 1000) }
}

/// Where a Claude session stands after its last turn, in Haiku's words (blimpd's notes.ts).
public enum NoteStatus: String, Codable, Sendable, Equatable {
    case done, progress, question
    public init(from decoder: Decoder) throws {
        self = NoteStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .done
    }
}

public struct Note: Codable, Sendable, Equatable {
    public let status: NoteStatus
    public let text: String
    public let at: Double
}

public enum ChatRole: String, Codable, Sendable, Equatable {
    case user, assistant, tool, compacted
    public init(from decoder: Decoder) throws {
        self = ChatRole(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .tool
    }
}

public struct ChatMessage: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let at: Double
    public let role: ChatRole
    public let text: String?
    public let name: String?
    public let summary: String?
    public let input: String?
    public let output: String?
    public let error: Bool?
}

public enum ChatEvent: Sendable, Equatable {
    case history([ChatMessage]), append([ChatMessage]), reset, unreadable
    case ack(id: String), failed(id: String, error: String), other

    private struct Wire: Decodable { let type: String; let messages: [ChatMessage]?; let id: String?; let error: String? }

    public static func decode(_ data: Data) -> ChatEvent {
        guard let w = try? JSONDecoder().decode(Wire.self, from: data) else { return .other }
        switch w.type {
        case "history": return .history(w.messages ?? [])
        case "append": return .append(w.messages ?? [])
        case "reset": return .reset
        case "unreadable": return .unreadable
        case "ack": return w.id.map { .ack(id: $0) } ?? .other
        case "error": return .failed(id: w.id ?? "", error: w.error ?? "")
        default: return .other
        }
    }
}

public enum EventsMessage: Sendable, Equatable {
    case sessions([Session]), other

    // One malformed session must not blank the whole list, so each element decodes on its own.
    private struct Lenient: Decodable {
        let session: Session?
        init(from decoder: Decoder) throws { session = try? Session(from: decoder) }
    }
    private struct Wire: Decodable { let type: String; let sessions: [Lenient]? }

    public static func decode(_ data: Data) -> EventsMessage {
        guard let w = try? JSONDecoder().decode(Wire.self, from: data), w.type == "sessions", let s = w.sessions else { return .other }
        return .sessions(s.compactMap(\.session))
    }
}

public enum ChatCommand: Encodable, Sendable, Equatable {
    case input(id: String, text: String)
    /// `label` is the choice's text as shown at `pick`: blimpd refuses the answer if that's changed.
    case answer(id: String, at: Double, pick: Int, label: String)
    case interrupt(id: String)
    /// Esc for the prompt that waited since `at`: blimpd presses it only while that prompt is still up.
    case dismiss(id: String, at: Double)
    /// Every question of a dialog at once; `labels` are each question's picked options as shown.
    case answers(id: String, at: Double, answers: [QuestionAnswer], labels: [[String]])

    /// What blimpd's ack or error names.
    public var id: String {
        switch self {
        case let .input(id, _), let .answer(id, _, _, _), let .interrupt(id), let .dismiss(id, _), let .answers(id, _, _, _): id
        }
    }

    private enum Key: String, CodingKey { case type, id, text, at, pick, label, answers, labels }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case let .input(id, text):
            try c.encode("input", forKey: .type); try c.encode(id, forKey: .id); try c.encode(text, forKey: .text)
        case let .answer(id, at, pick, label):
            try c.encode("answer", forKey: .type); try c.encode(id, forKey: .id); try c.encode(at, forKey: .at); try c.encode(pick, forKey: .pick)
            try c.encode(label, forKey: .label)
        case let .interrupt(id):
            try c.encode("interrupt", forKey: .type); try c.encode(id, forKey: .id)
        case let .dismiss(id, at):
            try c.encode("interrupt", forKey: .type); try c.encode(id, forKey: .id); try c.encode(at, forKey: .at)
        case let .answers(id, at, answers, labels):
            try c.encode("answer", forKey: .type); try c.encode(id, forKey: .id); try c.encode(at, forKey: .at)
            try c.encode(answers, forKey: .answers); try c.encode(labels, forKey: .labels)
        }
    }
}

public struct RecentFolder: Codable, Sendable, Equatable { public let dir: String; public let lastUsed: Double }
public struct Conversation: Codable, Sendable, Equatable, Identifiable {
    public let sessionId: String; public let title: String; public let updatedAt: Double
    public var unread: Bool? = nil
    public var note: Note? = nil
    public var id: String { sessionId }
}
public struct Started: Codable, Sendable, Equatable { public let name: String }
public struct Health: Codable, Sendable, Equatable { public let version: String; public let home: String }
