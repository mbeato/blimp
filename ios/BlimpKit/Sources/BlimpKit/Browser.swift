// The server browser on the phone (docs/superpowers/specs/2026-10-22-phone-browser-design.md): its tabs, as
// /events lists them, and a tab's live view (GET /browser/tabs/<id>/view): what the phone sends (its size,
// as a phone; fingers; typing; the address; Back, Forward, Reload; frame acks; a dialog's answer) and what
// blimpd sends (the page's size before each frame, the address and title, dialogs, whether a text field
// took a tap). The frames themselves are JPEGs, in binary messages.
import Foundation

public struct BrowserTab: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let folder: String
    public let url: String
    public let title: String
    /// The session that opened it; nil: opened from an app.
    public let openedBy: String?

    public init(id: String, folder: String, url: String, title: String, openedBy: String? = nil) {
        self.id = id
        self.folder = folder
        self.url = url
        self.title = title
        self.openedBy = openedBy
    }

    /// The title, or the address's host while it has none.
    public var label: String { title.isEmpty ? BrowserAddress.host(of: url) : title }

    public static func inFolder(_ tabs: [BrowserTab], _ folder: String) -> [BrowserTab] { tabs.filter { $0.folder == folder } }

    /// What Send to Session puts in the box, as on the Mac. The page sets its title: no control characters.
    public static func mention(title: String, url: String) -> String {
        func plain(_ s: String) -> String { String(s.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7f ? " " : Character($0) }) }
        return "Browser tab \"\(plain(title.isEmpty ? url : title))\" \(plain(url)) "
    }
}

public enum BrowserAddress {
    /// Where a new tab starts.
    public static let home = "https://www.google.com/"

