import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LinkStatus, ServerLink } from "../lib/connection";

const STATE: Record<LinkStatus, string> = { connected: "connected", connecting: "connecting…", offline: "offline" };

// A link's state as a shape, not a color: connected is a solid dot, connecting a ring, offline a
// red dot. (Amber, blue and the split blue mean other things; there is no green.)
export const ServerDot = (props: { status: LinkStatus }) => <span className={"srv-dot srv-" + props.status} aria-hidden />;

// The chevron joined to the Home tab, after its server's name: a button beside the tab, not in
// it, so it never selects, drags or closes the tab. Its menu lists every saved server (a click
// shows that server at Home) and leads to Add server and Manage servers, so they can't be lost
// behind an open file.
export function ServerSwitcher(props: {
  links: ServerLink[]; // in saved order
  current: ServerLink; // Home's server
  onPick: (link: ServerLink) => void;
  onAdd: () => void;
  onManage: () => void;
}) {
  // Where the menu opens: under the Home tab. Fixed and outside the strip, which scrolls and so
  // would cut it off.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const { current } = props;

  const close = () => {
    setAt(null);
    button.current?.focus();
  };

  // Esc closes the menu, before a dialog or the terminal sees it.
  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [at]);

  // The menu is at the end of the page, far from the chevron in Tab order: the keyboard goes into
  // it when it opens, on the server Home shows.
  const open = !!at;
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[aria-current="true"], [role="menuitem"]')?.focus();
  }, [open]);

  const toggle = () => {
    if (at) return setAt(null);
    // The Home tab is just before the chevron.
    const r = (anchor.current!.previousElementSibling ?? anchor.current!).getBoundingClientRect();
    // The strip may have scrolled Home partly out of sight; the menu stays in the window.
    setAt({ left: Math.max(4, r.left + 4), top: r.bottom + 2 });
  };

  const choose = (f: () => void) => () => {
    setAt(null);
    f();
  };

  return (
    <span ref={anchor} className="srv-anchor">
      <button ref={button} className="srv-switch" title="Servers" aria-label="Servers" aria-description={`${current.name}, ${STATE[current.status]}`} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" />
        </svg>
      </button>
      {at &&
        // Out of the tab strip, so the menu is not part of the tab list for a screen reader.
        createPortal(
          <>
            <div className="menu-scrim" onClick={close} />
            <div ref={menu} className="menu srv-menu" role="menu" aria-label="Servers" style={at}>
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
          </>,
          document.body,
        )}
    </span>
  );
}
