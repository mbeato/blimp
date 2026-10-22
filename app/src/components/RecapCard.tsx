// The return card ("where was I?") for a Claude session: what it is for, then what's stuck, in progress,
// next and done (lib/recap.ts recapSections), from blimpd (GET /sessions/<name>/recap). It sits at the bottom of the session list, out of the
// terminal's way, or over the top of the session's terminal while the list is hidden. It shows by itself
// when the session comes on screen in a focused window after an hour or more away (lib/recap.ts), and from
// the right-click menu's Recap. One card at a time: the newest ask wins. If blimpd can't give one,
// nothing shows (from the menu, a blimpd too old for recaps says so).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Api, Recap } from "../lib/api";
import { AWAY, cameBack, markShown, pickBack, readLastShown, recapError, recapSections, type RecapKind, type RecapSection, writeLastShown } from "../lib/recap";

export type Card = Recap | "loading";

// The card of a pane's sessions: which session it's for, and the card. onScreen: the Claude sessions the
// pane shows while its tab is in front; focus: the one in the focused split. server: the link's key, so
// the same name on two servers is two sessions. onNotice: for a Recap from the menu that a too-old blimpd
// can't give.
export function useRecaps(api: Api | null, server: string, onScreen: string[], focus: string | undefined, onNotice: (msg: string) => void) {
  const [card, setCard] = useState<{ name: string; card: Card } | null>(null);
  // The ask still out (only the newest counts), so an older answer, or one dismissed, is dropped.
  const asking = useRef<{ name: string; id: number } | null>(null);
  const ids = useRef(0);
  // The card the newest "…" took the place of, put back if that ask fails.
  const prev = useRef<{ name: string; card: Card } | null>(null);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const f = () => setFocused(document.hasFocus());
    window.addEventListener("focus", f);
    window.addEventListener("blur", f);
    // While a session stays on screen, it's still being shown: noted every 30 s.
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => (window.removeEventListener("focus", f), window.removeEventListener("blur", f), clearInterval(t));
  }, []);

  const dismiss = (name: string) => {
    if (asking.current?.name === name) asking.current = null;
    setCard((c) => (c?.name === name ? null : c));
  };

  // auto: on its own, so only for a session with 3 prompts or more, never over an ask already out, and
  // "…" only once it takes a moment (a session too new for a card says so at once).
  const show = (name: string, auto = false) => {
    if (!api || (auto && asking.current?.name === name)) return;
    const id = ++ids.current;
    asking.current = { name, id };
    const mine = () => asking.current?.id === id;
    const t = setTimeout(
      () =>
        mine() &&
        setCard((c) => {
          if (c?.name === name) return c;
          // Over a "…" of an ask since dropped, the card before that one stays the one to put back.
          if (c?.card !== "loading") prev.current = c;
          return { name, card: "loading" };
        }),
      auto ? 300 : 0,
    );
    api.recap(name, auto ? 3 : undefined).then(
      (r) => {
        clearTimeout(t);
        if (mine()) (asking.current = null), setCard({ name, card: r });
      },
      (e) => {
        clearTimeout(t);
        if (!mine()) return;
        // Only the "…" goes: a card already showing stays (one asked for again), or comes back (another
        // session's, that the "…" took the place of).
        asking.current = null;
        setCard((c) => (c?.name === name && c.card === "loading" ? prev.current : c));
        const notice = auto ? undefined : recapError(e);
        if (notice) onNotice(notice);
      },
    );
  };

  const viewing = focused && api ? onScreen.map((n) => `${server}/${n}`) : [];
  const before = useRef<string[]>([]);
  const looked = useRef(Date.now());
  useEffect(() => {
    if (!viewing.length && !before.current.length) return;
    const now = Date.now();
    const last = readLastShown();
    const back = cameBack(viewing, before.current, last, now, looked.current);
    // The ones just gone off screen were on it until now, or, after the Mac was asleep, until it slept.
    const until = now - looked.current >= AWAY ? looked.current : now;
    writeLastShown(markShown(markShown(last, before.current, until), viewing, now));
    before.current = viewing;
    looked.current = now;
    const k = pickBack(back, focus && `${server}/${focus}`);
    if (k) show(k.slice(server.length + 1), true);
  }, [viewing.join("\n"), tick]);

  return { card, show, dismiss };
}

// title and onSession: in the session list, away from its terminal, the card says whose it is, and a
// click on that shows the session.
export function RecapCard(props: { card: Card; title?: string; onSession?: () => void; onClose: () => void }) {
  const { card } = props;
  // In the list, a body cut short fades out at the bottom, so it says there's more (macOS hides the
  // scroll bar). Gone once scrolled to the end.
  const body = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const check = () => {
    const b = body.current;
    setMore(!!b && !!props.title && b.scrollTop + b.clientHeight < b.scrollHeight - 1);
  };
  useLayoutEffect(() => {
    check();
    const o = new ResizeObserver(check);
    if (body.current) o.observe(body.current);
    return () => o.disconnect();
  }, [card, props.title]);
  return (
    <div className={"recap-card" + (props.title ? " in-list" : " over")} role="status" aria-label="Where this session is">
      {/* No focus on mouse down, so the keyboard stays in the terminal once the card is gone. */}
      <button className="tab-close" title="Dismiss" aria-label="Dismiss recap" onMouseDown={(e) => e.preventDefault()} onClick={props.onClose}>
        ×
      </button>
      {props.title && (
        <button className="recap-session" title={`Show ${props.title}`} onMouseDown={(e) => e.preventDefault()} onClick={props.onSession}>
          Recap · {props.title}
        </button>
      )}
      <div ref={body} className={"recap-body" + (more ? " more" : "")} onScroll={check}>
        {card === "loading" ? (
          <p className="recap-loading">…</p>
        ) : (
          <>
            <p className="recap-goal">{card.goal}</p>
            {recapSections(card).map((s) => (
              <Part key={s.kind} section={s} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// Each part's mark, beside its heading: Stuck a stop, In progress a half-filled circle, Next and Open an
// empty one, Done a tick.
const MARKS: Record<RecapKind, ReactNode> = {
  stuck: <path d="M5 1.5h6L14.5 5v6L11 14.5H5L1.5 11V5zM8 4.5v4.5M8 11v.5" />,
  doing: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
    </>
  ),
  next: <circle cx="8" cy="8" r="6" />,
  open: <circle cx="8" cy="8" r="6" />,
  done: <path d="M2.5 8.5l3.5 3.5 7.5-8" />,
};

function Part(props: { section: RecapSection }) {
  const { kind, label, items } = props.section;
  return (
    <div className={`recap-part ${kind}`}>
      <span className="recap-label">
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {MARKS[kind]}
        </svg>
        {label}
      </span>
      <ul aria-label={label}>
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
