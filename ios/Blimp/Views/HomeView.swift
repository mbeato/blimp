// The home screen: what is waiting on you, then sessions by project.
import BlimpKit
import SwiftUI

struct HomeView: View {
    @Environment(Store.self) private var store
    @State private var pendingEnd: Session?
    @State private var showSettings = false
    @State private var folders: [RecentFolder] = []

    var body: some View {
        NavigationStack {
            List {
                if !store.home.waiting.isEmpty {
                    Section("Waiting") {
                        ForEach(store.home.waiting) { row($0) }
                    }
                }
                ForEach(store.home.projects) { group in
                    Section {
                        ForEach(group.sessions) { row($0) }
                    } header: {
                        NavigationLink(value: ProjectRoute(dir: group.dir)) {
                            HStack {
                                Text(group.name).font(.headline).foregroundStyle(.primary)
                                if group.waiting { Circle().fill(.orange).frame(width: 8, height: 8) }
                                Spacer()
                                Text("\(group.sessions.count)").foregroundStyle(.secondary)
                                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                            }
                            .textCase(nil)
                        }
                    }
                }
                if store.home.projects.isEmpty {
                    Section {
                        Text("No sessions running. Open a project to start one.").foregroundStyle(.secondary)
                    }
                    if !folders.isEmpty {
                        Section("Recent folders") {
                            ForEach(folders, id: \.dir) { folder in
                                NavigationLink(value: ProjectRoute(dir: folder.dir)) {
                                    VStack(alignment: .leading) {
                                        Text(name(of: folder.dir))
                                        Text(folder.dir).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .refreshable { store.connect() }
            .task(id: FolderKey(empty: store.home.projects.isEmpty, online: store.connection == .online)) {
                guard store.home.projects.isEmpty, let api = store.api else { return }
                folders = (try? await api.folders()) ?? []
            }
            .safeAreaInset(edge: .top, spacing: 0) { StatusBar(connection: store.connection) }
            .navigationTitle("blimp")
            .toolbar {
                Button("Settings", systemImage: "gearshape") { showSettings = true }
            }
            .navigationDestination(for: SessionRoute.self) { SessionDestination(name: $0.name) }
            .navigationDestination(for: ProjectRoute.self) { ProjectView(group: group(for: $0.dir)) }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .endConfirmation($pendingEnd, store: store)
        }
    }

    private func row(_ session: Session) -> some View {
        NavigationLink(value: SessionRoute(name: session.name)) { SessionRow(session: session) }
            .endSwipe(session, pending: $pendingEnd)
    }

    private func group(for dir: String) -> ProjectGroup {
        store.home.projects.first { $0.dir == dir }
            ?? ProjectGroup(dir: dir, name: name(of: dir), sessions: [], waiting: false, activity: 0)
    }

    private func name(of dir: String) -> String {
        dir.split(separator: "/").last.map(String.init) ?? dir
    }
}

private struct FolderKey: Equatable {
    let empty: Bool
    let online: Bool
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

// Task 6 fills this in.
struct SettingsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Button("Sign out", role: .destructive) {
                    store.signOut()
                    dismiss()
                }
            }
            .navigationTitle("Settings")
        }
    }
}
