// Which session is on what (blimpd's work.ts): the words a row shows for its branch and for the
// other sessions it may get in the way of.

import type { Session } from "./api";
import { sessionTitle } from "./sessions";

// The row tooltip's line about the branch.
export const branchLine = (s: Session) => (s.work?.branch ? `On branch ${s.work.branch}${s.work.worktree ? " (worktree)" : ""}` : undefined);

// The warning's tooltip, one line per clash. all: the server's sessions, for the other one's title.
export function clashLines(s: Session, all: Session[]): string[] {
  return (s.work?.clash ?? []).map((c) => {
    const other = all.find((x) => x.name === c.session);
    const who = other ? sessionTitle(other) : c.session;
    return c.reason === "branch" ? `Also on branch ${s.work?.branch}: ${who}` : `Both edited ${(c.files ?? []).join(", ")} with ${who}`;
  });
}
