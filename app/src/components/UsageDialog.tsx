import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { errorText, type ServerLink } from "../lib/connection";
import { relTime } from "../lib/time";
import { accountName, busiest, cacheShare, change, dayLabel, high, modelName, money, projectParts, resetsIn, share, tokens, windowLabel, type NowView, type Sum, type UsageView, type Window } from "../lib/usage";
import { Dialog } from "./Dialog";
import { Meter, shown, tzNow } from "./StatusBar";
import { chartSeries, CostChart } from "./UsageChart";

const RANGES = [
  { value: 1, label: "Today" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 3660, label: "All" },
];

type Tab = "account" | "model" | "project";

// Usage (Server > Usage…, or a click on the bottom bar; docs/superpowers/specs/2026-11-19-usage-design.md, "Usage
// window"): for the server of the tab in front, the limits, then tokens and cost at API prices over a range, as
// headline numbers, a chart and one table. blimpd works it all out; this only draws it. The head stays put while the
// body scrolls.
export function UsageDialog(props: { link: ServerLink; onClose: () => void }) {
  const l = props.link;
  const [days, setDays] = useState(30);
  const [by, setBy] = useState<"account" | "model">("model");
  const [tab, setTab] = useState<Tab>("model");
  const [view, setView] = useState<UsageView | null>(null);
  const [now, setNow] = useState<NowView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const api = l.api;
    if (!api) return setError(`${l.name} isn't connected.`);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api.usage(days, tzNow()).then(
        (v) => {
          if (!live) return;
          setView(v);
          setError("");
          // The first scan of the history is still running: ask again until it has ended.
          if (v.scanning) timer = setTimeout(load, 5000);
        },
        (e) => live && setError(e instanceof ApiError && e.status === 404 ? `blimpd on ${l.name} is too old to count usage. Update it (Server > Update Server…).` : errorText(e)),
      );
      api.usageNow(tzNow()).then(
        (v) => live && setNow(v),
        () => {},
      );
    };
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [l.api, days]);

  const hourly = days === 1 && !!view?.hours;
  return (
    <Dialog className="usage" onClose={props.onClose}>
      <div className="usage-head">
        <h2>Usage</h2>
        <span className="usage-server">{l.name}</span>
        <Choice label="Range" options={RANGES} value={days} onChange={setDays} />
      </div>
      <div className="usage-body">
        {now && <Limits now={now} />}
        {error && <p className="dialog-error usage-error">{error}</p>}
        {view?.scanning && <p className="usage-note">Counting your history…</p>}
        {view && !view.scanning && (
          <>
            <Headline view={view} days={days} />
            <section className="usage-card" aria-label={hourly ? "Cost per hour" : "Cost per day"}>
              <div className="usage-card-head">
                <h3>{hourly ? "Cost per hour" : "Cost per day"}</h3>
                <Choice
                  label="Colour by"
                  options={[
                    { value: "account", label: "By account" },
                    { value: "model", label: "By model" },
                  ]}
                  value={by}
                  onChange={setBy}
                />
              </div>
              <CostChart view={view} by={by} days={days} />
            </section>
            <Breakdown view={view} tab={tab} onTab={setTab} by={by} home={l.home} />
          </>
        )}
      </div>
    </Dialog>
  );
}

const sumTokens = (s: Sum) => s.input + s.output + s.cacheRead + s.cacheWrite;
const percent = (part: number) => `${Math.round(part * 100)}%`;

