// Which session is on what (Session.work): the words a row shows for its branch, the same as the Mac's
// (app/src/lib/work.ts).
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
}
