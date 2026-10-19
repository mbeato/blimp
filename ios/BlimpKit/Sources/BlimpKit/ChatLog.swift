// The messages of one open chat, kept in step with what blimpd sends over the chat socket.
import Foundation

public struct ChatLog: Equatable, Sendable {
    public private(set) var messages: [ChatMessage] = []
    /// false when blimpd can't read this session's transcript; the app then shows a notice.
    public private(set) var readable = true
    // id -> position in `messages`, so a streamed update to a message is O(1), not a scan.
    private var index: [String: Int] = [:]

    public init() {}

    public mutating func apply(_ e: ChatEvent) {
        switch e {
        case .history(let m):
            messages = m
            readable = true
            reindex()
        case .append(let m):
            for x in m {
                if let i = index[x.id] { messages[i] = x } else { index[x.id] = messages.count; messages.append(x) }
            }
        case .reset:
            messages = []
            index = [:]
        case .unreadable:
            readable = false
        case .ack, .failed, .other:
            break
        }
    }

    private mutating func reindex() {
        index = [:]
        for (i, m) in messages.enumerated() { index[m.id] = i }
    }
}
