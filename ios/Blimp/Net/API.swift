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

    func conversations(dir: String) async throws -> [Conversation] {
        try await decode(call("GET", "/conversations", query: [URLQueryItem(name: "dir", value: dir)]))
    }

    /// Starts Claude Code in `dir` (resuming a conversation if given); returns the new session's name.
    func start(dir: String, resume: String?) async throws -> String {
        struct Body: Encodable { let dir: String; let resume: String? }
        let started: Started = try await decode(call("POST", "/sessions", body: JSONEncoder().encode(Body(dir: dir, resume: resume))))
        return started.name
    }

    func end(name: String) async throws {
        _ = try await call("DELETE", "/sessions/" + name)
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
        if !query.isEmpty { c.queryItems = query }
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
