// One open chat: blimpd's chat socket for a session, its messages, and what the phone types into it
// (docs/DESIGN.md "Chat"). The session itself (state, prompt) comes live from the Store's /events.
import BlimpKit
import Foundation
import Observation

@Observable @MainActor
final class ChatModel {
    let name: String
    private(set) var log = ChatLog()
    /// Ids sent and not yet acknowledged.
    private(set) var sending: Set<String> = []
    /// One short line about the last thing that didn't go through; cleared by the next try.
    var lastError: String?
    /// The chat socket dropped and is coming back; the log stays as it was until the new history.
    private(set) var reconnecting = false
    /// A first history has come (an empty one for a brand-new session).
    private(set) var loaded = false
    /// Bumped by each history (the first, and each one after a reconnect), so the screen can jump to the end.
    private(set) var histories = 0
    /// The last time the store listed this session: what it was, once it's gone.
    private(set) var lastSeen: Session?
    private var socketEnded = false
    /// The chat handshake was refused (404) while the session is still listed: this blimpd has no chat.
    private(set) var noChat = false
    /// The `at` of the last prompt blimpd acknowledged an answer for: its buttons stay off until a new wait.
    private var answeredAt: Double?
    private var inputId: String?
    private var answerId: String?
    private var stopId: String?

    private let store: Store
    @ObservationIgnored private var socket: Socket?
    // Bumped by open() and close(), so a change noticed for an earlier open() doesn't watch twice.
    @ObservationIgnored private var watchRound = 0
    @ObservationIgnored private var watching = false
    @ObservationIgnored private var replies: [String: CheckedContinuation<Reply, Never>] = [:]
    @ObservationIgnored private var timers: [String: Task<Void, Never>] = [:]
    /// Called with each new reply from Claude as it arrives (by `append`, never from a history), to read it aloud.
    @ObservationIgnored var onReply: ((ChatMessage) -> Void)?

    static let notSent = "Not sent. Check the connection."
    static let questionChanged = "The question changed. Check it and answer again."

    init(name: String, store: Store) {
        self.name = name
        self.store = store
    }

    isolated deinit {
        socket?.stop()
    }

    /// Live from the store; nil until /events lists it (a new session can take a second) and once it's gone.
    var session: Session? { store.sessions.first { $0.name == name } }
    /// blimpd closed the chat (4000), said "the session ended", or refused it (404) for a session that
    /// /events no longer lists either. Not "missing from the list" alone: blimpd publishes an empty
    /// list when zmx fails, which would end every open chat.
    var ended: Bool { socketEnded }
    var title: String { (session ?? lastSeen)?.title ?? name }
    var folder: String { (session ?? lastSeen).map { URL(fileURLWithPath: $0.dir).lastPathComponent } ?? "" }
    var working: Bool { session?.state == .working }
    /// What Claude is asking, while it waits for an answer.
    var prompt: Prompt? { session?.state == .waiting ? session?.prompt : nil }
    /// Claude waits, and blimpd doesn't know on what (no hook prompt): only the Mac can answer it.
    var waitingUnknown: Bool { session?.state == .waiting && session?.prompt == nil }
    /// Claude Code was just started in it and hasn't said which conversation it is yet.
    var starting: Bool { session?.kind == "claude" && session?.sessionId == nil }
    /// blimpd can't show or type into it (not Claude, or no transcript): only the Mac can.
    var macOnly: Bool { !starting && (!log.readable || session?.isClaude == false) }
    var canResume: Bool { (session ?? lastSeen)?.sessionId != nil }
    var sendingText: Bool { inputId != nil }
    var answering: Bool { answerId != nil }
    /// This prompt's answer went through: no second press while the session still shows it.
    var answered: Bool { prompt != nil && prompt?.at == answeredAt }
    var stopping: Bool { stopId != nil }

    /// Opens the chat socket (again, after close()). The screen calls it on appear.
    func open() {
        if !watching {
            watching = true
            watchRound += 1
            watch(watchRound)
        }
        guard socket == nil, !socketEnded, let api = store.api else { return }
        noChat = false
        let s = Socket(
            url: api.socketURL("/sessions/\(name)/chat"),
            onMessage: { [weak self] data in self?.received(data) },
            onState: { [weak self] state in self?.update(state) })
        socket = s
        s.start()
    }

    /// Closes the chat socket. The screen calls it when it goes away; a Socket left open reconnects forever.
    func close() {
        socket?.stop()
        socket = nil
        watching = false
        watchRound += 1
        for c in replies.values { c.resume(returning: .notSent) }
        replies = [:]
        for t in timers.values { t.cancel() }
        timers = [:]
    }

    func reconnectNow() {
        socket?.reconnectNow()
    }

    // Keeps lastSeen up to date while open: each change to this session in the store calls it again.
    private func watch(_ round: Int) {
        guard watching, round == watchRound else { return }
        let s = withObservationTracking { session } onChange: { [weak self] in
            Task { @MainActor in self?.watch(round) }
        }
        if let s, s != lastSeen { lastSeen = s }
    }

    /// The session is over: no more reconnecting, and what's still waiting for a reply gets none.
    private func endChat() {
        socketEnded = true
        socket?.stop()
        socket = nil
        for id in Array(replies.keys) { reply(id, .ended) }
    }

