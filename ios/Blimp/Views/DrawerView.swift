// The drawer from the left. Down its left side, the projects in a column: two letters each, with the mark of the
// session there that needs you most. A tap shows that project's inbox behind the drawer and its sessions in it, and
// the drawer stays open; press and hold one to hide it. At the column's foot, + (open a folder on the computer as a
// project, FolderBrowserView), Feed (while the feed is on, with a dot while it has cards not seen) and Settings. Above
// the projects, while the assistant runs, its blimp icon with its mark opens its chat.
// Beside it the project's name, New session (the inbox's box, ready to type into), its running sessions, the
// project's browser tabs (a dot on ones a session opened; a tap opens one full screen, New Tab opens one, a swipe
// right closes one), then its past conversations folded under Earlier (each newest activity first, with its mark, and
// under its title its branch, jobs and handoff). A tap opens one; a swipe right on a row or press and hold has its
// actions (Stop, Mark read, End; Resume a past one). It follows the finger: a swipe right in the chat pulls it out
// (HomeView's `pull`), a swipe left anywhere on it or beside it pushes it back, and letting go settles it open or
// closed by where it is and how fast it went. A tap beside it closes it too.
import BlimpKit
import SwiftUI

struct DrawerView: View {
    @Binding var open: Bool
    /// How far a swipe in the chat that's opening it has gone (HomeView), nil while there's none.
    let pull: CGFloat?
    /// The project shown, and the ones the strip lists.
    let dir: String?
    let projects: [ProjectChoice]
    /// Shows a project's inbox behind the drawer, which stays open with its sessions.
    let onProject: (String) -> Void
    /// Hides a project from the strip (press and hold its icon).
    let onHide: (String) -> Void
    /// Opens the folder browser (+ at the column's foot, or the button when there's no project yet).
    let onOpenFolder: () -> Void
    let rows: [DrawerRow]
    /// The row of what the chat shows.
    let selected: String?
    let onPick: (DrawerRow) -> Void
    /// Opens the box that starts a session in this project.
    let onNewSession: () -> Void
    let onSettings: () -> Void
    /// Opens the feed (FeedView).
    let onFeed: () -> Void
    /// Opens the assistant's chat (its icon at the top of the strip).
    let onAssistant: () -> Void
    let actions: RowActions
    /// Opens a session: the one a row's Resume started.
    let onOpen: (String) -> Void
    /// The project's server browser tabs.
    let tabs: [BrowserTab]
    let onTab: (BrowserTab) -> Void
    let onNewTab: () -> Void
    let onCloseTab: (BrowserTab) -> Void
    @Environment(Store.self) private var store
    /// Earlier folds away (folded at first), as on the Mac; kept on this phone.
    @AppStorage("drawerEarlierOpen") private var earlierOpen = false
    /// A swipe left that's pushing it back: how far it has gone (at most 0), nil while there's none.
    @State private var push: CGFloat?
    /// Whether the swipe going on is sideways (decided once, at its start), so scrolling the list never moves it.
    @State private var sideways: Bool?
    /// The strip's order, read as the drawer comes out (Strip.held), so an icon never moves under a finger.
    @State private var order: [String] = []

    var body: some View {
        GeometryReader { geo in
            let width = min(geo.size.width * 0.84, 340)
            // How far out it is, 0 (closed) to width (open): where the finger has it while one moves it.
            let out = pull.map { min(width, max(0, $0)) } ?? (open ? min(width, max(0, width + (push ?? 0))) : 0)
            let still = pull == nil && push == nil
            ZStack(alignment: .leading) {
                // Closed, it isn't there at all, not only off screen: VoiceOver and the tests would still find it.
                // While a swipe pulls it out it is, following the finger.
                if open || pull != nil {
                    Color.black.opacity(0.3 * out / width)
                        .ignoresSafeArea()
                        .onTapGesture { open = false }
                        .accessibilityHidden(true)
                        .transition(.opacity)
                    panel
                        .frame(width: width)
                        .background(Color(.systemBackground).ignoresSafeArea())
                        .offset(x: out - width)
                        .transition(.move(edge: .leading))
                }
            }
            .simultaneousGesture(closing(width: width), including: open ? .all : .none)
            .allowsHitTesting(open)
            .animation(.snappy, value: open)
            .animation(.snappy, value: still)
        }
    }

