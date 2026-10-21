// A chat with nothing running: the project's inbox (Send starts Claude in the project with your message), or a
// past conversation to read (Send resumes it with your message). Nothing starts until Send.
import BlimpKit
import SwiftUI

struct StartView: View {
    let dir: String
    /// nil: the project's inbox, above the box.
    let past: Conversation?
    var inbox: InboxView? = nil
    /// The session Send started: the chat becomes it.
    let onStarted: (String) -> Void
    @Environment(Store.self) private var store
    @State private var draft = ""
    @State private var starting = false
    @State private var failure: String?
    @State private var messages: [ChatMessage] = []
    @State private var loaded = false

    private static let bottom = "bottom"

    var body: some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
                    InputBar(text: $draft, sending: starting, listening: false, onSend: send, onMicDown: nil, onMicUp: nil,
                             placeholder: past == nil ? "Ask Claude in \(Drawer.name(of: dir))" : "Message to pick it up again")
                }
                .padding(.horizontal)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .background(.bar)
            }
            .task { await load() }
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

    /// The box clears only once the session started; a failure says why and keeps the words.
    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !starting else { return }
        starting = true
        failure = nil
        Task {
            defer { starting = false }
            do {
                let name = try await store.start(dir: dir, resume: past?.sessionId, prompt: text)
                draft = ""
                onStarted(name)
            } catch {
                failure = Store.words(for: error)
            }
        }
    }
}
