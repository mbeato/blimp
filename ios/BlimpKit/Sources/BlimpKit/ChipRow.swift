// When the one-tap replies show above the box: only while it's empty and Claude isn't asking anything,
// with numbers when Claude's newest message ends in a numbered list.
import Foundation

extension ReplyChips {
    /// The chips to show; none while there's text in the box or a prompt is up.
    public static func row(after messages: [ChatMessage], draft: String, asking: Bool) -> [String] {
        guard !asking, draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return chips(after: lastReply(in: messages))
    }

    /// Claude's reply when it's the newest message (tool steps aside); nil after your own message.
    public static func lastReply(in messages: [ChatMessage]) -> String? {
        guard let last = messages.last(where: { $0.role != .tool }), last.role == .assistant,
              let text = last.text, !text.isEmpty else { return nil }
        return text
    }
}
