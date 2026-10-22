// Small pieces shared by the chat screen, the inbox and the drawer: a row's mark, its swipe and press-and-hold actions,
// "2 min. ago", the "end it?" question, a plain-words alert.
import BlimpKit
import SwiftUI

/// A row's mark: Claude asks you something (an amber question mark), a reply you haven't seen (a blue dot),
/// working (a spinner), or nothing.
struct MarkView: View {
    let mark: Mark

    var body: some View {
        Group {
            switch mark {
            case .asking:
                Image(systemName: "questionmark").font(.caption.weight(.heavy)).foregroundStyle(.orange)
                    .accessibilityLabel("Asking you something")
            case .unread:
                Circle().fill(.blue).frame(width: 9, height: 9).accessibilityLabel("New reply")
            case .working: ProgressView().controlSize(.small)
            case .none: Color.clear
            }
        }
        .frame(width: 14, height: 14)
        .frame(width: 20)
    }
}

/// A row's actions without opening it, as a swipe from `edge` and in its press-and-hold menu (which also says its
/// branch): Stop while Claude works, Mark read, Continue in new session, End (after a question); a past
/// conversation's Resume, with no first message.
struct RowMenu: ViewModifier {
    let item: DrawerRow.Item
    /// The inbox swipes from the right; the drawer from the left, as a swipe left closes it.
    let edge: HorizontalEdge
    let actions: RowActions
    /// Opens a session: the one Resume started.
    let onOpen: (String) -> Void
    @Environment(Store.self) private var store

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: edge, allowsFullSwipe: false) { swipe }
            .contextMenu { menu }
    }

    @ViewBuilder private var swipe: some View {
        switch item {
        case .running(let s):
            if s.state == .working && s.isClaude { stop(s) }
            if s.unread == true, let id = s.sessionId { markRead(id) }
            Button("End", systemImage: "xmark.circle") { actions.pendingEnd = s }
                .tint(.gray)
        case .past(let c):
            resume(c)
            if c.unread == true { markRead(c.sessionId) }
        }
    }

    @ViewBuilder private var menu: some View {
        switch item {
        case .running(let s):
            ForEach(notes(s), id: \.self) { Text($0) }
            if s.state == .working && s.isClaude { stop(s) }
            if s.unread == true, let id = s.sessionId { markRead(id) }
            if s.isClaude {
                Button("Continue in new session", systemImage: "arrow.turn.down.right") {
                    Task { await actions.handoff(s, api: store.api) }
                }
                .disabled(s.handoff?.state == .writing)
            }
            Button("End session", systemImage: "xmark.circle", role: .destructive) { actions.pendingEnd = s }
        case .past(let c):
            resume(c)
            if c.unread == true { markRead(c.sessionId) }
        }
    }

    /// Its branch, as a line at the top of the menu.
    private func notes(_ s: Session) -> [String] {
        let c = RowCaption(s, all: store.sessions, now: Date().timeIntervalSince1970 * 1000)
        return c.branch.map { [$0] } ?? []
    }

    private func stop(_ s: Session) -> some View {
        Button("Stop", systemImage: "stop.fill") { Task { await actions.stop(s, api: store.api) } }
            .tint(.red)
    }

    private func markRead(_ conversation: String) -> some View {
        Button("Mark read", systemImage: "envelope.open") { Task { await actions.markRead(conversation, api: store.api) } }
            .tint(.blue)
    }

    private func resume(_ c: Conversation) -> some View {
        Button("Resume", systemImage: "arrow.clockwise") {
            guard let dir = store.dir else { return }
            Task { if let name = await actions.resume(c, dir: dir, store: store) { onOpen(name) } }
        }
        .tint(.green)
    }
}

@MainActor private let relativeFormatter: RelativeDateTimeFormatter = {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f
}()

// Never reads "in 1 sec" if the phone's clock is a little behind the server's.
@MainActor func ago(ms: Double) -> String {
    let now = Date()
    let then = min(Date(timeIntervalSince1970: ms / 1000), now)
    return relativeFormatter.localizedString(for: then, relativeTo: now)
}

extension View {
    /// "End this session?" and the call itself; failures show in an alert.
    func endConfirmation(_ pending: Binding<Session?>, store: Store) -> some View {
        modifier(EndConfirmation(pending: pending, store: store))
    }

    func plainAlert(_ title: String, message: Binding<String?>) -> some View {
        alert(title, isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } })) {
            Button("OK") {}
        } message: {
            Text(message.wrappedValue ?? "")
        }
    }
}

private struct EndConfirmation: ViewModifier {
    @Binding var pending: Session?
    let store: Store
    @State private var failure: String?

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                "End this session? Claude's conversation is kept and can be resumed.",
                isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                titleVisibility: .visible,
                presenting: pending
            ) { session in
                Button("End", role: .destructive) {
                    Task {
                        do { try await store.end(name: session.name) } catch { failure = Store.words(for: error) }
                    }
                }
                Button("Cancel", role: .cancel) { pending = nil }
            }
            .plainAlert("Couldn't end it", message: $failure)
    }
}