    /// What's typed in the address means, as on the Mac (app/src/lib/browser.ts typedUrl): a full URL as is;
    /// localhost or a bare host:port over http (the server's own); anything else that looks like a host over
    /// https; anything else a Google search. nil: nothing typed.
    public static func typed(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return nil }
        func has(_ pattern: String) -> Bool { t.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
        if has(#"\s"#) { return search(t) }
        if has(#"^https?://"#) { return t }
        if has(#"^[a-z][a-z0-9+.-]*:"#), !has(#"^[^/]+:\d+(/|$)"#) { return search(t) }
        if has(#"^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(/|$)"#) || has(#"^[^/.]+:\d+(/|$)"#) { return "http://" + t }
        if has(#"^[^/]+\.[^/]+"#) { return "https://" + t }
        return search(t)
    }

    /// An address's host (with its port), for a short label; the address itself if it isn't one.
    public static func host(of url: String) -> String {
        guard let c = URLComponents(string: url), let host = c.host, !host.isEmpty else { return url }
        return c.port.map { "\(host):\($0)" } ?? host
    }

    private static func search(_ q: String) -> String {
        // As JavaScript's encodeURIComponent.
        var allowed = CharacterSet.alphanumerics.intersection(CharacterSet(charactersIn: Unicode.Scalar(0)...Unicode.Scalar(127)))
        allowed.insert(charactersIn: "-_.!~*'()")
        return "https://www.google.com/search?q=" + (q.addingPercentEncoding(withAllowedCharacters: allowed) ?? q)
    }
}

/// A finger on the page, in the page's CSS pixels. `id` stays the same while that finger is down.
public struct TouchPoint: Codable, Sendable, Equatable {
    public let x: Double
    public let y: Double
    public let id: Int

    public init(x: Double, y: Double, id: Int) {
        self.x = x
        self.y = y
        self.id = id
    }
}

public enum TouchPhase: String, Sendable {
    case start = "touchStart", move = "touchMove", end = "touchEnd", cancel = "touchCancel"
}

public enum BrowserKey: Sendable {
    case enter, backspace
}

public enum BrowserNav: String, Sendable {
    case back, forward, reload
}

public enum BrowserCommand: Encodable, Sendable, Equatable {
    /// The page's area in points. Always as a phone: Chrome lays the page out as a phone's while this view
    /// was used last, at 2x (sharp enough, and lighter than 3x on cellular).
    case size(width: Int, height: Int)
    /// The fingers down after the change (none once the last lifts).
    case touch(TouchPhase, [TouchPoint])
    case text(String)
    case key(event: String, key: String, code: String, keyCode: Int, text: String?)
    case go(String)
    case nav(BrowserNav)
    /// A frame was drawn: blimpd lets the next one out.
    case ack
    case dialog(accept: Bool, text: String?)

    /// A key pressed and let go.
    public static func press(_ key: BrowserKey) -> [BrowserCommand] {
        switch key {
        case .enter: [.key(event: "keyDown", key: "Enter", code: "Enter", keyCode: 13, text: "\r"), .key(event: "keyUp", key: "Enter", code: "Enter", keyCode: 13, text: nil)]
        case .backspace: [.key(event: "keyDown", key: "Backspace", code: "Backspace", keyCode: 8, text: nil), .key(event: "keyUp", key: "Backspace", code: "Backspace", keyCode: 8, text: nil)]
        }
    }

    private enum Key: String, CodingKey { case type, width, height, scale, mobile, event, points, text, key, code, keyCode, url, action, accept, modifiers }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        switch self {
        case let .size(width, height):
            try c.encode("size", forKey: .type); try c.encode(width, forKey: .width); try c.encode(height, forKey: .height)
            try c.encode(2.0, forKey: .scale); try c.encode(true, forKey: .mobile)
        case let .touch(phase, points):
            try c.encode("touch", forKey: .type); try c.encode(phase.rawValue, forKey: .event); try c.encode(points, forKey: .points)
        case let .text(text):
            try c.encode("text", forKey: .type); try c.encode(text, forKey: .text)
        case let .key(event, key, code, keyCode, text):
            try c.encode("key", forKey: .type); try c.encode(event, forKey: .event); try c.encode(key, forKey: .key)
            try c.encode(code, forKey: .code); try c.encode(keyCode, forKey: .keyCode); try c.encodeIfPresent(text, forKey: .text)
            try c.encode(0, forKey: .modifiers)
        case let .go(url):
            try c.encode("go", forKey: .type); try c.encode(url, forKey: .url)
        case let .nav(action):
            try c.encode("nav", forKey: .type); try c.encode(action.rawValue, forKey: .action)
        case .ack:
            try c.encode("ack", forKey: .type)
        case let .dialog(accept, text):
            try c.encode("dialog", forKey: .type); try c.encode(accept, forKey: .accept); try c.encodeIfPresent(text, forKey: .text)
        }
    }
}

public struct BrowserInfo: Codable, Sendable, Equatable {
    public let url: String
    public let title: String
    public let loading: Bool
    public let canGoBack: Bool
    public let canGoForward: Bool

    public init(url: String, title: String, loading: Bool, canGoBack: Bool, canGoForward: Bool) {
        self.url = url
        self.title = title
        self.loading = loading
        self.canGoBack = canGoBack
        self.canGoForward = canGoForward
    }
}

/// An alert, confirm or prompt the page opened: it waits for the answer.
public struct BrowserDialog: Codable, Sendable, Equatable {
    public let kind: String
    public let message: String
    public let defaultPrompt: String

    public init(kind: String, message: String, defaultPrompt: String) {
        self.kind = kind
        self.message = message
        self.defaultPrompt = defaultPrompt
    }
}

public enum BrowserEvent: Sendable, Equatable {
    /// The next binary message is a frame of the page at this size (CSS pixels).
    case frame(width: Double, height: Double)
    case info(BrowserInfo)
    case dialog(BrowserDialog)
    case dialogClosed
    /// After a lift: whether a text field has focus, so the keyboard comes up or goes away.
    case focus(editable: Bool)
    case other

    private struct Wire: Decodable {
        let type: String
        let width: Double?
        let height: Double?
        let editable: Bool?
    }

    public static func decode(_ data: Data) -> BrowserEvent {
        guard let w = try? JSONDecoder().decode(Wire.self, from: data) else { return .other }
        switch w.type {
        case "frame":
            guard let width = w.width, let height = w.height else { return .other }
            return .frame(width: width, height: height)
        case "info": return (try? JSONDecoder().decode(BrowserInfo.self, from: data)).map { .info($0) } ?? .other
        case "dialog": return (try? JSONDecoder().decode(BrowserDialog.self, from: data)).map { .dialog($0) } ?? .other
        case "dialog-closed": return .dialogClosed
        case "focus": return .focus(editable: w.editable == true)
        default: return .other
        }
    }
}

/// The page is drawn the width of the phone's view: at its own size while the phone set it, scaled to fit
/// while another screen (the Mac) did. A finger maps back to the page through the same scale.
public enum PageFit {
    public static func scale(pageWidth: Double?, viewWidth: Double) -> Double {
        guard let pageWidth, pageWidth > 0, viewWidth > 0 else { return 1 }
        return viewWidth / pageWidth
    }

    public static func toPage(x: Double, y: Double, scale: Double, id: Int = 0) -> TouchPoint {
        TouchPoint(x: x / scale, y: y / scale, id: id)
    }
}
