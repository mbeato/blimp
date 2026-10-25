// The phone's folder browser (FolderBrowserView): what a folder shows, the name a new folder may have, and a path
// as the browser shows it under its title.
import Foundation

public enum Folders {
    /// A folder's folders, then its files (greyed in the browser), in blimpd's order (A to Z). None whose name starts
    /// with ".": on a phone they would fill the first screen of home.
    public static func shown(_ entries: [DirEntry]) -> (folders: [DirEntry], files: [DirEntry]) {
        let seen = entries.filter { !$0.name.hasPrefix(".") }
        return (seen.filter(\.isFolder), seen.filter { !$0.isFolder })
    }

    /// Why New Folder can't make `name` (the Mac's words), or nil when it can. Empty is nil too: there's nothing to make.
    public static func nameProblem(_ name: String) -> String? {
        let n = name.trimmingCharacters(in: .whitespaces)
        if n.contains("/") || n == "." || n == ".." { return "A name can't contain / or be . or .." }
        return nil
    }

    /// "~" for home, "~/code" inside it, else the path as it is.
    public static func label(path: String, home: String) -> String {
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + String(path.dropFirst(home.count)) }
        return path
    }
}