// A rounded track with the chosen option raised in it: the range, what the chart is coloured by, the table's tab.
function Choice<T extends string | number>(props: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="usage-choice" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// A limit window's name on its card: Claude's two, and Codex's by its length.
const windowName = (minutes: number) => (minutes === 300 ? "5-hour" : minutes === 7 * 24 * 60 ? "Weekly" : windowLabel(minutes));

// One card per account and one for Codex: each window's percent, meter and reset, and "in use" or the numbers' age.
function Limits(props: { now: NowView }) {
  const at = Date.now();
  const { accounts, codex, statusline } = props.now;
  if (!accounts.length && !codex && statusline) return null;
  const rows = (list: [string, Window | undefined][]) => {
    const there = list.filter((x): x is [string, Window] => !!x[1]);
    if (!there.length) return <p className="usage-limit-none">No numbers yet</p>;
    return there.map(([name, w]) => (
      <div key={name} className="usage-window">
        <span className="usage-window-name">{name}</span>
        <span className={"usage-window-num" + (high(shown(w)) ? " meter-high" : "")}>{shown(w)}%</span>
        <Meter used={shown(w)} />
        <span className="usage-window-reset">{resetsIn(w.resetsAt, at)}</span>
      </div>
    ));
  };
  // name in full ink, rest (an email's domain, Codex's plan) faint; at the right "in use" or the numbers' age.
  const card = (key: string, name: string, rest: string, title: string | undefined, side: { inUse: boolean; at?: number }, body: ReactNode) => (
    <div key={key} className="usage-limit">
      <div className="usage-limit-head">
        <span className="usage-limit-name" title={title}>
          {name}
          {rest && <span className="usage-faint">{rest}</span>}
        </span>
        {side.inUse ? (
          <span className="usage-limit-use">
            <span className="usage-use-dot" aria-hidden />
            in use
          </span>
        ) : side.at ? (
          <span className="usage-limit-age" title={`Numbers from ${new Date(side.at).toLocaleString()}`}>
            {relTime(side.at, at)}
          </span>
        ) : null}
      </div>
      {body}
    </div>
  );
  return (
    <section aria-label="Limits">
      <div className="usage-limits">
        {accounts.map((a) => {
          const name = accountName(a);
          const cut = a.email ? name.indexOf("@") : -1;
          const limits = rows([
            ["5-hour", a.fiveHour],
            ["Weekly", a.sevenDay],
          ]);
          return card(a.id, cut > 0 ? name.slice(0, cut) : name, cut > 0 ? name.slice(cut) : "", a.id || undefined, a, limits);
        })}
        {codex &&
          card(
            "codex",
            "Codex",
            codex.plan ? ` ${codex.plan}` : "",
            undefined,
            { inUse: false, at: codex.at },
            rows(codex.windows.map((w) => [windowName(w.minutes), w])),
          )}
      </div>
      {!statusline && <p className="usage-note">Claude's limits are not being read. Run blimpd install-statusline on the server.</p>}
    </section>
  );
}

// Four numbers in one strip, each with a line of context: cost against the period before (never coloured: spending
// more isn't a fault), tokens and the share read from cache, replies and the helpers' share of cost, cost per day
// (Today: per hour) and the busiest one.
function Headline(props: { view: UsageView; days: number }) {
  const v = props.view;
  const t = v.totals;
  // Today isn't over, so it is held against the whole of yesterday.
  const before = props.days === 1 ? "all of yesterday" : `the ${props.days} days before`;
  const c = change(t.cost, v.previous?.cost);
  const vs = c === undefined ? "" : c === "the same" ? `the same as ${before}` : `${c} than ${before}`;
  let per: { label: string; value: string; note: string };
  if (props.days === 1 && v.hours) {
    const hours = new Date().getHours() + 1; // today's hours so far, this one included
    const peak = busiest(v.hours.map((h) => ({ day: `${String(h.hour).padStart(2, "0")}:00`, byModel: h.byModel })));
    per = { label: "Per hour", value: money(t.cost / hours), note: peak ? `busiest ${peak.day} · ${money(peak.cost)}` : "" };
  } else {
    const peak = busiest(v.days);
    per = { label: "Per day", value: money(t.cost / Math.max(1, v.days.length)), note: peak ? `busiest ${dayLabel(peak.day)} · ${money(peak.cost)}` : "" };
  }
  const cells = [
    { label: "Cost at API prices", value: money(t.cost), note: vs },
    { label: "Tokens", value: tokens(sumTokens(t)), note: `${percent(cacheShare(t))} read from cache` },
    { label: "Replies", value: t.replies.toLocaleString("en-US"), note: t.cost > 0 ? `${percent(t.helperCost / t.cost)} of cost by helper agents` : "" },
    per,
  ];
  return (
    <div className="usage-headline">
      {cells.map((x) => (
        <div key={x.label} className="usage-figure">
          <span className="usage-figure-label">{x.label}</span>
          <span className="usage-figure-value">{x.value}</span>
          {/* Kept when empty, so the four cells stay the same height. */}
          <span className="usage-figure-note" title={x.note || undefined}>
            {x.note || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

// One table with a tab each for accounts, models and projects, most cost first: the name (with the chart's dot when it
// is one of the chart's series), a bar for its share of the range's cost, then cost, share and tokens. A model with no
// price says so and has no share.
function Breakdown(props: { view: UsageView; tab: Tab; onTab: (t: Tab) => void; by: "account" | "model"; home: string }) {
  const v = props.view;
  const total = v.totals.cost;
  // undefined: no dot column (projects); null: a dot's room, empty, so the names line up.
  type Row = { key: string; name: ReactNode; title?: string; sum: Sum; priced?: boolean; dot?: string | null };
  // A dot points at the chart, so rows get theirs only while the chart is drawn by the same thing.
  const dots = (by: "account" | "model") => new Map(by === props.by ? chartSeries(v, by).map((s, i) => [s.id, `var(--series-${i + 1})`] as const) : []);
  let rows: Row[];
  if (props.tab === "account") {
    const d = dots("account");
    rows = v.accounts.map((a) => ({ key: a.id, name: accountName(a), title: a.id ? `${accountName(a)} (${a.id})` : accountName(a), sum: a, dot: d.get(a.id) ?? null }));
  } else if (props.tab === "model") {
    const d = dots("model");
    rows = v.models.map((m) => ({ key: m.model, name: modelName(m.model), title: m.model, sum: m, priced: m.priced, dot: d.get(m.model) ?? null }));
  } else {
    rows = v.projects.map((p) => {
      const parts = projectParts(p.project, props.home || undefined);
      const name = (
        <>
          {parts.name}
          {parts.where && <span className="usage-faint"> {parts.where}</span>}
        </>
      );
      return { key: p.project, name, title: p.project || "Every other folder", sum: p };
    });
  }
  return (
    <section className="usage-card" aria-label="Breakdown">
      <div className="usage-card-head">
        <Choice
          label="Break down by"
          options={[
            { value: "account" as Tab, label: "Accounts" },
            { value: "model" as Tab, label: "Models" },
            { value: "project" as Tab, label: "Projects" },
          ]}
          value={props.tab}
          onChange={props.onTab}
        />
      </div>
      {rows.length === 0 ? (
        <p className="usage-note">Nothing in this range.</p>
      ) : (
        <table className="usage-table">
          <colgroup>
            <col />
            <col className="usage-col-bar" />
            <col className="usage-col-cost" />
            <col className="usage-col-share" />
            <col className="usage-col-num" />
            <col className="usage-col-num" />
            <col className="usage-col-num" />
            <col className="usage-col-num" />
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th aria-label="Share of cost" />
              <th>Cost</th>
              <th>Share</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cached</th>
              <th>Replies</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const priced = r.priced !== false;
              return (
                <tr key={r.key}>
                  <td title={r.title}>
                    <span className="usage-name">
                      {r.dot !== undefined && <span className="usage-dot" style={r.dot ? { background: r.dot } : { visibility: "hidden" }} />}
                      <span className="usage-name-text">{r.name}</span>
                    </span>
                  </td>
                  <td>
                    <span className="usage-share">{priced && total > 0 && <span className="usage-share-fill" style={{ width: `${Math.min(100, (r.sum.cost / total) * 100)}%` }} />}</span>
                  </td>
                  <td className={priced ? "usage-cost" : "usage-faint"}>{priced ? money(r.sum.cost) : "no price"}</td>
                  <td>{priced ? share(r.sum.cost, total) : "—"}</td>
                  <td>{tokens(r.sum.input)}</td>
                  <td>{tokens(r.sum.output)}</td>
                  <td>{tokens(r.sum.cacheRead + r.sum.cacheWrite)}</td>
                  <td>{r.sum.replies.toLocaleString("en-US")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {props.tab === "model" && v.note && <p className="usage-note">{v.note}</p>}
      {props.tab === "model" && v.unpriced.length > 0 && <p className="usage-note">No price for: {v.unpriced.join(", ")}. Add them to ~/.blimp/prices.json on the server.</p>}
    </section>
  );
}
