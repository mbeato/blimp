// The drawer from the left: New chat, the project's sessions (running and past, newest activity first, each with
// its mark), and Settings. A tap opens one; press and hold a running one to end it. A swipe left, or a tap beside
// it, closes the drawer.
import BlimpKit
import SwiftUI

struct DrawerView: View {
    @Binding var open: Bool
    let title: String
    let rows: [DrawerRow]
    /// The row of what the chat shows.
    let selected: String?
    let onPick: (DrawerRow) -> Void
    let onNew: () -> Void
    let onSettings: () -> Void
    @Environment(Store.self) private var store
    @State private var pendingEnd: Session?
    @GestureState private var drag: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let width = min(geo.size.width * 0.84, 340)
            ZStack(alignment: .leading) {
                Color.black.opacity(open ? 0.3 : 0)
                    .ignoresSafeArea()
                    .onTapGesture { open = false }
                    .allowsHitTesting(open)
                    .accessibilityHidden(true)
                panel
                    .frame(width: width)
                    .background(Color(.systemBackground).ignoresSafeArea())
                    .offset(x: open ? min(0, drag) : -width - 24)
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 20)
                            .updating($drag) { v, state, _ in if abs(v.translation.width) > abs(v.translation.height) { state = v.translation.width } }
                            .onEnded { v in if v.translation.width < -60, abs(v.translation.width) > abs(v.translation.height) { open = false } }
                    )
            }
            .animation(.snappy, value: open)
            .animation(.interactiveSpring, value: drag)
        }
        .endConfirmation($pendingEnd, store: store)
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.title3.bold()).padding(.horizontal).padding(.top, 12).padding(.bottom, 8)
            Button(action: onNew) {
                Label("New chat", systemImage: "square.and.pencil").frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .accessibilityIdentifier("drawerNewChat")
            List {
                ForEach(rows) { row in
                    Button { onPick(row) } label: { RowLabel(row: row) }
                        .foregroundStyle(.primary)
                        .listRowBackground(row.id == selected ? Color.secondary.opacity(0.15) : Color.clear)
                        .accessibilityIdentifier(row.id)
                        .contextMenu {
                            if case .running(let s) = row.item {
                                Button("End session", systemImage: "xmark.circle") { pendingEnd = s }
                            }
                        }
                }
            }
            .listStyle(.plain)
            .overlay {
                if rows.isEmpty { Text("No sessions here yet.").foregroundStyle(.secondary) }
            }
            Divider()
            Button(action: onSettings) {
                Label("Settings", systemImage: "gearshape").frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding()
            .accessibilityIdentifier("settingsButton")
        }
        .accessibilityAddTraits(.isModal)
        .accessibilityHidden(!open)
    }
}

private struct RowLabel: View {
    let row: DrawerRow

    var body: some View {
        HStack(spacing: 10) {
            MarkView(mark: row.mark)
            VStack(alignment: .leading, spacing: 2) {
                // two lines for a long name, rather than cut off
                Text(row.title).lineLimit(2)
                Text(ago(ms: row.activity)).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
