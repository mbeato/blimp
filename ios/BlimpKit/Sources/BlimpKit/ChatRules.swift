// Rules for a chat open on the phone: which reply never folds, where the "since you left" line goes, which
// session to answer next, what a code block's Run button says (feature 2: blimpd runs a command Claude
// handed over in a run session of its own, then can type its result back to Claude), and the words when a
// secret or a recap didn't come through.
import Foundation

public enum ChatFold {
    /// Claude's newest reply in what the chat shows. It never folds: its end is usually the part you want.
    public static func newest(_ shown: [ChatMessage]) -> String? {
        shown.last { $0.role == .assistant && !($0.text ?? "").isEmpty }?.id
    }
}

public enum SinceYouLeft {
    /// The message the "since you left" line goes above: the first one newer than when this phone last had the
    /// chat on screen (lastShown, ms), when Claude replied since and neither app has shown that yet (unread).
    /// nil for no line: never on screen here, nothing new, only your own messages new, or all of it new.
    public static func first(_ shown: [ChatMessage], lastShown: Double?, unread: Bool) -> String? {
        guard unread, let lastShown, let i = shown.firstIndex(where: { $0.at > lastShown }), i > 0,
              shown[i...].contains(where: { $0.role == .assistant }) else { return nil }
        return shown[i].id
    }
}

/// After you answer in one chat, the next session waiting on you, so a backlog clears in a row.
public struct NextWaiting: Equatable, Sendable {
    public let session: Session
    /// How many other sessions wait, this one included.
    public let count: Int

    public var words: String {
        count > 1 ? "Next: \(session.title) is waiting (\(count) left)" : "Next: \(session.title) is waiting"
    }

    /// The session other than `name` the inbox lists first under Needs you, across folders: by its rule (it
    /// waits, or it's done with a question for you) and in its order (the oldest wait first, ties in the list's
    /// order). Only those with Claude (or Claude Code's folder trust question) in them: the chip opens it to
    /// answer. nil when none waits.
    public static func after(_ name: String, in sessions: [Session]) -> NextWaiting? {
        let others = Inbox.needsYou(sessions: sessions, dir: nil, earlier: []).compactMap(\.session).filter { s in
            s.name != name && (s.isClaude || s.prompt != nil)
        }
        guard let first = others.first else { return nil }
        return NextWaiting(session: first, count: others.count)
    }
}

/// Where a command Claude handed over stands, for the Run button under its code block.
public enum RunStatus: Equatable, Sendable {
    case ready
    /// The phone asked blimpd to start it.
    case starting
    /// Each with the run session's name.
    case running(String)
    case ended(String, exit: Int)
    case sending(String)
    case sent(String)

    /// The commands blimpd offers to run for `message`: Session.runnable, for Claude's latest reply only (from
    /// when it began, runnableAt). nil for anything else.
    public static func offers(_ message: ChatMessage, in session: Session?) -> [String]? {
        guard message.role == .assistant, let s = session, let r = s.runnable, !r.isEmpty, message.at >= (s.runnableAt ?? 0) else { return nil }
        return r
    }

    /// `command`'s newest run for `session` since its latest reply began (Session.latestRun). starting: commands
    /// the phone is starting; sending, sent: run sessions whose result is going, or went, to Claude.
    public static func of(_ command: String, for session: Session, in sessions: [Session], starting: Set<String> = [],
                          sending: Set<String> = [], sent: Set<String> = []) -> RunStatus {
        guard let run = session.latestRun(of: command, in: sessions), let r = run.run else { return starting.contains(command) ? .starting : .ready }
        if sent.contains(run.name) { return .sent(run.name) }
        if sending.contains(run.name) { return .sending(run.name) }
        if let exit = r.exit { return .ended(run.name, exit: exit) }
        return .running(run.name)
    }

    /// What shows beside the button; nil before it's run.
    public var words: String? {
        switch self {
        case .ready: nil
        case .starting: "Starting…"
        case .running: "Running…"
        case .ended(_, let exit): exit == 0 ? "Finished · exit 0" : "Failed · exit \(exit)"
        case .sending: "Sending…"
        case .sent: "Result sent to Claude"
        }
    }

    /// It ended and its result hasn't gone to Claude: "Send result to Claude" shows.
    public var canSend: Bool {
        if case .ended = self { return true }
        return false
    }
}

/// Give a Secret's words.
public enum SecretText {
    /// A PEM or SSH key that came through without its line breaks (the phone's secure field drops them):
    /// saved like that, Claude's command would fail with it.
    public static func lostLineBreaks(_ value: String) -> Bool {
        value.contains("-----BEGIN") && !value.contains(where: \.isNewline)
    }

    /// The words when PUT /secrets/<name> failed with blimpd's `message`. A blimpd from before secrets answers
    /// the route with a bare "not found".
    public static func notSaved(_ message: String) -> String {
        message == "not found" ? "This server's blimpd is too old for secrets. Update it first." : "Not saved: \(message)"
    }
}

public enum RecapText {
    /// The words when GET /sessions/<name>/recap failed with blimpd's `message`. A blimpd from before recaps
    /// answers the route with a bare "not found" (a missing session says "no session named …").
    public static func failure(_ message: String) -> String {
        message == "not found" ? "This server's blimpd is too old for recaps. Update it first." : message
    }
}