    private func closing(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .onChanged { v in
                if sideways == nil {
                    sideways = abs(v.translation.width) > abs(v.translation.height)
                }
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
        HStack(spacing: 0) {
            strip
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                header.padding(.horizontal).padding(.top, 12).padding(.bottom, 8)
                if dir == nil {
                    empty
                } else {
                    newSession.padding(.horizontal).padding(.bottom, 8)
                    list
                }
            }
        }
        .onAppear { order = projects.map(\.dir) }
        .accessibilityAddTraits(.isModal)
    }

    private var list: some View {
        List {
            if rows.isEmpty {
                Text("No sessions here yet.").foregroundStyle(.secondary).listRowSeparator(.hidden)
            }
            if !active.isEmpty {
                Section("Active") { ForEach(active) { rowButton($0) } }
            }
            Section("Browser") {
                ForEach(tabs) { tabRow($0) }
                Button(action: onNewTab) {
                    Label("New Tab", systemImage: "plus").frame(maxWidth: .infinity, alignment: .leading)
                }
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("drawerNewTab")
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
    }

    /// The projects in a column down the drawer's left side, two letters each with their mark, the one shown lit; the
    /// column scrolls when they don't all fit. Above it, while the assistant runs, the assistant's icon and a thin line.
    /// Its foot, always in sight: + (open a folder), Feed (while it's on) and Settings.
    private var strip: some View {
        VStack(spacing: 0) {
            if let assistant {
                assistantIcon(assistant)
                    .padding(.top, 12)
                    .padding(.bottom, 10)
                Divider().frame(width: 40)
            }
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(Strip.held(projects, order: order, shown: dir)) { stripIcon($0) }
                }
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            Button(action: onOpenFolder) {
                Image(systemName: "plus")
                    .font(.title3.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])))
            }
            .foregroundStyle(.secondary)
            .accessibilityLabel("Open a folder")
            .accessibilityIdentifier("drawerOpenFolder")
            .padding(.vertical, 8)
            if store.feedOn {
                Button(action: onFeed) {
                    Image(systemName: "newspaper")
                        .font(.title3)
                        .frame(width: 44, height: 44)
                        .overlay(alignment: .topTrailing) {
                            if store.feedUnseen > 0 {
                                Circle().fill(.tint).frame(width: 8, height: 8).offset(x: -6, y: 8)
                            }
                        }
                }
                .foregroundStyle(.secondary)
                .accessibilityLabel(store.feedUnseen > 0 ? "Feed, new cards" : "Feed")
                .accessibilityIdentifier("feedButton")
            }
            Button(action: onSettings) {
                Image(systemName: "gearshape").font(.title3).frame(width: 44, height: 44)
            }
            .foregroundStyle(.secondary)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("settingsButton")
            .padding(.bottom, 8)
        }
        .frame(width: 60)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("drawerStrip")
    }

    private func stripIcon(_ p: ProjectChoice) -> some View {
        Button { onProject(p.dir) } label: {
            Text(Strip.letters(p.name))
                .font(.subheadline.weight(.semibold))
                .frame(width: 40, height: 40)
                .background(p.dir == dir ? Color.accentColor.opacity(0.25) : Color.secondary.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: 10))
                .overlay(alignment: .topTrailing) { MarkView(mark: p.mark).offset(x: 4, y: -4) }
        }
        .foregroundStyle(.primary)
        .accessibilityLabel(Self.label(p))
        .accessibilityAddTraits(p.dir == dir ? .isSelected : [])
        .accessibilityIdentifier("strip-" + p.name)
        .contextMenu {
            Button("Hide \(p.name)", systemImage: "eye.slash") { onHide(p.dir) }
        }
    }

    /// The assistant's session while it runs (blimpd marks it).
    private var assistant: Session? { store.sessions.first { $0.assistant == true } }

    /// The assistant: the blimp, with its session's mark. A tap opens its chat, with the drawer closed.
    private func assistantIcon(_ s: Session) -> some View {
        Button(action: onAssistant) {
            BlimpMark(width: 30)
                .frame(width: 40, height: 40)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                .overlay(alignment: .topTrailing) { MarkView(mark: s.mark).offset(x: 4, y: -4) }
        }
        .accessibilityLabel(Self.assistantLabel(s.mark))
        .accessibilityIdentifier("assistantIcon")
    }

    /// "Assistant, asking you something", "Assistant, new reply", "Assistant".
    private static func assistantLabel(_ mark: Mark) -> String {
        switch mark {
        case .asking: "Assistant, asking you something"
        case .unread: "Assistant, new reply"
        case .working, .none: "Assistant"
        }
    }

    /// "blimp, asking you something", "mbeato, new reply", "api-server".
    private static func label(_ p: ProjectChoice) -> String {
        switch p.mark {
        case .asking: "\(p.name), asking you something"
        case .unread: "\(p.name), new reply"
        case .working, .none: p.name
        }
    }

    /// The project's name.
    private var header: some View {
        Text(dir.map(Drawer.name(of:)) ?? "Projects")
            .font(.title3.bold())
            .lineLimit(1)
            .accessibilityIdentifier("drawerProject")
    }

    /// New session: the project's inbox, its box ready to type into.
    private var newSession: some View {
        Button(action: onNewSession) {
            Label("New session", systemImage: "plus")
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        }
        .accessibilityIdentifier("drawerNewSession")
    }

    /// No project yet (a fresh blimpd): where to start.
    private var empty: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Open a folder on the computer to start.").foregroundStyle(.secondary)
            Button("Open a Folder", systemImage: "folder.badge.plus", action: onOpenFolder)
                .buttonStyle(.borderedProminent)
                .foregroundStyle(Color(.systemBackground))
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var active: [DrawerRow] { rows.filter { if case .running = $0.item { true } else { false } } }
    private var past: [DrawerRow] { rows.filter { if case .past = $0.item { true } else { false } } }

    private func rowButton(_ row: DrawerRow) -> some View {
        Button { onPick(row) } label: { RowLabel(row: row, sessions: store.sessions) }
            .foregroundStyle(.primary)
            .listRowBackground(row.id == selected ? Color.secondary.opacity(0.15) : Color.clear)
            .accessibilityIdentifier(row.id)
            // From the left: a swipe left closes the drawer.
            .modifier(RowMenu(item: row.item, edge: .leading, actions: actions, onOpen: onOpen))
    }

    /// A browser tab: a dot if a session opened it, its title, and under it its site.
    private func tabRow(_ tab: BrowserTab) -> some View {
        Button { onTab(tab) } label: {
            HStack(spacing: 10) {
                Circle().fill(tab.openedBy == nil ? Color.clear : Color.accentColor).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(tab.label).lineLimit(1)
                    Text(BrowserAddress.host(of: tab.url)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
        }
        .foregroundStyle(.primary)
        .accessibilityLabel(tab.openedBy == nil ? tab.label : "\(tab.label), opened by a session")
        .accessibilityIdentifier("tab-" + tab.id)
        // From the left, as the sessions' rows: a swipe left closes the drawer.
        .swipeActions(edge: .leading) {
            Button(role: .destructive) { onCloseTab(tab) } label: { Label("Close", systemImage: "xmark") }
        }
        .contextMenu {
            Button(role: .destructive) { onCloseTab(tab) } label: { Label("Close Tab", systemImage: "xmark") }
        }
    }
}

/// A row: its mark, its title (a session a handoff started has an arrow before it), and under it how long ago,
/// then its handoff, branch and jobs.
struct RowLabel: View {
    let row: DrawerRow
    /// Every running session, for a handoff's parent.
    var sessions: [Session] = []

    var body: some View {
        // Each minute, for the jobs' running time.
        TimelineView(.everyMinute) { context in
            content(now: context.date.timeIntervalSince1970 * 1000)
        }
    }

    private var session: Session? {
        if case .running(let s) = row.item { return s }
        return nil
    }

    private func content(now: Double) -> some View {
        let caption = session.map { RowCaption($0, all: sessions, now: now) }
        return HStack(spacing: 10) {
            MarkView(mark: row.mark)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if let continued = caption?.continued {
                        Image(systemName: "arrow.turn.down.right").font(.caption).foregroundStyle(.secondary).accessibilityLabel(continued)
                    }
                    // two lines for a long name, rather than cut off
                    Text(row.title).lineLimit(2)
                }
                Text([ago(ms: row.activity), caption?.text].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }
}