    /// Types `text` into the session. true once blimpd acknowledged it; false (and lastError set)
    /// if it didn't, and then nothing is kept or queued.
    func send(_ text: String) async -> Bool {
        let id = UUID().uuidString
        lastError = nil
        inputId = id
        defer { inputId = nil }
        switch await request(.input(id: id, text: text), id: id) {
        case .ack: return true
        case .ended: break
        // blimpd types nothing while Claude asks something: Enter would confirm its highlighted choice.
        case .failed(let error) where error == "Claude is asking something. Answer it first.":
            lastError = "Answer Claude's question first."
        case .failed(let error): lastError = "Not sent: \(error)"
        case .notSent, .timeout: lastError = Self.notSent
        }
        return false
    }

    /// Picks `pick` (an index in `shown.choices`) for the prompt that was on screen (or read aloud)
    /// when it was picked. If the prompt has changed since in any way (a new wait, or the screen's
    /// options in place of the first Yes/No under the same wait), nothing is sent: the index belongs
    /// to what was shown. blimpd checks the same again with the choice's label.
    func answer(_ pick: Int, to shown: Prompt) async {
        guard answerId == nil, !answered else { return }
        guard prompt == shown, shown.choices.indices.contains(pick) else {
            lastError = Self.questionChanged
            return
        }
        let id = UUID().uuidString
        lastError = nil
        answerId = id
        defer { answerId = nil }
        switch await request(.answer(id: id, at: shown.at, pick: pick, label: shown.choices[pick]), id: id) {
        case .ack: answeredAt = shown.at
        case .ended: break
        // A new wait, other options, or the Mac answered first; the bar shows the latest prompt.
        case .failed(let error) where error == "the question changed": lastError = Self.questionChanged
        case .failed(let error): lastError = "Not sent: \(error)"
        case .notSent, .timeout: lastError = Self.notSent
        }
    }

    /// Stop: Esc, as on the Mac.
    func stop() async {
        guard stopId == nil else { return }
        let id = UUID().uuidString
        lastError = nil
        stopId = id
        defer { stopId = nil }
        switch await request(.interrupt(id: id), id: id) {
        case .ack, .ended: break
        case .failed(let error): lastError = "Not sent: \(error)"
        case .notSent, .timeout: lastError = Self.notSent
        }
    }

    /// Starts Claude again on this session's conversation; returns the new session's name.
    func resume() async -> String? {
        guard let s = session ?? lastSeen, let conversation = s.sessionId else { return nil }
        lastError = nil
        do {
            return try await store.start(dir: s.dir, resume: conversation)
        } catch {
            lastError = Store.words(for: error)
            return nil
        }
    }

    // MARK: - The socket

    private func received(_ data: Data) {
        let event = ChatEvent.decode(data)
        switch event {
        case .ack(let id): reply(id, .ack)
        case .failed(let id, let error): reply(id, .failed(error))
        default:
            // An append repeats a message when it grows (a tool's output): only a first sighting is new.
            var newReplies: [ChatMessage] = []
            if case .append(let messages) = event {
                newReplies = messages.filter { m in
                    m.role == .assistant && !(m.text ?? "").isEmpty && !log.messages.contains { $0.id == m.id }
                }
            }
            log.apply(event)
            if case .history = event {
                loaded = true
                histories += 1
            }
            if let onReply { newReplies.forEach(onReply) }
        }
    }

    private func update(_ state: SocketState) {
        switch state {
        case .connecting:
            break
        case .open:
            reconnecting = false
        case .closed(code: 4000):
            endChat()
        case .closed(code: 404):
            // blimpd's answer for a chat on a session it doesn't have, and an older blimpd's for every
            // chat (it has no chat route). Ended only if /events no longer lists the session either.
            if session == nil && !store.sessions.isEmpty {
                endChat()
            } else {
                socket?.stop()
                socket = nil
                noChat = true
            }
        case .closed(code: 401):
            socket = nil  // the token was refused; the events socket sends the app back to Pair
            reconnecting = true
        case .closed:
            reconnecting = true
        }
    }

    // MARK: - Replies

    private enum Reply: Sendable {
        case ack, failed(String), notSent, timeout
        /// The session is gone (blimpd closed the chat or said it ended): not an error to show.
        case ended
    }

    /// Sends one command and waits for blimpd's reply: 10 s, then the same id once more for 10 s
    /// (blimpd types an id only once, so a resend after a lost ack is safe).
    private func request(_ command: ChatCommand, id: String) async -> Reply {
        guard let data = try? JSONEncoder().encode(command) else { return .notSent }
        sending.insert(id)
        defer { sending.remove(id) }
        var result = await attempt(data, id: id)
        if case .timeout = result { result = await attempt(data, id: id) }
        // blimpd's reply for typing into a session that's no longer there
        if case .failed("the session ended") = result {
            endChat()
            return .ended
        }
        return result
    }

    private func attempt(_ data: Data, id: String) async -> Reply {
        await withCheckedContinuation { (c: CheckedContinuation<Reply, Never>) in
            replies[id] = c
            Task { [weak self] in
                guard let socket = self?.socket else { self?.reply(id, .notSent); return }
                do { try await socket.send(data) } catch { self?.reply(id, .notSent) }
            }
            timers[id] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(10))
                if !Task.isCancelled { self?.reply(id, .timeout) }
            }
        }
    }

    private func reply(_ id: String, _ r: Reply) {
        timers.removeValue(forKey: id)?.cancel()
        replies.removeValue(forKey: id)?.resume(returning: r)
    }
}
