// What a session's row in the inbox or the drawer does without opening its chat: answer what it asks (blimpd's
// POST /sessions/<name>/answer), Stop, Mark read, End (after a question), Resume a past conversation, and Continue
// in new session, which the phone follows until the new session starts (HomeView opens it) or fails (it says why).
import BlimpKit
import Foundation
import Observation

@Observable @MainActor
final class RowActions {
    enum Phase: Equatable { case sending, answered }

    /// Each row answer, by session and prompt: on its way, or blimpd typed it (until that prompt goes).
    private(set) var phases: [String: Phase] = [:]
    /// Why a row's answer didn't go, by session, until its next try.
    private(set) var failures: [String: String] = [:]
    /// What a row couldn't do (Stop, Mark read, Resume, Continue in new session), for an alert.
    var failure: String?
    /// A session asked to end from a row: "End this session?" first.
    var pendingEnd: Session?
    @ObservationIgnored private var handoffs = HandoffWatch()

    private static func key(_ name: String, _ p: Prompt) -> String { "\(name) \(p.at)" }

    func phase(_ name: String, _ p: Prompt) -> Phase? { phases[Self.key(name, p)] }

    /// Answers the prompt that was on screen; blimpd types it only while that prompt is still up.
    func answer(_ name: String, _ p: Prompt, _ answer: PromptAnswer, api: API?) async {
        let key = Self.key(name, p)
        guard phases[key] == nil else { return }
        failures[name] = nil
        guard let api else {
            failures[name] = Store.words(for: APIError.offline)
            return
        }
        phases[key] = .sending
        do {
            try await api.answer(name: name, AnswerRequest(answer: answer))
            phases[key] = .answered
        } catch {
            phases[key] = nil
            failures[name] = Self.words(error)
        }
    }

    /// No, and why, from the chat's prompt bar: Esc on that prompt, then the words typed as a message.
    /// nil once blimpd typed it, else why not.
    static func deny(name: String, _ p: Prompt, _ text: String, api: API?) async -> String? {
        guard let api else { return Store.words(for: APIError.offline) }
        do {
            try await api.answer(name: name, AnswerRequest(answer: .deny(at: p.at, text: text)))
            return nil
        } catch {
            return words(error)
        }
    }

    /// Stop: Esc, as the chat's Stop does.
    func stop(_ s: Session, api: API?) async {
        guard let api else { return offline() }
        do { try await api.answer(name: s.name, AnswerRequest(answer: .stop(at: nil))) } catch { failure = "Couldn't stop it. " + Store.words(for: error) }
    }

    /// Its replies so far count as read, here and on the Mac.
    func markRead(_ conversation: String, api: API?) async {
        guard let api else { return offline() }
        do { try await api.seen(conversation) } catch { failure = "Couldn't mark it read. " + Store.words(for: error) }
    }

    /// Starts Claude again on a past conversation, with no first message; returns the new session's name.
    func resume(_ c: Conversation, dir: String, store: Store) async -> String? {
        do {
            return try await store.start(dir: dir, resume: c.sessionId)
        } catch {
            failure = "Couldn't resume it. " + Store.words(for: error)
            return nil
        }
    }

    /// Continue in new session: Claude writes a handoff, then a new session reads it (`handoffNews` says when).
    func handoff(_ s: Session, api: API?) async {
        guard let api else { return offline() }
        handoffs.watch(s.name)
        do {
            _ = try await api.handoff(name: s.name)
        } catch {
            handoffs.forget(s.name)
            if case .server(let message)? = error as? APIError {
                failure = HandoffText.failure(message)
            } else {
                failure = "Couldn't continue in a new session: " + Store.words(for: error)
            }
        }
    }

    /// The handoffs asked for here whose new session just started (to open); one that failed says why.
    func handoffNews(_ sessions: [Session]) -> [String] {
        guard !handoffs.isEmpty else { return [] }
        var started: [String] = []
        for n in handoffs.news(sessions) {
            if let child = n.child { started.append(child) } else { failure = "The handoff didn't finish: " + (n.error ?? "") }
        }
        return started
    }

    private func offline() { failure = Store.words(for: APIError.offline) }

    /// blimpd's refusal in the words to show; anything else as the app says it.
    static func words(_ error: Error) -> String {
        if case .server(let message)? = error as? APIError { return PromptChoices.failure(message) }
        return Store.words(for: error)
    }
}
