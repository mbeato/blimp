// Which session is on what (blimpd's work.ts): the words a row shows for its branch.

import type { Session } from "./api";

// The row tooltip's line about the branch.
export const branchLine = (s: Session) => (s.work?.branch ? `On branch ${s.work.branch}${s.work.worktree ? " (worktree)" : ""}` : undefined);
