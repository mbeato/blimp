import { useEffect, useState } from "react";
import type { LinkStatus, ServerLink } from "../lib/connection";

const STATE: Record<LinkStatus, string> = { connected: "connected", connecting: "connecting…", offline: "offline" };

// A link's state as a shape, not a color: connected is a solid dot, connecting a ring, offline a
// red dot. (Amber, blue and the split blue mean other things; there is no green.)
export const ServerDot = (props: { status: LinkStatus }) => <span className={"srv-dot srv-" + props.status} aria-hidden />;

// The server switcher at the left of the top bar, always there: the front tab's server and how
// it's connected. Its menu lists every saved server (a click goes to that server's Home) and
// leads to Add server and Manage servers, so they can't be lost behind an open file.
export function ServerSwitcher(props: {
  links: ServerLink[]; // in saved order
  current: ServerLink;
  onPick: (link: ServerLink) => void;
  onAdd: () => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { current } = props;

  // Esc closes the menu, before a dialog or the terminal sees it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const choose = (f: () => void) => () => {
    setOpen(false);
    f();
  };

  return (
    <div className="menu-anchor srv-anchor">
      <button
        className="srv-switch"
        title={current.key}
        aria-label={`Server: ${current.name}, ${STATE[current.status]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ServerDot status={current.status} />
        <span className="srv-name">{current.name}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" />
        </svg>
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu srv-menu" role="menu" aria-label="Servers">
            {/* Only the servers scroll, so Add and Manage stay in reach with many of them. */}
            <div className="srv-rows">
              {props.links.map((l) => {
                const here = l === current;
                const n = l.sessions?.length ?? 0;
                const waiting = l.sessions?.filter((s) => s.state === "waiting").length ?? 0;
                return (
                  <button
                    key={l.key}
                    role="menuitem"
                    className="srv-row"
                    aria-current={here ? "true" : undefined}
                    title={l.status === "connected" ? l.key : l.error || l.key}
                    onClick={choose(() => props.onPick(l))}
                  >
                    <span className="srv-check" aria-hidden>
                      {here ? "✓" : ""}
                    </span>
                    <ServerDot status={l.status} />
                    <span className="srv-name">{l.name}</span>
                    <span className={"srv-side" + (l.status === "offline" ? " srv-side-offline" : "")}>
                      {l.status !== "connected" ? (
                        STATE[l.status]
                      ) : (
                        <>
                          {waiting > 0 && (
                            // Words for a screen reader, which would read the bare number.
                            <span className="srv-waiting" title={`${waiting} waiting for you`} role="img" aria-label={`${waiting} waiting`}>
                              <span className="dot" aria-hidden />
                              {waiting}
                            </span>
                          )}
                          {n === 1 ? "1 session" : `${n} sessions`}
                        </>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="menu-sep" role="separator" />
            <button role="menuitem" onClick={choose(props.onAdd)}>
              Add server…
            </button>
            <button role="menuitem" onClick={choose(props.onManage)}>
              Manage servers…
            </button>
          </div>
        </>
      )}
    </div>
  );
}
