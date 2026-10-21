// The drawer from the left: the project picker, the project's inbox (where a new chat starts), its running sessions, then its past
// conversations folded under Earlier (each newest activity first, with its mark), and Settings. A tap opens one;
// press and hold a running one to end it. A swipe left, or a tap beside it, closes the drawer.
import BlimpKit
import SwiftUI

struct DrawerView: View {
    @Binding var open: Bool
    /// The project shown, and the ones the picker lists.
    let dir: String?
    let projects: [ProjectChoice]
    let onProject: (String) -> Void
    let rows: [DrawerRow]
    /// The row of what the chat shows.
    let selected: String?
    let onPick: (DrawerRow) -> Void
    let onInbox: () -> Void
    let onSettings: () -> Void
    @Environment(Store.self) private var store
    @State private var pendingEnd: Session?
    /// Earlier folds away (folded at first), as on the Mac; kept on this phone.
    @AppStorage("drawerEarlierOpen") private var earlierOpen = false
    @GestureState private var drag: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let width = min(geo.size.width * 0.84, 340)
            // Closed, it isn't there at all, not only off screen: VoiceOver and the tests would still find it.
            ZStack(alignment: .leading) {
                if open {
                    Color.black.opacity(0.3)
                        .ignoresSafeArea()
                        .onTapGesture { open = false }
                        .accessibilityHidden(true)
                        .transition(.opacity)
                    panel
                        .frame(width: width)
                        .background(Color(.systemBackground).ignoresSafeArea())
                        .offset(x: min(0, drag))
                        .transition(.move(edge: .leading))
                        .simultaneousGesture(
                            DragGesture(minimumDistance: 20)
                                .updating($drag) { v, state, _ in if abs(v.translation.width) > abs(v.translation.height) { state = v.translation.width } }
                                .onEnded { v in if v.translation.width < -60, abs(v.translation.width) > abs(v.translation.height) { open = false } }
                        )
                }
            }
            .animation(.snappy, value: open)
            .animation(.interactiveSpring, value: drag)
        }
        .endConfirmation($pendingEnd, store: store)
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            picker.padding(.horizontal).padding(.top, 12).padding(.bottom, 8)
            Button(action: onInbox) {
                Label("Inbox", systemImage: "tray").frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .accessibilityIdentifier("drawerInbox")
            List {
                if !active.isEmpty {
                    Section("Active") { ForEach(active) { rowButton($0) } }
                }
                if !past.isEmpty {
                    Section {
                        if earlierOpen { ForEach(past) { rowButton($0) } }
                    } header: {
                        Button { earlierOpen.toggle() } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(earlierOpen ? 90 : 0))
                                Text("Earlier")
                                Text("\(past.count)").foregroundStyle(.tertiary)
                            }
                        }
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(earlierOpen ? "Earlier, \(past.count), open" : "Earlier, \(past.count), folded")
                        .accessibilityIdentifier("drawerEarlier")
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
    }

    private var active: [DrawerRow] { rows.filter { if case .running = $0.item { true } else { false } } }
    private var past: [DrawerRow] { rows.filter { if case .past = $0.item { true } else { false } } }

    private func rowButton(_ row: DrawerRow) -> some View {
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

    /// The project's name with a chevron; a tap lists the projects to pick from, each with its top mark.
    private var picker: some View {
        Menu {
            ForEach(projects) { p in
                Button { onProject(p.dir) } label: {
                    if p.dir == dir { Label(p.name, systemImage: "checkmark") } else { Text(p.name) }
                    switch p.mark {
                    case .asking: Text("Asking you something")
                    case .unread: Text("New reply")
                    case .working, .none: Text(p.dir)
                    }
                }
                .accessibilityIdentifier("project-" + p.name)
            }
        } label: {
            HStack(spacing: 4) {
                Text(dir.map(Drawer.name(of:)) ?? "Projects").font(.title3.bold()).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption.weight(.bold))
            }
            .foregroundStyle(.primary)
        }
        .accessibilityIdentifier("projectPicker")
    }
}

struct RowLabel: View {
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
