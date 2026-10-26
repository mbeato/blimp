// One card of the feed (FeedView), and a saved one (SavedView): where it's from with its score and age, the title,
// the summary (plain text, never Markdown) and the link's picture, then Open, Comments and Save. Open and Comments
// show the page in Safari inside the app; Comments asks which thread when there are two. Only http and https open.
import BlimpKit
import SafariServices
import SwiftUI

struct FeedCardView: View {
    let card: FeedCard
    let saved: Bool
    let onSave: () -> Void
    @State private var web: WebPage?
    @State private var choosing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                Text(FeedText.sourceLine(card, now: context.date))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text(card.title)
                .font(.title2.weight(.bold))
                .accessibilityIdentifier("feedTitle")
            if let summary = card.summary {
                Text(summary).font(.body)
            }
            if let image = card.image.flatMap({ FeedText.link($0) }) {
                AsyncImage(url: image) { picture in
                    picture.resizable().scaledToFit()
                } placeholder: {
                    Color.clear
                }
                .frame(maxWidth: .infinity, maxHeight: 220)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            Spacer(minLength: 0)
            actions
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("feedCard-" + card.id)
        .sheet(item: $web) { page in
            SafariView(url: page.url).ignoresSafeArea()
        }
        .confirmationDialog("Comments", isPresented: $choosing) {
            ForEach(FeedText.threads(card), id: \.url) { thread in
                Button(thread.name) { web = WebPage(url: thread.url) }
            }
        }
    }

    private var actions: some View {
        HStack {
            Button("Open", systemImage: "safari") {
                if let url = FeedText.link(card.url) { web = WebPage(url: url) }
            }
            .accessibilityIdentifier("feedOpen")
            Spacer()
            let threads = FeedText.threads(card)
            if !threads.isEmpty {
                Button(FeedText.commentsLabel(card), systemImage: "bubble.left.and.bubble.right") {
                    if threads.count == 1 { web = WebPage(url: threads[0].url) } else { choosing = true }
                }
                .accessibilityIdentifier("feedComments")
                Spacer()
            }
            Button(saved ? "Saved" : "Save", systemImage: saved ? "bookmark.fill" : "bookmark", action: onSave)
                .accessibilityIdentifier("feedSave")
        }
        .font(.body.weight(.semibold))
    }
}

/// A page Open or Comments shows.
struct WebPage: Identifiable {
    let url: URL
    var id: URL { url }
}

/// Safari inside the app, for a card's page.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
