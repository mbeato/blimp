// One project folder: its running sessions, earlier conversations, and a button to start a new one.
import BlimpKit
import SwiftUI

struct ProjectView: View {
    @Environment(Store.self) private var store
    let dir: String
    let name: String
    @State private var earlier: [Conversation] = []
    @State private var starting = false
    @State private var failure: String?
    @State private var pushed: SessionRoute?
    @State private var pendingEnd: Session?

    init(group: ProjectGroup) {
        dir = group.dir
        name = group.name
    }

    private var sessions: [Session] {
        store.home.projects.first { $0.dir == dir }?.sessions ?? []
    }

    private var earlierShown: [Conversation] {
        let running = Set(sessions.compactMap(\.sessionId))
        return earlier.filter { !running.contains($0.sessionId) }
    }

    var body: some View {
        List {
            if !sessions.isEmpty {
                Section("Running") {
                    ForEach(sessions) { session in
                        NavigationLink(value: SessionRoute(name: session.name)) { SessionRow(session: session) }
                            .endSwipe(session, pending: $pendingEnd)
                    }
                }
            }
            if !earlierShown.isEmpty {
                Section("Earlier") {
                    ForEach(earlierShown) { conversation in
                        Button {
                            Task { await start(resume: conversation.sessionId) }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(conversation.title).lineLimit(1).foregroundStyle(.primary)
                                Text(ago(ms: conversation.updatedAt)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(starting)
                    }
                }
            }
        }
        .overlay {
            if sessions.isEmpty && earlierShown.isEmpty {
                Text("Nothing here yet. Tap + to start.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle(name)
        .navigationSubtitle(dir)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button {
                Task { await start(resume: nil) }
            } label: {
                if starting { ProgressView() } else { Image(systemName: "plus") }
            }
            .disabled(starting)
            .accessibilityLabel("New session")
        }
        .task { await loadEarlier() }
        .refreshable { await loadEarlier() }
        .navigationDestination(item: $pushed) { SessionView(name: $0.name) }
        .endConfirmation($pendingEnd, store: store)
        .plainAlert("Couldn't start it", message: $failure)
    }

    private func loadEarlier() async {
        guard let api = store.api else { return }
        earlier = (try? await api.conversations(dir: dir)) ?? []
    }

    private func start(resume: String?) async {
        starting = true
        defer { starting = false }
        do {
            pushed = SessionRoute(name: try await store.start(dir: dir, resume: resume))
        } catch {
            failure = Store.words(for: error)
        }
    }
}
