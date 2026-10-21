import { useState } from "react";
import type { Conversation, Session } from "../lib/api";
import type { Inbox, InboxLine } from "../lib/inbox";

const OPEN_KEY = "blimp.inboxOpen";
const HEADINGS = [
  ["waiting", "Waiting on you"],
  ["done", "Done"],
] as const;

// The project's summary, at the top of the session list: a line per session that waits, works or has a reply
// you haven't seen, each opening that session. It folds to one line of counts; the choice is kept on this
// computer. Nothing to say: not shown.
export function InboxSummary(props: { inbox: Inbox; disabled: boolean; onSession: (s: Session) => void; onPast: (c: Conversation) => void }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(OPEN_KEY, o ? "closed" : "open");
      } catch {}
      return !o;
    });
  const { waiting, done } = props.inbox;
  if (!waiting.length && !done.length) return null;
  const counts = [
    waiting.length && `${waiting.length} waiting`,
    done.length && `${done.length} done`,
  ].filter(Boolean);
  const pick = (l: InboxLine) => (l.session ? props.onSession(l.session) : l.conversation && props.onPast(l.conversation));
  return (
    <section className="inbox" aria-label="Inbox">
      <button className="slist-label slist-fold" aria-expanded={open} onClick={toggle}>
        <span className={"tree-twisty" + (open ? " open" : "")}>›</span>
        {open ? "Inbox" : counts.join(" · ")}
      </button>
      {open &&
        HEADINGS.map(([key, label]) =>
          props.inbox[key].length ? (
            <div key={key} className={"inbox-group inbox-" + key} role="group" aria-label={label}>
              <div className="inbox-head">{label}</div>
              {props.inbox[key].map((l) => (
                <button key={l.id} className="inbox-line" disabled={!l.session && props.disabled} title={l.words ? `${l.title}\n${l.words}` : l.title} onClick={() => pick(l)}>
                  <span className="inbox-title">{l.title}</span>
                  {l.words && <span className="inbox-words">{l.words}</span>}
                </button>
              ))}
            </div>
          ) : null,
        )}
    </section>
  );
}
