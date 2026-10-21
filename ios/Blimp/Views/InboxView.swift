// A project's inbox, what opening a project shows: New chat, then what's waiting on you, in progress and done
// (each line opens its session), then the project's sessions and past conversations as the drawer lists them.
import BlimpKit
import SwiftUI

struct InboxView: View {
    let dir: String
    let inbox: Inbox
    let rows: [DrawerRow]
    let onPick: (DrawerRow.Item) -> Void
    let onNew: () -> Void

    var body: some View {
        List {
            Section {
                Button(action: onNew) {
                    Label("New chat", systemImage: "square.and.pencil").frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityIdentifier("inboxNewChat")
            }
            heading("Waiting on you", inbox.waiting, color: .orange)
            heading("In progress", inbox.progress, color: .secondary)
            heading("Done", inbox.done, color: .secondary)
            if !rows.isEmpty {
                Section("Sessions") {
                    ForEach(rows) { row in
                        Button { onPick(row.item) } label: { RowLabel(row: row) }
                            .foregroundStyle(.primary)
                            .accessibilityIdentifier("inbox-row-" + row.id)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if inbox.isEmpty && rows.isEmpty {
                Text("Nothing here yet. New chat starts Claude in \(Drawer.name(of: dir)).")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center).padding()
            }
        }
    }

    @ViewBuilder private func heading(_ title: String, _ lines: [InboxLine], color: Color) -> some View {
        if !lines.isEmpty {
            Section {
                ForEach(lines) { line in
                    Button { onPick(line.item) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(line.title).lineLimit(2)
                            if let words = line.words {
                                Text(words).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .foregroundStyle(.primary)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("inbox-" + line.id)
                }
            } header: {
                Text(title).foregroundStyle(color)
            }
            .accessibilityIdentifier("inbox-heading-" + title)
        }
    }
}
