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
    /// A permission's command, file, address or search, so it can be judged away from the terminal (at most
    /// 2000 characters, secrets taken out). Older blimpd: nil.
    public var input: String? = nil
    /// ExitPlanMode's plan, as Markdown (at most 8000 characters). Older blimpd: nil.
    public var plan: String? = nil
    /// The command pushes, deploys, deletes, forces or hard-resets: a Yes there is a careful one. Older blimpd: nil.
    public var risky: Bool? = nil

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
    // blimpd 0.3's, each only when there is some (nil from an older blimpd). One that doesn't decode is
    // nil, not a dropped session.
    /// Background work Claude started: running, or finished in the last 30 minutes.
    public var jobs: [Job]? = nil
    /// How full Claude's context window is, in tokens.
    public var context: ContextWindow? = nil
    /// The folder of Claude's latest line, and the branch checked out there.
    public var git: Git? = nil
    /// On a session that handed off (Continue in new session): how that goes.
    public var handoff: Handoff? = nil
    /// On a session a handoff started: the zmx name of the one it came from.
    public var parent: String? = nil
    /// The commands in Claude's latest reply, newest first: what Run offers (RunnableCommand).
    public var runnable: [String]? = nil
    /// Milliseconds: when that reply began. A run started before it is for an older reply.
    public var runnableAt: Double? = nil
    /// On a run session (kind "run"): its command, the Claude session it's for, and how it ended.
    public var run: Run? = nil
    /// Its checkout, branch and pull requests.
    public var work: Work? = nil
    /// On the assistant's own session (blimpd's assistant.ts): true.
    public var assistant: Bool? = nil
    /// On a session the assistant started or messaged: why, and when.
    public var job: AssistantJob? = nil

    public var id: String { name }
    /// blimpd can show a session as chat only when Claude Code runs in it.
    public var isClaude: Bool { sessionId != nil }
    /// Milliseconds: the latest thing that happened in it.
    public var activity: Double { max(updatedAt ?? 0, stateSince ?? 0, created * 1000) }
}

extension Session {
    private enum CodingKeys: String, CodingKey {
        case name, created, dir, kind, label, sessionId, title, updatedAt, state, stateSince, prompt, unread, note
        case jobs, context, git, handoff, parent, runnable, runnableAt, run, work, assistant, job
    }

    // The fields before blimpd 0.3 as the synthesized decoding had them; the newer ones each on their own.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        created = try c.decode(Double.self, forKey: .created)
        dir = try c.decode(String.self, forKey: .dir)
        kind = try c.decode(String.self, forKey: .kind)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        title = try c.decode(String.self, forKey: .title)
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt)
        state = try c.decode(SessionState.self, forKey: .state)
        stateSince = try c.decodeIfPresent(Double.self, forKey: .stateSince)
        prompt = try c.decodeIfPresent(Prompt.self, forKey: .prompt)
        unread = try c.decodeIfPresent(Bool.self, forKey: .unread)
        note = try c.decodeIfPresent(Note.self, forKey: .note)
        // A job this app can't read is left out, not all of them.
        jobs = (try? c.decodeIfPresent([Each<Job>].self, forKey: .jobs))?.compactMap(\.value)
        context = try? c.decodeIfPresent(ContextWindow.self, forKey: .context)
        git = try? c.decodeIfPresent(Git.self, forKey: .git)
        handoff = try? c.decodeIfPresent(Handoff.self, forKey: .handoff)
        parent = try? c.decodeIfPresent(String.self, forKey: .parent)
        runnable = try? c.decodeIfPresent([String].self, forKey: .runnable)
        runnableAt = try? c.decodeIfPresent(Double.self, forKey: .runnableAt)
        run = try? c.decodeIfPresent(Run.self, forKey: .run)
        work = try? c.decodeIfPresent(Work.self, forKey: .work)
        assistant = try? c.decodeIfPresent(Bool.self, forKey: .assistant)
        job = try? c.decodeIfPresent(AssistantJob.self, forKey: .job)
    }
}

// One element of a list, nil when it doesn't decode.
private struct Each<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

