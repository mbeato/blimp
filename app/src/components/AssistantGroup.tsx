import { useState } from "react";
import type { Session } from "../lib/api";
import { jobCounts, jobRows } from "../lib/assistant";
import { sessionTitle } from "../lib/sessions";
import { StateMark } from "./StateMark";

const OPEN_KEY = "blimp.assistantOpen";

// The assistant, pinned at the top of every tab's session list while its session runs: its row with its mark, then its
// jobs indented under it, each "project · reason" with its mark and what it asks or its note. A click opens that
// session where it lives (onOpen: App's ⌘K path, which never keeps the assistant's folder as a recent project). It
// folds to one line ("Assistant · 1 needs you · 2 working"); the choice is kept on this computer.
export function AssistantGroup(props: { sessions: Session[]; onOpen: (name: string) => void }) {
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
  const assistant = props.sessions.find((s) => s.assistant === true);
  if (!assistant) return null;
  const rows = jobRows(props.sessions);
  const counts = jobCounts(rows);
  return (
    <section className="assistant" aria-label="Assistant">
      <button className="slist-label slist-fold" aria-expanded={open} onClick={toggle}>
        <span className={"tree-twisty" + (open ? " open" : "")}>›</span>
        {open || !counts ? "Assistant" : `Assistant · ${counts}`}
      </button>
      {open && (
        <>
          <button className="assistant-line" data-session={assistant.name} title={`${sessionTitle(assistant)}\n${assistant.name}`} onClick={() => props.onOpen(assistant.name)}>
            <span className={"srow-mark state-" + assistant.state}>
              <StateMark s={assistant} />
            </span>
            <span className="assistant-title">{sessionTitle(assistant)}</span>
          </button>
          {rows.map((r) => (
            <button
              key={r.session.name}
              className="assistant-line assistant-job"
              data-session={r.session.name}
              title={`${r.project} · ${r.reason}${r.words ? `\n${r.words}` : ""}\n${r.session.name}`}
              onClick={() => props.onOpen(r.session.name)}
            >
              <span className={"srow-mark state-" + r.session.state}>
                <StateMark s={r.session} />
              </span>
              <span className="assistant-text">
                <span className="assistant-title">
                  {r.project} · {r.reason}
                </span>
                {r.words && <span className="assistant-words">{r.words}</span>}
              </span>
            </button>
          ))}
        </>
      )}
    </section>
  );
}
