// Small pieces shared by the chat screen and its drawer: a row's mark, "2 min. ago", the "end it?" question, a plain-words alert.
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