public enum JobKind: String, Codable, Sendable, Equatable {
    case bash, monitor, agent, workflow, other
    public init(from decoder: Decoder) throws {
        self = JobKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
}

public enum JobStatus: String, Codable, Sendable, Equatable {
    case running, done, failed, stopped, unknown
    public init(from decoder: Decoder) throws {
        self = JobStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// Background work Claude started (blimpd's activity.ts). Times in ms: the app works out how long it ran.
public struct Job: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: JobKind
    /// What it does: the command's description, the Monitor's, the agent's or workflow's summary.
    public let label: String
    public let startedAt: Double
    public let status: JobStatus
    public var outputFile: String? = nil
    public var endedAt: Double? = nil
    public var exit: Int? = nil
    /// A running command's or Monitor's last output line, at most 10 s old.
    public var lastLine: String? = nil
}

/// On a session the assistant started or messaged (blimpd's jobs.ts): why, in a few words, and when it last acted on
/// it (ms).
public struct AssistantJob: Codable, Sendable, Equatable {
    public let reason: String
    public let at: Double
}

public struct ContextWindow: Codable, Sendable, Equatable {
    /// Tokens in Claude's context window now, and how many it holds.
    public let used: Int
    public let limit: Int
}

public struct Git: Codable, Sendable, Equatable {
    public let cwd: String
    public var branch: String? = nil
}

public enum HandoffState: String, Codable, Sendable, Equatable {
    case writing, started, failed, unknown
    public init(from decoder: Decoder) throws {
        self = HandoffState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

/// Continue in new session (blimpd's handoff.ts): Claude writes the handoff file, then a new session reads it.
public struct Handoff: Codable, Sendable, Equatable {
    public let state: HandoffState
    /// Once started: the new session's zmx name, and the handoff file.
    public var child: String? = nil
    public var file: String? = nil
    /// Once failed: why, in words for the user.
    public var error: String? = nil
}

/// A command Claude handed over, run in a session of its own (blimpd's runs.ts). Times in ms.
public struct Run: Codable, Sendable, Equatable {
    public let command: String
    /// The zmx name of the Claude session it's for.
    public let parent: String
    public var cwd: String? = nil
    public let startedAt: Double
    /// Both set once it ended.
    public var endedAt: Double? = nil
    public var exit: Int? = nil

    public var ended: Bool { exit != nil }
}

public struct PullRequest: Codable, Sendable, Equatable {
    public let number: Int
    public let title: String
    /// OPEN, MERGED, CLOSED, as gh says it.
    public let state: String
    /// Always http(s): blimpd drops any other.
    public let url: String
}

/// Which session is on what (blimpd's work.ts). blimpd 0.3 also sent `clash`: not read, so it decodes all the same.
public struct Work: Codable, Sendable, Equatable {
    public var branch: String? = nil
    public var root: String? = nil
    /// The checkout is a linked worktree, not the repo's main folder.
    public var worktree: Bool? = nil
    public var prs: [PullRequest]? = nil
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
    case user, assistant, tool, compacted, shell, visual
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
    /// A visual's (role visual, a page Claude showed): its title, its copy's id, and true once the copy is no longer
    /// kept. Defaults, so the other roles' messages are made without them.
    public var title: String? = nil
    public var visual: String? = nil
    public var gone: Bool? = nil
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
    /// The server browser's tabs (Browser.swift), every folder's. The feed's switch and how many cards haven't been
    /// seen (Feed.swift). Whether the assistant is on (Settings' switch).
    case sessions([Session]), browser([BrowserTab]), feed(on: Bool, unseen: Int), assistant(on: Bool), other

    // One malformed session or tab must not blank the whole list, so each element decodes on its own.
    private struct Lenient<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws { value = try? T(from: decoder) }
    }
    private struct Wire: Decodable {
        let type: String
        let sessions: [Lenient<Session>]?
        let tabs: [Lenient<BrowserTab>]?
        let on: Bool?
        let unseen: Int?
    }

    public static func decode(_ data: Data) -> EventsMessage {
        guard let w = try? JSONDecoder().decode(Wire.self, from: data) else { return .other }
        if w.type == "sessions", let s = w.sessions { return .sessions(s.compactMap(\.value)) }
        if w.type == "browser", let t = w.tabs { return .browser(t.compactMap(\.value)) }
        if w.type == "feed", let on = w.on { return .feed(on: on, unseen: max(0, w.unseen ?? 0)) }
        if w.type == "assistant", let on = w.on { return .assistant(on: on) }
        return .other
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
/// One name in a folder on the computer (GET /fs/list): "dir" or "file", its size and when it last changed (ms).
public struct DirEntry: Codable, Sendable, Equatable, Identifiable {
    public let name: String
    public let kind: String
    public let size: Double
    public let mtime: Double
    public var id: String { name }
    public var isFolder: Bool { kind == "dir" }
}
/// A folder on the computer and what's in it, folders first, A to Z (GET /fs/list).
public struct DirListing: Codable, Sendable, Equatable { public let path: String; public let entries: [DirEntry] }
public struct Conversation: Codable, Sendable, Equatable, Identifiable {
    public let sessionId: String; public let title: String; public let updatedAt: Double
    public var unread: Bool? = nil
    public var note: Note? = nil
    public var id: String { sessionId }
}
public struct Started: Codable, Sendable, Equatable { public let name: String }
public struct Health: Codable, Sendable, Equatable { public let version: String; public let home: String }
