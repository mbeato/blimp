// The app's one screen, as chat apps have it: a project's inbox or a chat, and a drawer from the left (a swipe right
// anywhere, or ☰ on the inbox) with the project strip, New session and the project's sessions, running and past. A
// chat's top left goes back to its project's inbox. A project opens to its inbox, where the box at the bottom starts
// a session; the drawer's New session opens it with the keyboard up.
// On any screen, a session in any project that starts waiting gives a double haptic, and away from a chat a banner
// that opens it (a chat has its own); one that finishes working gives a light tick. A row's actions (RowActions)
// live here: End's question, a failure's alert, and the new session a handoff started, which opens. A browser tab
// from the drawer opens full screen over all of it (BrowserView), and not under the lock's cover.
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
    @Environment(\.covered) private var covered
    @Environment(\.scenePhase) private var scenePhase
    @State private var opened: Opened = .inbox
    @State private var drawer = false
    /// The server browser tab open over the chat (BrowserView), by id.
    @State private var browserTab: String?
    /// The drawer's New session was tapped: the inbox's box takes the keyboard, and sets this back.
    @State private var newSession = false
    /// A swipe right that's pulling the drawer out: how far it has gone; nil while there's none.
    @State private var pull: CGFloat?
    /// Whether the swipe going on pulls the drawer (sideways and right, decided once at its start).
    @State private var pulling: Bool?
    /// Where the chat's sideways scrollers are, so a swipe that starts in one scrolls it and pulls no drawer.
    @State private var sideScrollers = SideScrollers()
    @State private var folders: [RecentFolder] = []
    /// The projects hidden from the strip (blimpd keeps the list), fetched again as the drawer opens.
    @State private var hidden: Set<String> = []
    /// Each project's past conversations, kept while another one shows, and fetched again as below.
    @State private var earlierBy: [String: [Conversation]] = [:]
    @State private var showSettings = false
    @State private var actions = RowActions()
    /// Each session's last title, for one that has ended.
    @State private var titles: [String: String] = [:]
    /// What the last session list said each one was doing, for the banner and the haptics.
    @State private var lastStates: [String: SessionState] = [:]
    @State private var banner: HomeBanner?
    @State private var waitingTicks = 0
    @State private var doneTicks = 0
    /// When the app last went to the background (ms), kept for the next launch; 0: not yet.
    @AppStorage("inboxLeftAt") private var leftAt: Double = 0
    /// Back after a while away: when it left. nil otherwise, and once a session opens.
    @State private var away: Double?

    var body: some View {
        NavigationStack {
            chat
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbar }
                .safeAreaInset(edge: .top, spacing: 0) { ConnectionBar() }
                .overlay(alignment: .top) {
                    if let banner {
                        HomeBannerView(banner: banner) { show(.session(banner.name)) }
                            .transition(.move(edge: .top).combined(with: .opacity))
                    }
                }
                .animation(.snappy, value: banner)
        }
        // A swipe right anywhere pulls the drawer out, following the finger: one that starts mostly sideways, so
        // scrolling the chat never does. Let go past 120 points, or flung right: it opens; else back closed. While
        // the drawer is open this does nothing: a swipe on it closes it (DrawerView). Nor does one that starts in
        // something that scrolls sideways (a code box, the reply chips): it scrolls that instead, as this runs
        // while a scroll view in the chat scrolls too. The keyboard goes as the drawer starts to come out.
        .simultaneousGesture(
            DragGesture(minimumDistance: 10, coordinateSpace: .global)
                .onChanged { v in
                    if drawer { return }
                    if pulling == nil {
                        let free = !sideScrollers.contain(v.startLocation)
                        pulling = free && v.translation.width > 0 && abs(v.translation.width) > abs(v.translation.height) * 1.5
                        if pulling == true { hideKeyboard() }
                    }
                    if pulling == true { pull = max(0, v.translation.width) }
                }
                .onEnded { v in
                    defer { pulling = nil }
                    guard pulling == true, !drawer else { return }
                    let open = v.translation.width > 120 || v.predictedEndTranslation.width > 260
                    withAnimation(.snappy) {
                        if open { drawer = true }
                        pull = nil
                    }
                }
        )
        .overlay {
            DrawerView(open: $drawer, pull: pull, dir: store.dir, projects: projects, onProject: pickProject, onHide: hideProject,
                       rows: rows, selected: selected,
                       onPick: pick, onNewSession: startNew,
                       onSettings: { drawer = false; showSettings = true },
                       actions: actions, onOpen: { show(.session($0)) },
                       tabs: store.dir.map { BrowserTab.inFolder(store.browserTabs, $0) } ?? [],
                       onTab: { browserTab = $0.id; drawer = false }, onNewTab: newTab, onCloseTab: closeTab)
        }
        .overlay {
            if !covered, let browserTab, let tab = store.browserTabs.first(where: { $0.id == browserTab }) {
                BrowserView(tab: tab, onClose: { self.browserTab = nil }, onSend: sendToChat, onCloseTab: { closeTab(tab) })
                    .id(tab.id)
            }
        }
        .environment(\.sideScrollers, sideScrollers)
        .sheet(isPresented: $showSettings) { SettingsView() }
        .modifier(KeepsPlace(opened: $opened, drawer: drawer))
        .endConfirmation(Binding(get: { actions.pendingEnd }, set: { actions.pendingEnd = $0 }), store: store)
        .plainAlert("Couldn't do that", message: Binding(get: { actions.failure }, set: { actions.failure = $0 }))
        .sensoryFeedback(.warning, trigger: waitingTicks)
        .sensoryFeedback(.impact(weight: .light), trigger: doneTicks)
        .task(id: store.connection == .online) {
            guard let api = store.api else { return }
            folders = (try? await api.folders()) ?? []
            hidden = Set((try? await api.hiddenFolders()) ?? [])
            if store.dir == nil { store.dir = projects.first?.dir }
        }
        // The drawer opens: the keyboard goes (☰ on the inbox), and the hidden projects and recent folders are
        // fetched again, as a session started on the Mac shows one again.
        .onChange(of: drawer) { _, open in if open { hideKeyboard() } }
        .task(id: drawer) {
            guard drawer, let api = store.api else { return }
            if let list = try? await api.hiddenFolders() { hidden = Set(list) }
            if let list = try? await api.folders() { folders = list }
        }
        // The project's past conversations: again when the drawer or the inbox opens, as its sessions start and end,
        // and after a Mark read here. The ones kept meanwhile show, so the drawer's rows are there as it opens.
        .task(id: EarlierKey(dir: store.dir, drawer: drawer, inbox: opened == .inbox, online: store.connection == .online,
                             running: Set(store.sessions.filter { $0.dir == store.dir }.map(\.name)), reads: actions.reads)) {
            guard let dir = store.dir, let api = store.api else { return }
            if let list = try? await api.conversations(dir: dir) { earlierBy[dir] = list }
        }
        .task(id: banner) {
            guard banner != nil else { return }
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { banner = nil }
        }
        .onChange(of: store.sessions) { _, sessions in
            // No project yet (a first launch): the most active one, once the sessions come.
            if store.dir == nil { store.dir = projects.first?.dir }
            changed(sessions)
        }
        // A tapped notification: its session's chat once the session list has it. The list can be a little behind
        // after the app was in the background (a session started on the Mac since), so it waits for 10 s of being
        // online (a cold launch connects first); a session that has ended by then opens nothing.
        .task(id: Push.shared.open) {
            guard let name = Push.shared.open else { return }
            var online = 0
            while online < 40 {
                if store.sessions.contains(where: { $0.name == name }) {
                    Push.shared.open = nil
                    // Close what could cover the chat.
                    browserTab = nil
                    showSettings = false
                    show(.session(name))
                    return
                }
                try? await Task.sleep(for: .milliseconds(250))
                if Task.isCancelled { return }
                if store.connection == .online { online += 1 }
            }
            Push.shared.open = nil
        }
        // Opening a chat takes its notifications away.
        .onChange(of: opened) { _, now in
            if case .session(let name) = now { Task { await Push.clear(session: name) } }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, case .session(let name) = opened { Task { await Push.clear(session: name) } }
        }
        .onAppear {
            lastStates = Arrivals.states(store.sessions)
            cameBack()
        }
        .onReturnFromBackground(cameBack)
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { leftAt = Self.now() }
        }
    }

    @ViewBuilder private var chat: some View {
        switch opened {
        case .inbox:
            if let dir = store.dir {
                StartView(dir: dir, past: nil,
                          inbox: InboxView(dir: dir, inbox: Inbox(dir: dir, sessions: store.sessions, earlier: earlier), needs: needs,
                                           sessions: store.sessions, left: away, actions: actions,
                                           onPick: open, onOpen: { show(.session($0)) }),
                          takeFocus: $newSession) {
                    show(.session($0))
                }
                .id(dir)
            } else {
                Text("No projects yet. Start Claude in a folder on the Mac first.").foregroundStyle(.secondary).padding()
            }
        case .session(let name):
            SessionView(name: name, onOpen: { show(.session($0)) })
        case .past(let c):
            if let dir = store.dir { StartView(dir: dir, past: c) { show(.session($0)) }.id(c.sessionId) }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            if opened == .inbox {
                Button { drawer = true } label: {
                    Image(systemName: "line.3.horizontal")
                        .overlay(alignment: .topTrailing) { badge.offset(x: 5, y: -3) }
                }
                .accessibilityLabel(badgeLabel.map { "Sessions, \($0)" } ?? "Sessions")
                .accessibilityIdentifier("drawerButton")
                .accessibilityHidden(covered)
            } else {
                // In a chat: back to the project's inbox, with the same mark. A swipe right opens the drawer.
                Button { show(.inbox) } label: {
                    HStack(spacing: 2) {
                        Image(systemName: "chevron.left").font(.body.weight(.semibold))
                        Text(projectName).lineLimit(1).frame(maxWidth: 120, alignment: .leading)
                    }
                    .overlay(alignment: .topTrailing) { badge.offset(x: 8, y: -3) }
                }
                .accessibilityLabel(badgeLabel.map { "Back to \(projectName), \($0)" } ?? "Back to \(projectName)")
                .accessibilityIdentifier("inboxBack")
                .accessibilityHidden(covered)
            }
        }
        ToolbarItem(placement: .principal) { title }
    }

    /// What the screen shows; on the inbox the project's name under it (in a chat the back arrow has it).
    private var title: some View {
        VStack(spacing: 0) {
            // A long name (blimpd's go up to 40 characters) gets a little smaller to fit, rather than cut off.
            Text(subtitle).font(.headline).lineLimit(1).minimumScaleFactor(0.75)
            if opened == .inbox {
                Text(projectName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("screenTitle")
        .accessibilityHidden(covered)
    }

    private var projectName: String { store.dir.map(Drawer.name(of:)) ?? "blimp" }

    /// Needs you's rule (Drawer.badge), so the badge and the band agree. Not a hidden project's sessions (but the
    /// one on screen's): nothing in the drawer would say where the mark comes from.
    private var mark: Mark {
        Drawer.badge(store.sessions.filter { !hidden.contains($0.dir) || $0.dir == store.dir }, needs: needs, onScreen: onScreen)
    }

    @ViewBuilder private var badge: some View {
        switch mark {
        case .asking: Image(systemName: "questionmark").font(.system(size: 9, weight: .heavy)).foregroundStyle(.orange)
        case .unread: Circle().fill(.blue).frame(width: 8, height: 8)
        case .working, .none: EmptyView()
        }
    }

    private var badgeLabel: String? {
        switch mark {
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
        case .session(let name): store.sessions.first { $0.name == name }?.title ?? titles[name] ?? "Starting…"
        case .past(let c): c.title
        }
    }

    private var projects: [ProjectChoice] { Drawer.projects(sessions: store.sessions, recent: folders, hidden: hidden) }

    private var earlier: [Conversation] { store.dir.flatMap { earlierBy[$0] } ?? [] }

    /// The project's sessions waiting on you, oldest first: the inbox's top, and the top-left button's mark.
    private var needs: [InboxLine] { store.dir.map { Inbox.needsYou(sessions: store.sessions, dir: $0, earlier: earlier) } ?? [] }

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

    /// The drawer's New Tab: a tab at Google in this project, open full screen.
    private func newTab() {
        guard let dir = store.dir else { return }
        Task {
            do {
                browserTab = try await store.openTab(dir: dir)
                drawer = false
            } catch {
                actions.failure = Store.words(for: error)
            }
        }
    }

    private func closeTab(_ tab: BrowserTab) {
        if browserTab == tab.id { browserTab = nil }
        Task {
            do { try await store.closeTab(tab.id) } catch { actions.failure = Store.words(for: error) }
        }
    }

    /// The browser's Send to Session: the tab goes in the open session's box, and the chat comes back.
    private var sendToChat: ((String) -> Void)? {
        guard let name = onScreen else { return nil }
        return { text in
            store.insert = DraftInsert(chat: name, text: text)
            browserTab = nil
        }
    }

    /// The drawer's New session: the project's inbox, its box ready to type into.
    private func startNew() {
        show(.inbox)
        newSession = store.dir != nil
    }

    /// A project from the strip: its inbox, behind the drawer, which stays open with its sessions.
    private func pickProject(_ dir: String) {
        store.dir = dir
        opened = .inbox
    }

    /// Hide on a strip icon: it leaves the strip at once, and blimpd keeps the list (so the Mac's recent folders
    /// leave it out too). Hiding the project on screen shows the next one's inbox. If blimpd refuses, it comes back.
    private func hideProject(_ dir: String) {
        hidden.insert(dir)
        if store.dir == dir {
            store.dir = projects.first?.dir
            opened = .inbox
        }
        Task {
            guard let api = store.api else {
                hidden.remove(dir)
                return
            }
            do {
                // Added to, not replaced: another hide may still be on its way.
                hidden.formUnion(try await api.setHidden(dir: dir, hidden: true))
            } catch {
                hidden.remove(dir)
                actions.failure = Store.words(for: error)
            }
        }
    }

    private func hideKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// A session from another project (a banner's) brings its project along. Opening one
    /// ends "since you left".
    private func show(_ o: Opened) {
        if case .session(let name) = o {
            away = nil
            if let s = store.sessions.first(where: { $0.name == name }), s.dir != store.dir { store.dir = s.dir }
        }
        opened = o
        drawer = false
    }

    /// A new session list: the titles kept, a banner and a haptic for what started waiting or finished (only while
    /// the app is in front and not under the lock cover), and the new session of a handoff asked for here.
    private func changed(_ sessions: [Session]) {
        for s in sessions where titles[s.name] != s.title { titles[s.name] = s.title }
        let news = scenePhase == .active && !covered ? Arrivals.news(before: lastStates, sessions: sessions, onScreen: onScreen) : []
        lastStates = Arrivals.states(sessions)
        if let w = news.last(where: \.waiting) {
            waitingTicks += 1
            if onScreen == nil { banner = HomeBanner(name: w.session.name, text: "\(w.session.title) is waiting") }
        } else if news.contains(where: { !$0.waiting }) {
            doneTicks += 1
        }
        if let child = actions.handoffNews(sessions).last { show(.session(child)) }
    }

    /// Back in front (or launched): after a while away, the inbox says what changed since.
    private func cameBack() {
        away = leftAt > 0 && Self.now() - leftAt >= InboxText.away ? leftAt : nil
    }

    private static func now() -> Double { Date().timeIntervalSince1970 * 1000 }
}

private struct EarlierKey: Equatable {
    let dir: String?
    let drawer: Bool
    let inbox: Bool
    let online: Bool
    let running: Set<String>
    let reads: Int
}

private struct HomeBanner: Equatable {
    let name: String
    let text: String
}

/// "<title> is waiting", sliding in at the top; a tap opens that session.
private struct HomeBannerView: View {
    let banner: HomeBanner
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Circle().fill(.orange).frame(width: 8, height: 8)
                Text(banner.text).font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .padding(.horizontal)
        .padding(.top, 6)
        .accessibilityIdentifier("waitingBanner")
    }
}

/// Where the chat's sideways scrollers (a code box, the reply chips) are on screen, so a sideways swipe that starts
/// in one scrolls it instead of pulling a drawer out (HomeView's swipe). Not observed: the frames change on every
/// step of a scroll, and only the start of a swipe reads them.
@MainActor
final class SideScrollers {
    private var frames: [UUID: CGRect] = [:]

    func set(_ id: UUID, _ frame: CGRect?) { frames[id] = frame }

    func contain(_ point: CGPoint) -> Bool { frames.values.contains { $0.contains(point) } }
}

extension EnvironmentValues {
    /// HomeView's SideScrollers; nil outside it, where no drawer is pulled.
    @Entry var sideScrollers: SideScrollers? = nil
}

extension View {
    /// Marks a view that scrolls sideways: a swipe that starts in it pulls no drawer (SideScrollers).
    func scrollsSideways() -> some View { modifier(SideScroller()) }
}

private struct SideScroller: ViewModifier {
    @Environment(\.sideScrollers) private var scrollers
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { scrollers?.set(id, $0) }
            .onDisappear { scrollers?.set(id, nil) }
    }
}
