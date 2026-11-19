import { useEffect, useState } from "react";
import type { ServerLink } from "../lib/connection";
import { relTime } from "../lib/time";
import { accountName, high, money, resetsIn, tokens, windowLabel, type NowView, type Window } from "../lib/usage";

// Minutes east of UTC, as blimpd's /usage routes take it.
export const tzNow = () => -new Date().getTimezoneOffset();

// The bottom bar (docs/superpowers/specs/2026-11-19-usage-design.md, "Bottom bar"): for the server of the tab in
// front, the Claude account in use and its limits, Codex's limit and today's cost. One button, so the whole group is
// one click and one tab stop, and opens the Usage window. Asked when the server changes, when the window gets focus,
// and every minute while it shows. Any error (an older blimpd's 404 too) leaves the bar empty: it is passive.
export function StatusBar(props: { link: ServerLink; onOpen: () => void }) {
  const [now, setNow] = useState<NowView | null>(null);
  const api = props.link.status === "connected" ? props.link.api : null;
  useEffect(() => {
    setNow(null);
    if (!api) return;
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      api.usageNow(tzNow()).then(
        (v) => live && setNow(v),
        () => live && setNow(null),
      );
    };
    load();
    const timer = setInterval(load, 60_000);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [api]);

  const at = Date.now();
  const account = now?.accounts.find((a) => a.inUse);
  // The Claude meters only while the status line step is in place and there are numbers for the account in use.
  const claude = now?.statusline && account && (account.fiveHour || account.sevenDay) ? account : undefined;
  const codex = now?.codex?.windows[0];
  const lines: string[] = [];
  if (account) lines.push(`${accountName(account)} (in use)`);
  if (claude) {
    for (const [label, w] of [
      ["5h", claude.fiveHour],
      ["week", claude.sevenDay],
    ] as const)
      if (w) lines.push(`${label}: ${shown(w)}%, ${resetsIn(w.resetsAt, at)}`);
    if (claude.at) lines.push(`Claude's numbers are from ${relTime(claude.at, at)}`);
  }
  if (now?.codex && codex) {
    lines.push(`Codex ${windowLabel(codex.minutes)}: ${shown(codex)}%, ${resetsIn(codex.resetsAt, at)}`);
    lines.push(`Codex's numbers are from ${relTime(now.codex.at, at)}`);
  }
  if (now) lines.push(`Today: ${money(now.today.cost)} at API prices, ${tokens(now.today.tokens)} tokens`);

  return (
    <footer className="statusbar">
      {now && (
        <button className="statusbar-usage" aria-label="Usage" title={lines.join("\n")} onClick={props.onOpen}>
          {account && <span className="statusbar-item">{accountName(account, true)}</span>}
          {claude?.fiveHour && <Item label="5h" w={claude.fiveHour} />}
          {claude?.sevenDay && <Item label="week" w={claude.sevenDay} />}
          {codex && <Item label="Codex" w={codex} />}
          <span className="statusbar-item">today {money(now.today.cost)}</span>
        </button>
      )}
    </footer>
  );
}

// A window past its reset shows as reset: an empty meter and 0%.
const shown = (w: Window) => (w.reset ? 0 : Math.round(w.used));

function Item(props: { label: string; w: Window }) {
  return (
    <span className="statusbar-item">
      {props.label}
      <Meter w={props.w} />
      <span className={high(shown(props.w)) ? "meter-high" : undefined}>{shown(props.w)}%</span>
    </span>
  );
}

// A track with a fill, red over 80% as a session row's context bar. Also the Usage window's.
export function Meter(props: { w: Window }) {
  const used = shown(props.w);
  return (
    <span className="meter" aria-hidden>
      <span className={"meter-fill" + (high(used) ? " high" : "")} style={{ width: `${Math.min(100, used)}%` }} />
    </span>
  );
}
