// + in the drawer: the computer's folders from home down (blimpd's /fs routes reach only inside home), to open one
// as a project. A tap on a folder goes in, back goes up. Each level lists its folders, then its files greyed so you
// can tell where you are, and nothing whose name starts with ".". New Folder makes one here and goes into it; Open
// <name> opens the folder shown (HomeView's openFolder, which closes the sheet). If blimpd refuses, the sheet stays
// and says why.
import BlimpKit
import SwiftUI

struct FolderBrowserView: View {
    let home: String
    /// Opens the folder as a project; throws when blimpd refuses.
    let onOpen: @MainActor (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    /// The folders gone into from home, each a full path.
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            // dismiss is read here, not in a level: a pushed level's dismiss would only go back up.
            FolderLevel(dir: home, home: home, path: $path, onOpen: onOpen, onCancel: { dismiss() })
                .navigationDestination(for: String.self) { dir in
                    FolderLevel(dir: dir, home: home, path: $path, onOpen: onOpen, onCancel: { dismiss() })
                }
        }
    }
}

/// One folder: its folders (a tap goes in), its files greyed, and the bar with New Folder and Open.
private struct FolderLevel: View {
    let dir: String
    let home: String
    @Binding var path: [String]
    let onOpen: @MainActor (String) async throws -> Void
    let onCancel: () -> Void
    @Environment(Store.self) private var store
    @State private var listing: DirListing?
    @State private var failure: String?
    @State private var naming = false
    @State private var newName = ""
    @State private var opening = false
    /// Why New Folder or Open didn't work, in an alert.
    @State private var problem: String?

    private var name: String { dir == "/" ? "/" : (dir as NSString).lastPathComponent }

    var body: some View {
        List {
            if let listing {
                let shown = Folders.shown(listing.entries)
                if shown.folders.isEmpty {
                    Text("No folders here.").foregroundStyle(.secondary).accessibilityIdentifier("folderBrowserEmpty")
                }
                ForEach(shown.folders) { f in
                    NavigationLink(value: (dir as NSString).appendingPathComponent(f.name)) {
                        Label(f.name, systemImage: "folder")
                    }
                    .accessibilityIdentifier("folder-" + f.name)
                }
                ForEach(shown.files) { f in
                    Label(f.name, systemImage: "doc").foregroundStyle(.tertiary)
                }
            } else if let failure {
                Text(failure).foregroundStyle(.red)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(name).font(.headline).lineLimit(1)
                    Text(Folders.label(path: dir, home: home)).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.head)
                }
            }
            // At the right on every level: the back button takes the left.
            ToolbarItem(placement: .topBarTrailing) { Button("Cancel", action: onCancel) }
            ToolbarItemGroup(placement: .bottomBar) {
                Button("New Folder", systemImage: "folder.badge.plus") {
                    newName = ""
                    naming = true
                }
                .labelStyle(.titleAndIcon)
                .accessibilityIdentifier("folderBrowserNewFolder")
                Spacer()
                Button { open() } label: { Text("Open \(name)").lineLimit(1) }
                    .buttonStyle(.borderedProminent)
                    .foregroundStyle(Color(.systemBackground))
                    .disabled(opening)
                    .accessibilityIdentifier("folderBrowserOpen")
            }
        }
        .alert("New Folder", isPresented: $naming) {
            TextField("Name", text: $newName)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("folderBrowserName")
            Button("Cancel", role: .cancel) {}
            Button("Make") { make() }
        } message: {
            Text("In \(Folders.label(path: dir, home: home))")
        }
        .plainAlert("Couldn't do that", message: $problem)
        // Again each time it shows, as a folder made in it while deeper changes it.
        .task(id: dir) { await load() }
    }

    private func load() async {
        guard let api = store.api else { return }
        do {
            listing = try await api.list(path: dir)
            failure = nil
        } catch {
            failure = Store.words(for: error)
        }
    }

    /// New Folder's Make: the folder is made here and the browser goes into it.
    private func make() {
        let n = newName.trimmingCharacters(in: .whitespaces)
        if n.isEmpty { return }
        if let p = Folders.nameProblem(n) {
            problem = p
            return
        }
        let target = (dir as NSString).appendingPathComponent(n)
        Task {
            guard let api = store.api else { return }
            do {
                try await api.makeFolder(path: target)
                path.append(target)
            } catch APIError.server(let message) where message == "that name is taken" {
                // blimpd's makeDir answers 409 with these words
                problem = "\(n) already exists."
            } catch {
                problem = Store.words(for: error)
            }
        }
    }

    private func open() {
        opening = true
        Task {
            defer { opening = false }
            do { try await onOpen(dir) } catch { problem = Store.words(for: error) }
        }
    }
}
