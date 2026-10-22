// A chat with nothing running: the project's inbox (Send starts Claude in the project with your message), or a
// past conversation to read (Send resumes it with your message). Nothing starts until Send. The box has the mic
// (the words stay in it to read before Send), and what's typed is kept per project and per past conversation.
import BlimpKit
import SwiftUI

struct StartView: View {
    let dir: String
    /// nil: the project's inbox, above the box.
    let past: Conversation?
    var inbox: InboxView? = nil
    /// Set: the box takes the keyboard (the drawer's New session), and it's set back.
    var takeFocus: Binding<Bool>? = nil
    /// The session Send started: the chat becomes it.
    let onStarted: (String) -> Void
    @Environment(Store.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var dictation = Dictation()
    @State private var starting = false
    @State private var failure: String?
    @State private var messages: [ChatMessage] = []
    @State private var loaded = false

    private static let bottom = "bottom"

    var body: some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    if dictation.preparing {
                        Text("Getting speech ready…").font(.caption).foregroundStyle(.secondary)
                    } else if let note = dictation.note {
                        Text(note).font(.caption).foregroundStyle(.secondary)
                    }
                    if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
                    InputBar(text: $draft, sending: starting, listening: dictation.listening, onSend: send,
                             onMicDown: { dictation.down(text: draft, vocabulary: vocabulary) },
                             onMicUp: { _ in micUp() },
                             placeholder: past == nil ? "Ask Claude in \(Drawer.name(of: dir))" : "Message to pick it up again",
                             takeFocus: takeFocus)
                }
                .padding(.horizontal)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .background(.bar)
            }
            .task { await load() }
            .keepsDraft($draft, key: draftKey)
            .onChange(of: dictation.live) { _, live in if dictation.on { draft = live } }
            // Leaving the screen or the app stops the mic; the words stay in the box.
            .onDisappear { micUp() }
            .onChange(of: scenePhase) { _, phase in if phase == .background { micUp() } }
    }

    private var draftKey: String { past.map { "past:" + $0.sessionId } ?? "inbox:" + dir }

    private var vocabulary: [String] {
        [Drawer.name(of: dir)] + store.sessions.map(\.title)
    }

    private func micUp() {
        Task { if let text = await dictation.up() { draft = text } }
    }

    @ViewBuilder private var content: some View {
        if let inbox {
            inbox.scrollDismissesKeyboard(.interactively)
        } else {
            messageList
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(messages.filter { $0.role != .tool }) { MessageRow(message: $0) }
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding(.horizontal)
                .padding(.top, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            // The messages come after the screen has laid out: open at the newest.
            .onChange(of: messages) { Task { @MainActor in proxy.scrollTo(Self.bottom, anchor: .bottom) } }
            .overlay { empty }
        }
    }

    @ViewBuilder private var empty: some View {
        if !loaded {
            ProgressView()
        } else if messages.isEmpty {
            Text("No messages to show.").foregroundStyle(.secondary)
        }
    }

    /// A past conversation's messages; opening it counts as reading it, here and on the Mac.
    private func load() async {
        guard let past, let api = store.api else { return }
        messages = (try? await api.messages(dir: dir, conversation: past.sessionId)) ?? []
        loaded = true
        if past.unread == true { try? await api.seen(past.sessionId) }
    }

    /// The box clears only once the session started (keeping anything typed since); a failure says why and
    /// keeps the words.
    private func send() {
        let sent = draft
        let text = sent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !starting else { return }
        starting = true
        failure = nil
        Task {
            defer { starting = false }
            do {
                let name = try await store.start(dir: dir, resume: past?.sessionId, prompt: text)
                let left = DraftText.afterSend(draft, sent: sent)
                draft = left
                // Saved here: the chat becomes the new session at once, so keepsDraft never sees the box empty.
                DraftBox.set(left, for: draftKey)
                onStarted(name)
            } catch {
                failure = Store.words(for: error)
            }
        }
    }
}
