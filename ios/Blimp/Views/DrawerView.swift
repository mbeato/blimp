// The drawer from the left: the project picker, the project's inbox (where a new chat starts), its running sessions, then its past
// conversations folded under Earlier (each newest activity first, with its mark), and Settings. A tap opens one;
// press and hold a running one to end it. It follows the finger: a swipe right in the chat pulls it out (HomeView's
// `pull`), a swipe left on it or beside it pushes it back, and letting go settles it open or closed by where it is
// and how fast it went. A tap beside it closes it too.
import BlimpKit
import SwiftUI

struct DrawerView: View {
    @Binding var open: Bool
    /// How far a swipe in the chat that's opening it has gone (HomeView), nil while there's none.
    let pull: CGFloat?
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
    /// A swipe left that's pushing it back: how far it has gone (at most 0), nil while there's none.
    @State private var push: CGFloat?
    /// Whether the swipe going on is sideways (decided once, at its start), so scrolling the list never moves it.
    @State private var sideways: Bool?

    var body: some View {
        GeometryReader { geo in
            let width = min(geo.size.width * 0.84, 340)
            // How far out it is, 0 (closed) to width (open): where the finger has it while one moves it.
            let out = pull.map { min(width, max(0, $0)) } ?? (open ? min(width, max(0, width + (push ?? 0))) : 0)
            let still = pull == nil && push == nil
            ZStack(alignment: .leading) {
                Color.black.opacity(0.3 * out / width)
                    .ignoresSafeArea()
                    .onTapGesture { open = false }
                    .accessibilityHidden(true)
                panel
                    .frame(width: width)
                    .background(Color(.systemBackground).ignoresSafeArea())
                    .offset(x: out - width)
            }
            .simultaneousGesture(closing(width: width), including: open ? .all : .none)
            // Closed, it's off screen, and VoiceOver, the tests and taps don't find it there.
            .allowsHitTesting(open)
            .accessibilityHidden(!open && pull == nil)
            .animation(.snappy, value: open)
            .animation(.snappy, value: still)
        }
        .endConfirmation($pendingEnd, store: store)
    }

    private func closing(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { v in
                if sideways == nil { sideways = abs(v.translation.width) > abs(v.translation.height) }
                if sideways == true { push = min(0, v.translation.width) }
            }
            .onEnded { v in
                defer { sideways = nil }
                guard sideways == true else { return }
                // Let go past a third of the way, or flung left: it closes; else back open.
                let close = v.translation.width < -width / 3 || v.predictedEndTranslation.width < -width * 0.6
                withAnimation(.snappy) {
                    if close { open = false }
                    push = nil
                }
            }
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
                        // A row, not the section's header: a header doesn't reliably take taps.
                        Button { earlierOpen.toggle() } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(earlierOpen ? 90 : 0))
                                Text("Earlier")
                                Text("\(past.count)").foregroundStyle(.tertiary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                        .accessibilityLabel(earlierOpen ? "Earlier, \(past.count), open" : "Earlier, \(past.count), folded")
                        .accessibilityIdentifier("drawerEarlier")
                        if earlierOpen { ForEach(past) { rowButton($0) } }
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
        .tint(.primary)
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
