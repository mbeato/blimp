import { useEffect, useState } from "react";
import type { ServerLink } from "../lib/connection";
import { tokens as contextTokens } from "../lib/handoff";
import { openWebLink } from "../lib/links";
import { relTime } from "../lib/time";
import { accountName, barInfo, high, money, resetsIn, tokens, windowLabel, type NowView, type Window } from "../lib/usage";
import { ServerDot } from "./ServerSwitcher";

// Minutes east of UTC, as blimpd's /usage routes take it.
export const tzNow = () => -new Date().getTimezoneOffset();

// The bottom bar (docs/superpowers/specs/2026-11-19-usage-design.md, "Bottom bar"), for the tab in front. On the left,
// where you are: the server, the branch and its pull request, sessions working and waiting, the focused session's model
// and context, and running jobs (lib/usage.ts barInfo works them out; each is left out when it has nothing to say). On
// the right, usage: the Claude account in use and its limits, Codex's limit and today's cost, one button that opens the
// Usage window. Usage is asked when the server changes, when the window gets focus, and every minute while it shows; any
// error (an older blimpd's 404 too) leaves that part out: it is passive. The left side gives way first when it's narrow.
export function StatusBar(props: { link: ServerLink; folder: string | null; focused: string | undefined; onOpen: () => void; onJump: () => void }) {
  const [now, setNow] = useState<NowView | null>(null);
  const l = props.link;
  const api = l.status === "connected" ? l.api : null;
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

  // An offline server's last list may be long out of date: only a connected one's sessions count.
  const info = barInfo(l.status === "connected" ? (l.sessions ?? []) : [], props.folder, props.focused);
  const pr = info.pr;
  const ctx = info.focused?.used !== undefined && info.focused.limit ? { used: info.focused.used, limit: info.focused.limit } : undefined;
  const ctxPercent = ctx ? Math.round((ctx.used / ctx.limit) * 100) : 0;

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
      <div className="sb-left">
        <span className="sb-item" title={[l.name, l.version && `blimpd ${l.version}`, l.status].filter(Boolean).join(" · ")}>
          <ServerDot status={l.status} />
          <span className="sb-text sb-server">{l.name}</span>
        </span>
        {info.branch &&
          (pr ? (
            <button className="sb-item" title={pr.title} aria-label={`Open pull request #${pr.number}: ${pr.title}`} onClick={() => openWebLink(pr.url)}>
              <BranchIcon />
              <span className="sb-text sb-branch">{info.branch}</span>
              <span className="sb-pr">#{pr.number}</span>
            </button>
          ) : (
            <span className="sb-item" title={`Branch ${info.branch}`}>
              <BranchIcon />
              <span className="sb-text sb-branch">{info.branch}</span>
            </span>
          ))}
        {(info.working > 0 || info.waiting.length > 0) && (
          <button
            className="sb-item"
            title={[...info.waiting.map((t) => `Waiting: ${t}`), "Jump to Session"].join("\n")}
            onClick={props.onJump}
          >
            <SessionsIcon />
            {info.working > 0 && <span>{info.working} working</span>}
            {info.waiting.length > 0 && <span className="sb-waiting">{info.waiting.length} waiting</span>}
          </button>
        )}
        {info.focused && (
          <span className="sb-item sb-ctx" title={ctx ? `Context ${ctxPercent}% (${contextTokens(ctx.used)} of ${contextTokens(ctx.limit)} tokens)` : info.focused.label}>
            <span className="sb-text sb-label">{info.focused.label}</span>
            {ctx && (
              <>
                {/* Red from 80%, as the session row's context bar (lib/handoff.ts contextMeter). */}
                <Meter used={ctxPercent} high={ctxPercent >= 80} />
                <span className={"sb-num" + (ctxPercent >= 80 ? " meter-high" : "")}>{ctxPercent}%</span>
              </>
            )}
          </span>
        )}
        {info.jobs.length > 0 && (
          <span className="sb-item" title={info.jobs.join("\n")}>
            <JobsIcon />
            <span className="sb-text">
              {info.jobs.length} {info.jobs.length === 1 ? "job" : "jobs"}
            </span>
          </span>
        )}
      </div>
      {now && (
        <button className="sb-item sb-usage" aria-label="Usage" title={lines.join("\n")} onClick={props.onOpen}>
          {account && <span className="sb-account">{accountName(account, true)}</span>}
          {claude?.fiveHour && <Item label="5h" w={claude.fiveHour} />}
          {claude?.sevenDay && <Item label="week" w={claude.sevenDay} />}
          {codex && <Item label="Codex" w={codex} />}
          <span className="sb-group">
            <span className="sb-label-faint">today</span>
            <span className="sb-amount">{money(now.today.cost)}</span>
          </span>
        </button>
      )}
    </footer>
  );
}

// A window past its reset shows as reset: an empty meter and 0%.
export const shown = (w: Window) => (w.reset ? 0 : Math.round(w.used));

function Item(props: { label: string; w: Window }) {
  const used = shown(props.w);
  return (
    <span className="sb-group">
      <span className="sb-label-faint">{props.label}</span>
      <Meter used={used} />
      <span className={"sb-num" + (high(used) ? " meter-high" : "")}>{used}%</span>
    </span>
  );
}

// A track with a fill, as wide as used (a percent); red when high (by default over 80%, as a limit's). Also the
// Usage window's.
export function Meter(props: { used: number; high?: boolean }) {
  return (
    <span className="meter" aria-hidden>
      <span className={"meter-fill" + ((props.high ?? high(props.used)) ? " high" : "")} style={{ width: `${Math.max(0, Math.min(100, props.used))}%` }} />
    </span>
  );
}

const BranchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
    <path d="M5 5v6M11 6c0 3-6 2.5-6 5" fill="none" stroke="currentColor" />
    <circle cx="5" cy="3.5" r="1.5" fill="none" stroke="currentColor" />
    <circle cx="5" cy="12.5" r="1.5" fill="none" stroke="currentColor" />
    <circle cx="11" cy="4.5" r="1.5" fill="none" stroke="currentColor" />
  </svg>
);

const SessionsIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" />
    <path d="M5 7l2 1.5L5 10M8.5 10H11" fill="none" stroke="currentColor" />
  </svg>
);

const JobsIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
    <path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" fill="none" stroke="currentColor" />
  </svg>
);
