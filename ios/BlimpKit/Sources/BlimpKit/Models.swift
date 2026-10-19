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

    /// What the buttons say, in order; the index is what `answer` sends as `pick`.
    public var choices: [String] {
        switch kind {
        case .permission: options ?? []
        case .question: questions?.first?.options.map(\.label) ?? []
        case .other: []
        }
    }

    /// What the phone reads aloud. Filled in by a later task.
    public var spoken: String { "" }
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

    public var id: String { name }
    /// blimpd can show a session as chat only when Claude Code runs in it.
    public var isClaude: Bool { sessionId != nil }
    /// Milliseconds: the latest thing that happened in it.
    public var activity: Double { max(updatedAt ?? 0, stateSince ?? 0, created * 1000) }
}

public enum ChatRole: String, Codable, Sendable, Equatable {
    case user, assistant, tool
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
    case answer(id: String, at: Double, pick: Int)
    case interrupt(id: String)

    private enum Key: String, CodingKey { case type, id, text, at, pick }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case let .input(id, text):
            try c.encode("input", forKey: .type); try c.encode(id, forKey: .id); try c.encode(text, forKey: .text)
        case let .answer(id, at, pick):
            try c.encode("answer", forKey: .type); try c.encode(id, forKey: .id); try c.encode(at, forKey: .at); try c.encode(pick, forKey: .pick)
        case let .interrupt(id):
            try c.encode("interrupt", forKey: .type); try c.encode(id, forKey: .id)
        }
    }
}

public struct RecentFolder: Codable, Sendable, Equatable { public let dir: String; public let lastUsed: Double }
public struct Conversation: Codable, Sendable, Equatable, Identifiable {
    public let sessionId: String; public let title: String; public let updatedAt: Double
    public var id: String { sessionId }
}
public struct Started: Codable, Sendable, Equatable { public let name: String }
public struct Health: Codable, Sendable, Equatable { public let version: String; public let home: String }
