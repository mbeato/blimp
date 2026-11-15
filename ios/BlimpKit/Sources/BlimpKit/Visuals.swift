// A page Claude showed with blimp's show tool (docs/superpowers/specs/2026-10-26-visuals-design.md,
// 2026-11-15-visuals-3d-design.md): where its copy is read. The visual key (GET /visuals/key) is in the path and the
// address ends with /, so the page's relative paths (blimp's kit/, the files it came with) land in its own folder.
import Foundation

public enum VisualLink {
    /// The page on `server` (the paired address, https://<tailnet name>), or nil for an id or key blimpd wouldn't make.
    public static func page(server: URL, key: String, id: String) -> URL? {
        guard id.range(of: "^[0-9a-f]{12}$", options: .regularExpression) != nil,
              key.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              var c = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        if c.path.hasSuffix("/") { c.path.removeLast() }
        c.path += "/visuals/\(key)/\(id)/"
        c.query = nil
        c.fragment = nil
        return c.url
    }
}
