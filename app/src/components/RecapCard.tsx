// The return card ("where was I?") over the top of a Claude session's terminal: what the session is for,
// what's done and what's still open, from blimpd (GET /sessions/<name>/recap). It shows by itself when
// the session comes on screen in a focused window after an hour or more away (lib/recap.ts), and from
// the right-click menu's Recap. If blimpd can't give one, nothing shows.

import { useEffect, useRef, useState } from "react";
import type { Api, Recap } from "../lib/api";
import { cameBack, markShown, readLastShown, writeLastShown } from "../lib/recap";

export type Card = Recap | "loading";

// The cards of a pane's sessions, by session name. onScreen: the Claude sessions the pane shows while
// its tab is in front. server: the link's key, so the same name on two servers is two sessions.
export function useRecaps(api: Api | null, server: string, onScreen: string[]) {
  const [cards, setCards] = useState<Record<string, Card>>({});
  // Asks still out: session name -> its latest, so an older answer (or one dismissed) is dropped.
  const asking = useRef(new Map<string, number>()).current;
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
    asking.delete(name);
    setCards(({ [name]: _, ...rest }) => rest);
  };

  // auto: on its own, so only for a session with 3 prompts or more, never over an ask already out, and
  // "…" only once it takes a moment (a session too new for a card says so at once).
  const show = (name: string, auto = false) => {
    if (!api || (auto && asking.has(name))) return;
    const id = (asking.get(name) ?? 0) + 1;
    asking.set(name, id);
    const mine = () => asking.get(name) === id;
    const t = setTimeout(() => mine() && setCards((c) => (name in c ? c : { ...c, [name]: "loading" })), auto ? 300 : 0);
    api.recap(name, auto ? 3 : undefined).then(
      (r) => {
        clearTimeout(t);
        if (mine()) asking.delete(name), setCards((c) => ({ ...c, [name]: r }));
      },
      () => {
        clearTimeout(t);
        if (mine()) dismiss(name);
      },
    );
  };

  const viewing = focused && api ? onScreen.map((n) => `${server}/${n}`) : [];
  const before = useRef<string[]>([]);
  useEffect(() => {
    if (!viewing.length && !before.current.length) return;
    const now = Date.now();
    const last = readLastShown();
    const back = cameBack(viewing, before.current, last, now);
    // The ones just gone off screen were on it until now.
    writeLastShown(markShown(last, [...viewing, ...before.current], now));
    before.current = viewing;
    for (const k of back) show(k.slice(server.length + 1), true);
  }, [viewing.join("\n"), tick]);

  return { cards, show, dismiss };
}

export function RecapCard(props: { card: Card; onClose: () => void }) {
  const { card } = props;
  return (
    <div className="recap-card" role="status" aria-label="Where this session is">
      <button className="tab-close" title="Dismiss" aria-label="Dismiss recap" onClick={props.onClose}>
        ×
      </button>
      {card === "loading" ? (
        <p className="recap-loading">…</p>
      ) : (
        <>
          <p className="recap-goal">{card.goal}</p>
          {card.done.length > 0 && <Part label="Done" items={card.done} />}
          {card.open.length > 0 && <Part label="Open" items={card.open} />}
        </>
      )}
    </div>
  );
}

function Part(props: { label: string; items: string[] }) {
  return (
    <div className="recap-part">
      <span className="recap-label">{props.label}</span>
      <ul aria-label={props.label}>
        {props.items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
