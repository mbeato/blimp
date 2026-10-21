// A session's mark: Claude asks you something (an amber question mark), beats a reply you haven't seen
// (a blue dot), beats working or idle (a ring; spinning while it works).
import type { Session } from "../lib/api";

export function StateMark(props: { s: Session }) {
  const { s } = props;
  if (s.state === "waiting") return <span className="ask" aria-hidden>?</span>;
  if (s.unread) return <span className="unread-dot" />;
  return <span className="state-dot" />;
}
