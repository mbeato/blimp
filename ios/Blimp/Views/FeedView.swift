// The feed, full screen over the chat (HomeView), opened from the drawer's Feed button. The top bar has × (back to
// the chat), "Feed" and Saved. Below it, one card fills the screen: a swipe up shows the next, a swipe down the one
// before (FeedCardView). After the last card, the caught-up card: when the next update is, each source whose last run
// failed, and Saved. A card counts as seen once it has been on screen for 1 s and the screen moves on or the feed
// closes (FeedSeen). While the link is down, the cards loaded stay readable and the connecting bar shows.
import BlimpKit
import SwiftUI

struct FeedView: View {
    let onClose: () -> Void
    @Environment(Store.self) private var store
    @State private var model = FeedModel()
    @State private var position: String?
    @State private var showSaved = false

    /// The caught-up card's place in the scroll view.
    private static let end = "feed-end"

    var body: some View {
        VStack(spacing: 0) {
            bar
            Divider()
            content
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBar() }
        .background(Color(.systemBackground))
        .task {
            await model.load(store.api)
            if let feed = model.feed { position = feed.cards.first?.id ?? Self.end }
        }
        .onChange(of: position) { _, id in model.show(id == Self.end ? nil : id, api: store.api) }
        .sheet(isPresented: $showSaved) { SavedView(model: model) }
    }

    private var bar: some View {
        HStack {
            Button {
                model.close(api: store.api)
                onClose()
            } label: {
                Image(systemName: "xmark").font(.title3).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Close")
            .accessibilityIdentifier("feedClose")
            Spacer()
            Text("Feed").font(.headline)
            Spacer()
            Button {
                showSaved = true
            } label: {
                Image(systemName: "bookmark").font(.title3).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Saved")
            .accessibilityIdentifier("feedSavedButton")
        }
        .padding(.horizontal, 8)
    }

    @ViewBuilder private var content: some View {
        if let feed = model.feed {
            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    ForEach(feed.cards) { card in
                        FeedCardView(card: card, saved: model.isSaved(card.id)) {
                            Task { await model.toggleSave(card, api: store.api) }
                        }
                        .containerRelativeFrame(.vertical)
                        .id(card.id)
                    }
                    CaughtUpView(feed: feed, savedCount: model.saved.count) { showSaved = true }
                        .containerRelativeFrame(.vertical)
                        .id(Self.end)
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollPosition(id: $position)
            .scrollIndicators(.hidden)
        } else if let failed = model.failed {
            ContentUnavailableView("Can't load the feed", systemImage: "wifi.slash", description: Text(failed))
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// After the last card: when the next update is, each source whose last run failed, and Saved.
struct CaughtUpView: View {
    let feed: Feed
    let savedCount: Int
    let onSaved: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle").font(.largeTitle).foregroundStyle(.secondary)
            Text("All caught up").font(.title2.weight(.bold))
            Text(FeedText.nextLine(feed.next, time: Self.time)).foregroundStyle(.secondary)
            ForEach(FeedText.failures(feed.runs, time: Self.time), id: \.self) { line in
                Text(line).font(.footnote).foregroundStyle(.secondary)
            }
            Button("Saved (\(savedCount))", action: onSaved)
                .accessibilityIdentifier("feedCaughtUpSaved")
        }
        .multilineTextAlignment(.center)
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("feedCaughtUp")
    }

    private static func time(_ date: Date) -> String { date.formatted(date: .omitted, time: .shortened) }
}

/// The saved cards, newest first: a tap shows the card, a swipe left unsaves it.
struct SavedView: View {
    let model: FeedModel
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var shown: FeedCard?

    var body: some View {
        NavigationStack {
            List(model.saved) { card in
                Button {
                    shown = card
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(card.title).foregroundStyle(.primary)
                        Text(card.sources.map(\.name).joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("saved-" + card.id)
                .swipeActions {
                    Button("Unsave", role: .destructive) { Task { await model.toggleSave(card, api: store.api) } }
                }
            }
            .overlay {
                if model.saved.isEmpty { ContentUnavailableView("Nothing saved", systemImage: "bookmark") }
            }
            .navigationTitle("Saved")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button("Done") { dismiss() }.accessibilityIdentifier("savedDone")
            }
            .sheet(item: $shown) { card in
                FeedCardView(card: card, saved: model.isSaved(card.id)) {
                    Task { await model.toggleSave(card, api: store.api) }
                }
            }
        }
    }
}
