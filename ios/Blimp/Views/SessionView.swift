// A session as a chat: the messages, what Claude is waiting on as buttons, and a box to type into.
import BlimpKit
import SwiftUI

struct SessionView: View {
    let name: String
    /// After Resume, the new session takes this screen's place.
    @State private var resumed: String?

    var body: some View {
        let current = resumed ?? name
        ChatScreen(name: current) { resumed = $0 }
            .id(current)
    }
}

/// Owns the ChatModel: made when the screen first appears, its socket closed when the screen goes.
private struct ChatScreen: View {
    let name: String
    let onResumed: (String) -> Void
    @Environment(Store.self) private var store
    @State private var model: ChatModel?

    var body: some View {
        Group {
            if let model {
                ChatContent(model: model, onResumed: onResumed)
            } else {
                Color.clear
            }
        }
        .onAppear {
            let m = model ?? ChatModel(name: name, store: store)
            model = m
            m.open()
        }
        .onDisappear { model?.close() }
    }
}

private struct ChatContent: View {
    let model: ChatModel
    let onResumed: (String) -> Void
    @State private var draft = ""
    @State private var expanded: Set<String> = []
    @State private var atBottom = true
    @State private var unseen = false
    @State private var resuming = false

    private static let bottom = "bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(model.log.messages) { message in
                        MessageRow(message: message, expanded: expanded.contains(message.id)) { toggle(message.id) }
                    }
                    if model.working { WorkingRow() }
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding(.horizontal)
                .padding(.top, 12)
            }
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onScrollGeometryChange(for: Bool.self) { g in
                g.visibleRect.maxY >= g.contentSize.height - 40
            } action: { _, bottom in
                atBottom = bottom
                if bottom { unseen = false }
            }
            // a new or longer last message: follow it if you're at the bottom, else say so
            .onChange(of: model.log.messages.last) { _, last in
                guard last != nil else { return }
                if atBottom { proxy.scrollTo(Self.bottom, anchor: .bottom) } else { unseen = true }
            }
            .onChange(of: model.working) {
                if atBottom { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            .overlay { empty }
            .safeAreaInset(edge: .top, spacing: 0) {
                if model.reconnecting && !model.ended { ReconnectingBar() }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 8) {
                    if unseen {
                        Button {
                            withAnimation { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                            unseen = false
                        } label: {
                            Label("New", systemImage: "arrow.down").font(.footnote.weight(.semibold))
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .background(.regularMaterial, in: Capsule())
                    }
                    controls
                        .padding(.horizontal)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity)
                        .background(.bar)
                }
            }
        }
        .navigationTitle(model.title)
        .navigationSubtitle(model.folder)
        .navigationBarTitleDisplayMode(.inline)
        .onReturnFromBackground { model.reconnectNow() }
        // Links in Claude's replies: http and https open in Safari on tap, anything else does nothing.
        .environment(\.openURL, OpenURLAction { Inline.safe($0) ? .systemAction : .discarded })
    }

    /// What sits under the chat: the end of it, a pointer to the Mac, or the prompt and the input box.
    @ViewBuilder private var controls: some View {
        if model.ended {
            VStack(spacing: 8) {
                Text("Session ended").font(.headline)
                if model.canResume {
                    Button("Resume") { Task { await resume() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(resuming)
                }
                errorLine
            }
        } else if model.macOnly {
            Text("Open on Mac to use this session").foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if let prompt = model.prompt {
                    PromptBar(prompt: prompt, busy: model.answering) { pick, at in
                        Task { await model.answer(pick, at: at) }
                    }
                    Divider()
                }
                errorLine
                InputBar(
                    text: $draft, working: model.working, sending: model.sendingText, stopping: model.stopping,
                    onSend: send, onStop: { Task { await model.stop() } })
            }
        }
    }

    @ViewBuilder private var errorLine: some View {
        if let error = model.lastError {
            Text(error).font(.caption).foregroundStyle(.red)
        }
    }

    @ViewBuilder private var empty: some View {
        if model.log.messages.isEmpty && !model.working && !model.ended && !model.macOnly {
            if !model.loaded {
                ProgressView()
            } else {
                Text("No messages yet.").foregroundStyle(.secondary)
            }
        }
    }

    private func toggle(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }

    /// The box clears only once blimpd has the text; anything typed meanwhile stays.
    private func send() {
        let text = draft
        Task {
            if await model.send(text), draft.hasPrefix(text) {
                draft.removeFirst(text.count)
            }
        }
    }

    private func resume() async {
        resuming = true
        defer { resuming = false }
        if let name = await model.resume() { onResumed(name) }
    }
}

private struct ReconnectingBar: View {
    var body: some View {
        Text("Reconnecting…")
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(.bar)
    }
}
