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
    /// The last time the store listed this session: what it was, once it's gone.
    private(set) var lastSeen: Session?
    private var socketEnded = false
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

    static let notSent = "Not sent. Check the connection."

    init(name: String, store: Store) {
        self.name = name
        self.store = store
    }

    isolated deinit {
        socket?.stop()
    }

    /// Live from the store; nil until /events lists it (a new session can take a second) and once it's gone.
    var session: Session? { store.sessions.first { $0.name == name } }
    /// Gone from the list after being in it, or blimpd closed the chat because it ended.
    var ended: Bool { socketEnded || (lastSeen != nil && session == nil) }
    var title: String { (session ?? lastSeen)?.title ?? name }
    var folder: String { (session ?? lastSeen).map { URL(fileURLWithPath: $0.dir).lastPathComponent } ?? "" }
    var working: Bool { session?.state == .working }
    /// What Claude is asking, while it waits for an answer.
    var prompt: Prompt? { session?.state == .waiting ? session?.prompt : nil }
    /// blimpd can't show or type into it (not Claude, or no transcript): only the Mac can.
    var macOnly: Bool { !log.readable || session?.isClaude == false }
    var canResume: Bool { (session ?? lastSeen)?.sessionId != nil }
    var sendingText: Bool { inputId != nil }
    var answering: Bool { answerId != nil }
    var stopping: Bool { stopId != nil }

    /// Opens the chat socket (again, after close()). The screen calls it on appear.
    func open() {
        if !watching {
            watching = true
            watchRound += 1
            watch(watchRound)
        }
        guard socket == nil, !socketEnded, let api = store.api else { return }
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
        // gone from the list after being in it: it ended, and its chat socket has nothing more to say
        if s == nil, lastSeen != nil { endChat() }
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
        case .failed(let error): lastError = "Not sent: \(error)"
        case .notSent, .timeout: lastError = Self.notSent
        }
        return false
    }

    /// Picks `pick` (an index in `prompt.choices`) for the prompt that was on screen (or read aloud)
    /// when it was picked, named by its `at`. If a new wait has replaced that prompt since, nothing is
    /// sent: the index belongs to the old question, and the bar now shows the new one.
    func answer(_ pick: Int, at: Double) async {
        guard let prompt, prompt.at == at, answerId == nil else { return }
        let id = UUID().uuidString
        lastError = nil
        answerId = id
        defer { answerId = nil }
        switch await request(.answer(id: id, at: at, pick: pick), id: id) {
        case .ack, .ended: break
        // Another answer got there first (the Mac, or a new wait); the bar redraws from the latest prompt.
        case .failed(let error) where error == "the question changed": break
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
            if case .history = event { loaded = true }
            log.apply(event)
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
        /// The session is gone (blimpd said so, or it left the list): not an error to show.
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
