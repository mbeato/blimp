// The app's one screen, as chat apps have it: a project's inbox or a chat, and a drawer from the left (a swipe right
// anywhere, or its button) with the project picker and the project's sessions, running and past. A project opens to
// its inbox, where the box at the bottom starts a session.
import BlimpKit
import SwiftUI

/// What the chat shows.
enum Opened: Equatable {
    case inbox
    case session(String)
    case past(Conversation)
}

struct HomeView: View {
    @Environment(Store.self) private var store
    @State private var opened: Opened = .inbox
    @State private var drawer = false
    @State private var folders: [RecentFolder] = []
    @State private var earlier: [Conversation] = []
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            chat
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
                .safeAreaInset(edge: .top, spacing: 0) { StatusBar(connection: store.connection) }
        }
        // A swipe right anywhere opens the drawer: mostly sideways, so scrolling the chat never does.
        .simultaneousGesture(
            DragGesture(minimumDistance: 20).onEnded { v in
                if !drawer, v.translation.width > 60, abs(v.translation.height) < v.translation.width * 0.6 { drawer = true }
            }
        )
        .overlay {
            DrawerView(open: $drawer, dir: store.dir, projects: projects, onProject: pickProject, rows: rows, selected: selected,
                       onPick: pick, onInbox: { show(.inbox) }, onSettings: { drawer = false; showSettings = true })
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .task(id: store.connection == .online) {
            guard let api = store.api else { return }
            folders = (try? await api.folders()) ?? []
            if store.dir == nil { store.dir = projects.first?.dir }
        }
        // The project's past conversations: again when the drawer or the inbox opens, and as its sessions start and end.
        .task(id: EarlierKey(dir: store.dir, drawer: drawer, inbox: opened == .inbox, online: store.connection == .online,
                             running: Set(store.sessions.filter { $0.dir == store.dir }.map(\.name)))) {
            guard let dir = store.dir, let api = store.api else { return }
            earlier = (try? await api.conversations(dir: dir)) ?? []
        }
        // No project yet (a first launch): the most active one, once the sessions come.
        .onChange(of: store.sessions) { if store.dir == nil { store.dir = projects.first?.dir } }
    }

    @ViewBuilder private var chat: some View {
        switch opened {
        case .inbox:
            if let dir = store.dir {
                StartView(dir: dir, past: nil,
                          inbox: InboxView(dir: dir, inbox: Inbox(dir: dir, sessions: store.sessions, earlier: earlier), rows: rows, onPick: open)) {
                    show(.session($0))
                }
                .id(dir)
            } else {
                Text("No projects yet. Start Claude in a folder on the Mac first.").foregroundStyle(.secondary).padding()
            }
        case .session(let name):
            SessionView(name: name, onInbox: { show(.inbox) }) { show(.session($0)) }
        case .past(let c):
            if let dir = store.dir { StartView(dir: dir, past: c) { show(.session($0)) }.id(c.sessionId) }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button { drawer = true } label: {
                Image(systemName: "line.3.horizontal")
                    .overlay(alignment: .topTrailing) { badge.offset(x: 5, y: -3) }
            }
            .accessibilityLabel(badgeLabel.map { "Sessions, \($0)" } ?? "Sessions")
            .accessibilityIdentifier("drawerButton")
        }
        ToolbarItem(placement: .principal) { title }
        // In a session, its own toolbar has Inbox, after the speaker.
        if case .past = opened {
            ToolbarItem(placement: .topBarTrailing) { InboxButton { show(.inbox) } }
        }
    }

    /// What the chat is, and under it the project's name (the drawer has the picker).
    private var title: some View {
        VStack(spacing: 0) {
            // A long name (blimpd's go up to 40 characters) gets a little smaller to fit, rather than cut off.
            Text(subtitle).font(.headline).lineLimit(1).minimumScaleFactor(0.75)
            Text(store.dir.map(Drawer.name(of:)) ?? "blimp").font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("screenTitle")
    }

    @ViewBuilder private var badge: some View {
        switch Drawer.others(store.sessions, onScreen: onScreen) {
        case .asking: Image(systemName: "questionmark").font(.system(size: 9, weight: .heavy)).foregroundStyle(.orange)
        case .unread: Circle().fill(.blue).frame(width: 8, height: 8)
        case .working, .none: EmptyView()
        }
    }

    private var badgeLabel: String? {
        switch Drawer.others(store.sessions, onScreen: onScreen) {
        case .asking: "one is asking you something"
        case .unread: "new replies"
        case .working, .none: nil
        }
    }

    private var onScreen: String? {
        if case .session(let name) = opened { return name }
        return nil
    }

    private var subtitle: String {
        switch opened {
        case .inbox: "Inbox"
        case .session(let name): store.sessions.first { $0.name == name }?.title ?? "Starting…"
        case .past(let c): c.title
        }
    }

    private var projects: [ProjectChoice] { Drawer.projects(sessions: store.sessions, recent: folders) }

    private var rows: [DrawerRow] {
        guard let dir = store.dir else { return [] }
        return Drawer.rows(dir: dir, sessions: store.sessions, earlier: earlier)
    }

    private var selected: String? {
        switch opened {
        case .inbox: nil
        case .session(let name): "session-" + name
        case .past(let c): "past-" + c.sessionId
        }
    }

    private func pick(_ row: DrawerRow) { open(row.item) }

    private func open(_ item: DrawerRow.Item) {
        switch item {
        case .running(let s): show(.session(s.name))
        case .past(let c): show(.past(c))
        }
    }

    private func pickProject(_ dir: String) {
        store.dir = dir
        earlier = []
        show(.inbox)
    }

    /// A session from another project (a banner's) brings its project along.
    private func show(_ o: Opened) {
        if case .session(let name) = o, let s = store.sessions.first(where: { $0.name == name }), s.dir != store.dir {
            store.dir = s.dir
            earlier = []
        }
        opened = o
        drawer = false
    }
}

private struct EarlierKey: Equatable {
    let dir: String?
    let drawer: Bool
    let inbox: Bool
    let online: Bool
    let running: Set<String>
}

private struct StatusBar: View {
    let connection: Connection

    var body: some View {
        if let text {
            Text(text)
                .font(.footnote)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(.bar)
        }
    }

    private var text: String? {
        switch connection {
        case .online, .unauthorized: nil
        case .connecting: "Reconnecting…"
        case .offline(let reason): reason
        }
    }
}
