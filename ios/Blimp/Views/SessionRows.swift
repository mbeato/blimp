// Small pieces shared by Home and Project: a session row, the "end it?" question, a plain-words alert.
import BlimpKit
import SwiftUI

struct SessionRoute: Hashable {
    let name: String
}

struct ProjectRoute: Hashable {
    let dir: String
}

struct SessionRow: View {
    let session: Session

    var body: some View {
        HStack(spacing: 12) {
            StateMark(state: session.state)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title).lineLimit(1)
                HStack(spacing: 6) {
                    if let label = session.label, !label.isEmpty {
                        Text(label)
                            .font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                    }
                    Text(ago(ms: session.activity)).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct StateMark: View {
    let state: SessionState

    var body: some View {
        Group {
            switch state {
            case .working: ProgressView().controlSize(.small)
            case .waiting: Circle().fill(.orange)
            case .done: Circle().strokeBorder(.secondary, lineWidth: 1.5)
            case .unknown: Image(systemName: "terminal").foregroundStyle(.secondary)
            }
        }
        .frame(width: 14, height: 14)
        .frame(width: 20)
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
    /// Swipe-to-end on a row; set `pending` to ask first.
    /// Red, but not `role: .destructive`: with that role the List removes the row itself at the tap,
    /// before the question is answered, and when blimpd's list then drops it too the List's counts
    /// disagree and UIKit aborts the app ("Invalid number of items in section").
    func endSwipe(_ session: Session, pending: Binding<Session?>) -> some View {
        swipeActions(edge: .trailing) {
            Button("End") { pending.wrappedValue = session }
                .tint(.red)
        }
    }

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
