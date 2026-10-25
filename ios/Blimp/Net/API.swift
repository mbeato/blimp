// blimpd's HTTP API (docs/DESIGN.md "blimpd API"). Every request carries the token and gives up after 10 s.
import BlimpKit
import Foundation

enum APIError: Error, Equatable {
    case unauthorized
    case server(String)
    case offline
    case other(String)
}

struct API {
    let server: ServerLink

    init(server: ServerLink) { self.server = server }

    func health() async throws -> Health {
        try await decode(call("GET", "/health"))
    }

    func folders() async throws -> [RecentFolder] {
        try await decode(call("GET", "/folders/recent"))
    }

    /// The projects hidden from the strip, by folder.
    func hiddenFolders() async throws -> [String] {
        try await decode(call("GET", "/folders/hidden"))
    }

    /// Hides a project from the strip, or shows it again; the folders hidden now.
    func setHidden(dir: String, hidden: Bool) async throws -> [String] {
        struct Body: Encodable { let dir: String; let hidden: Bool }
        return try await decode(call("POST", "/folders/hidden", body: JSONEncoder().encode(Body(dir: dir, hidden: hidden))))
    }

    /// A folder on the computer, inside home: its folders and files.
    func list(path: String) async throws -> DirListing {
        try await decode(call("GET", "/fs/list", query: [URLQueryItem(name: "path", value: path)]))
    }

    /// Makes a folder. One there already: blimpd's "that name is taken".
    func makeFolder(path: String) async throws {
        struct Body: Encodable { let path: String }
        _ = try await call("POST", "/fs/mkdir", body: JSONEncoder().encode(Body(path: path)))
    }

    /// Opens a folder as a project: blimpd shows it again if it was hidden and keeps it in the recent folders, which
    /// it answers with.
    func openFolder(dir: String) async throws -> [RecentFolder] {
        struct Body: Encodable { let dir: String }
        return try await decode(call("POST", "/folders/opened", body: JSONEncoder().encode(Body(dir: dir))))
    }

    /// Notifications to this phone: its device token, and which of Apple's services it's on (development for a build
    /// from Xcode, production for TestFlight). Sending it again is harmless. An older blimpd answers 404.
    func registerDevice(token: String, env: String) async throws {
        struct Body: Encodable { let token: String; let env: String }
        _ = try await call("POST", "/push/device", body: JSONEncoder().encode(Body(token: token, env: env)))
    }

    /// No more notifications to this phone from this server.
    func unregisterDevice(token: String) async throws {
        struct Body: Encodable { let token: String }
        _ = try await call("DELETE", "/push/device", body: JSONEncoder().encode(Body(token: token)))
    }

    func conversations(dir: String) async throws -> [Conversation] {
        try await decode(call("GET", "/conversations", query: [URLQueryItem(name: "dir", value: dir)]))
    }

    /// Starts Claude Code in `dir` (resuming a conversation if given, with `prompt` as Claude's first
    /// message if given); returns the new session's name.
    func start(dir: String, resume: String?, prompt: String? = nil) async throws -> String {
        struct Body: Encodable { let dir: String; let resume: String?; let prompt: String? }
        let body = try JSONEncoder().encode(Body(dir: dir, resume: resume, prompt: prompt))
        let started: Started = try await decode(call("POST", "/sessions", body: body))
        return started.name
    }

    /// A past conversation's last messages, read without starting Claude.
    func messages(dir: String, conversation: String) async throws -> [ChatMessage] {
        try await decode(call("GET", "/conversations/\(conversation)/messages", query: [URLQueryItem(name: "dir", value: dir)]))
    }

    /// The conversation is on screen: its replies so far are read, here and on the Mac.
    func seen(_ conversation: String) async throws {
        struct Body: Encodable { let sessionId: String }
        _ = try await call("POST", "/seen", body: JSONEncoder().encode(Body(sessionId: conversation)))
    }

    func end(name: String) async throws {
        _ = try await call("DELETE", "/sessions/" + name)
    }

    /// Answers what the session asks without a chat open: a pick, every question, Esc, or no and why. blimpd
    /// types it only while that prompt is still up; otherwise APIError.server says why ("the question changed").
    func answer(name: String, _ request: AnswerRequest) async throws {
        _ = try await call("POST", "/sessions/" + name + "/answer", body: JSONEncoder().encode(request))
    }

    /// Continue in new session: Claude writes a handoff, then a new session reads it. Returns the handoff as
    /// it starts (writing); the session list follows it to started (with the new session) or failed.
    /// An older blimpd: APIError.server("not found"), which HandoffText.failure turns into "update it".
    func handoff(name: String) async throws -> Handoff {
        try await decode(call("POST", "/sessions/" + name + "/handoff"))
    }

    /// Runs a command Claude handed over (one of Session.runnable) for that Claude session, in a run session
    /// of its own; returns the run session's name.
    func run(session: String, command: String) async throws -> String {
        struct Body: Encodable { let session: String; let command: String }
        let started: Started = try await decode(call("POST", "/runs", body: JSONEncoder().encode(Body(session: session, command: command))))
        return started.name
    }

    /// Types an ended run's exit code and last output lines into its Claude session.
    func sendRunResult(name: String) async throws {
        _ = try await call("POST", "/runs/" + name + "/send")
    }

    /// Opens a server browser tab at `url` in `dir`; returns its id.
    func openTab(dir: String, url: String) async throws -> String {
        struct Body: Encodable { let dir: String; let url: String }
        struct Opened: Decodable { let id: String }
        let opened: Opened = try await decode(call("POST", "/browser/tabs", body: JSONEncoder().encode(Body(dir: dir, url: url))))
        return opened.id
    }

    func closeTab(_ id: String) async throws {
        _ = try await call("DELETE", "/browser/tabs/" + id)
    }

    /// A WebSocket address on this server: ws for http, wss for https, the token in the query
    /// (a WebSocket handshake can't carry the Authorization header here).
    func socketURL(_ path: String) -> URL {
        var c = components(path)
        c.scheme = c.scheme?.lowercased() == "https" ? "wss" : "ws"
        c.queryItems = [URLQueryItem(name: "token", value: server.token)]
        return c.url!
    }

    private func components(_ path: String) -> URLComponents {
        var c = URLComponents(url: server.url, resolvingAgainstBaseURL: false)!
        c.path += path
        return c
    }

    private func call(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil) async throws -> Data {
        var c = components(path)
        if !query.isEmpty {
            c.queryItems = query
            // URLComponents leaves "+" as is, and blimpd reads it as a space
            c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = c.url else { throw APIError.other("bad address") }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.httpMethod = method
        req.setValue("Bearer \(server.token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data, response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch let e as URLError where API.offlineCodes.contains(e.code) {
            throw APIError.offline
        } catch {
            throw APIError.other(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.other("not an HTTP reply") }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            struct Failure: Decodable { let error: String }
            if let f = try? JSONDecoder().decode(Failure.self, from: data) { throw APIError.server(f.error) }
            throw APIError.other("blimpd answered \(http.statusCode)")
        }
        return data
    }

    private static let offlineCodes: Set<URLError.Code> = [
        .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
        .timedOut, .networkConnectionLost,
    ]

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw APIError.other("blimpd sent something this app can't read") }
    }
}
