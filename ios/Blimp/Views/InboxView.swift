// A project's inbox, what opening a project shows, above the box that starts a new chat (StartView): Haiku's
// paragraph on where the project's work stands (the sessions it names open), what's waiting on you and what's
// done (each line opens its session), then the project's sessions and past conversations as the drawer lists them.
import BlimpKit
import SwiftUI

struct InboxView: View {
    let dir: String
    let inbox: Inbox
    let digest: Digest?
    /// The running sessions, which the paragraph's links open.
    let sessions: [Session]
    let rows: [DrawerRow]
    let onPick: (DrawerRow.Item) -> Void

    var body: some View {
        List {
            if let digest {
                Section {
                    paragraph(digest)
                        .environment(\.openURL, OpenURLAction { url in
                            guard url.scheme == Self.scheme,
                                  let name = String(url.absoluteString.dropFirst(Self.scheme.count + 1)).removingPercentEncoding,
                                  let s = sessions.first(where: { $0.name == name }) else { return .discarded }
                            onPick(.running(s))
                            return .handled
                        })
                        .accessibilityIdentifier("inbox-digest")
                }
            }
            heading("Waiting on you", inbox.waiting, color: .orange)
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
            if inbox.isEmpty && rows.isEmpty && digest == nil {
                VStack(spacing: 6) {
                    Text(Drawer.name(of: dir)).font(.title2.bold())
                    Text("What should Claude do here?").foregroundStyle(.secondary)
                }
            }
        }
    }

    private static let scheme = "blimp-session"

    /// The paragraph, each link's words a link to its session while that session runs (else plain words).
    private func paragraph(_ d: Digest) -> Text {
        var a = AttributedString()
        for p in d.parts {
            var piece = AttributedString(p.text)
            if let name = p.session, sessions.contains(where: { $0.name == name }),
               let enc = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
               let url = URL(string: "\(Self.scheme):\(enc)") {
                piece.link = url
            }
            a += piece
        }
        return Text(a)
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
        }
    }
}
