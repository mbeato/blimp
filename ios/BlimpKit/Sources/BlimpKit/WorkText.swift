// Which session is on what (Session.work): the words a row shows for its branch and for the other sessions
// it may get in the way of, the same as the Mac's (app/src/lib/work.ts). A clash is drawn in red, never
// amber: amber means "waiting for you".
import Foundation

public enum WorkText {
    /// The row's caption: the branch, as blimpd found it.
    public static func branch(_ s: Session) -> String? {
        guard let b = s.work?.branch, !b.isEmpty else { return nil }
        return b
    }

    /// "On branch feat-x (worktree)"
    public static func branchLine(_ s: Session) -> String? {
        branch(s).map { "On branch \($0)" + (s.work?.worktree == true ? " (worktree)" : "") }
    }

    /// One line per clash: "Also on branch feat-x: <title>", "Both edited a.ts, b.ts with <title>". all: the
    /// server's sessions, for the other one's title (its zmx name when it's gone, or isn't Claude or a run).
    public static func clashLines(_ s: Session, all: [Session]) -> [String] {
        (s.work?.clash ?? []).map { c in
            let other = all.first { $0.name == c.session }
            let who = other.map { $0.isClaude || $0.run != nil ? $0.title : $0.name } ?? c.session
            switch c.reason {
            case .branch: return "Also on branch \(s.work?.branch ?? ""): \(who)"
            case .files: return "Both edited \((c.files ?? []).joined(separator: ", ")) with \(who)"
            case .other: return "May get in the way of \(who)"
            }
        }
    }
}
