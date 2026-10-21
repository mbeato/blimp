// The app's one screen, as chat apps have it: a chat, with the project picker above it and a drawer from the
// left that lists the project's sessions, running and past, newest activity first. A blank chat starts a session.
import BlimpKit
import SwiftUI

/// What the chat shows.
enum Opened: Equatable {
    case blank
    case session(String)
    case past(Conversation)
}

struct HomeView: View {
    @Environment(Store.self) private var store
    @State private var opened: Opened = .blank
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
        // A swipe right from the left edge opens the drawer.
        .overlay(alignment: .leading) {
            if !drawer {
                Color.clear
                    .frame(width: 16)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 10).onEnded { if $0.translation.width > 50 { drawer = true } })
            }
        }
        .overlay {
            DrawerView(open: $drawer, title: store.dir.map(Drawer.name(of:)) ?? "Sessions", rows: rows, selected: selected,
                       onPick: pick, onNew: { show(.blank) }, onSettings: { drawer = false; showSettings = true })
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .task(id: store.connection == .online) {
            guard let api = store.api else { return }
            folders = (try? await api.folders()) ?? []
            if store.dir == nil { store.dir = projects.first?.dir }
        }
        // The project's past conversations: again when the drawer opens, and as its sessions start and end.
        .task(id: EarlierKey(dir: store.dir, drawer: drawer, online: store.connection == .online,
                             running: Set(store.sessions.filter { $0.dir == store.dir }.map(\.name)))) {
            guard let dir = store.dir, let api = store.api else { return }
            earlier = (try? await api.conversations(dir: dir)) ?? []
        }
        // No project yet (a first launch): the most active one, once the sessions come.
        .onChange(of: store.sessions) { if store.dir == nil { store.dir = projects.first?.dir } }
    }

    @ViewBuilder private var chat: some View {
        switch opened {
        case .session(let name):
            SessionView(name: name) { show(.session($0)) }
        case .past(let c):
            if let dir = store.dir { StartView(dir: dir, past: c) { show(.session($0)) }.id(c.sessionId) }
        case .blank:
            if let dir = store.dir {
                StartView(dir: dir, past: nil) { show(.session($0)) }.id(dir)
            } else {
                Text("No projects yet. Start Claude in a folder on the Mac first.").foregroundStyle(.secondary).padding()
            }
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
        ToolbarItem(placement: .principal) { picker }
        ToolbarItem(placement: .topBarTrailing) {
            Button("New chat", systemImage: "square.and.pencil") { show(.blank) }
                .accessibilityIdentifier("newChat")
        }
    }

    /// The project's name with a chevron, and under it what the chat is; a tap lists the projects to pick from.
    private var picker: some View {
        Menu {
            ForEach(projects) { p in
                Button { pickProject(p.dir) } label: {
                    if p.dir == store.dir { Label(p.name, systemImage: "checkmark") } else { Text(p.name) }
                    switch p.mark {
                    case .asking: Text("Asking you something")
                    case .unread: Text("New reply")
                    case .working, .none: Text(p.dir)
                    }
                }
                .accessibilityIdentifier("project-" + p.name)
            }
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: 4) {
                    Text(store.dir.map(Drawer.name(of:)) ?? "blimp").font(.headline)
                    Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                }
                // A long name (blimpd's go up to 40 characters) gets a little smaller to fit, rather than cut off.
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
            }
            .foregroundStyle(.primary)
        }
        .accessibilityIdentifier("projectPicker")
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
        case .blank: "New chat"
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
        case .blank: nil
        case .session(let name): "session-" + name
        case .past(let c): "past-" + c.sessionId
        }
    }

    private func pick(_ row: DrawerRow) {
        switch row.item {
        case .running(let s): show(.session(s.name))
        case .past(let c): show(.past(c))
        }
    }

    private func pickProject(_ dir: String) {
        store.dir = dir
        earlier = []
        show(.blank)
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
