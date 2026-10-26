// A page Claude showed (blimp's show tool), full screen over everything (HomeView), from its card in the chat
// (VisualCard). The top bar has × (back to the chat) and the title; below it, blimpd's copy of the page in a web view
// (the app's only one). blimpd sends the page with a policy that lets it run its own scripts and load blimp's kit and
// nothing else: no requests, an origin of its own, no windows. The web view adds what that policy can't: it loads
// the page's own address and cancels every other navigation, so a link or a script can't take it anywhere. Every
// visual shares one data store that lives only while the app runs, so the kit downloads once per run and nothing is
// kept on disk.
import BlimpKit
import SwiftUI
import WebKit

/// The visual open over everything, if any. HomeView puts one in the environment; a card sets it.
@Observable @MainActor
final class OpenVisual {
    var message: ChatMessage?
}

struct VisualView: View {
    let message: ChatMessage
    let onClose: () -> Void
    @Environment(Store.self) private var store
    @State private var page: URL?
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.title3).frame(width: 44, height: 44)
                }
                .accessibilityLabel("Close")
                .accessibilityIdentifier("visualClose")
                Spacer()
                Text(message.title ?? "Visual").font(.headline).lineLimit(1)
                Spacer()
                // Balances × so the title sits in the middle.
                Color.clear.frame(width: 44, height: 44)
            }
            .padding(.horizontal, 8)
            Divider()
            if let page {
                VisualPage(url: page)
            } else if let failure {
                ContentUnavailableView("Can't open this", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(.systemBackground))
        .task {
            guard let api = store.api, let id = message.visual else { return failure = Store.words(for: APIError.offline) }
            do {
                let key = try await api.visualKey()
                guard let url = VisualLink.page(server: api.server.url, key: key, id: id) else { return failure = "blimpd sent something this app can't read" }
                page = url
            } catch {
                failure = Store.words(for: error)
            }
        }
    }
}

/// blimpd's copy of a visual in a web view that goes nowhere else.
struct VisualPage: UIViewRepresentable {
    let url: URL

    @MainActor private static let data = WKWebsiteDataStore.nonPersistent()

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = Self.data
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.allowsLinkPreview = false
        view.allowsBackForwardNavigationGestures = false
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        view.accessibilityIdentifier = "visualPage"
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        let url: URL
        init(url: URL) { self.url = url }

        /// The page's own address loads; a link, a script or a redirect sending it anywhere else is cancelled.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            navigationAction.request.url?.absoluteString == url.absoluteString ? .allow : .cancel
        }
    }
}
