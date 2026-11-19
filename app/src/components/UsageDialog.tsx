import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { errorText, type ServerLink } from "../lib/connection";
import { relTime } from "../lib/time";
import { accountName, cacheShare, chart, dayLabel, money, projectName, resetsIn, share, tokens, windowLabel, type NowView, type Sum, type UsageView, type Window } from "../lib/usage";
import { Dialog } from "./Dialog";
import { Meter, tzNow } from "./StatusBar";

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 3660, label: "All" },
];

// Usage (Server > Usage…, or a click on the bottom bar; docs/superpowers/specs/2026-11-19-usage-design.md, "Usage
// window"): for the server of the tab in front, the limits, then tokens and cost at API prices over a range, as
// numbers, bars per day and tables. blimpd works it all out; this only draws it.
export function UsageDialog(props: { link: ServerLink; onClose: () => void }) {
  const l = props.link;
  const [days, setDays] = useState(30);
  const [by, setBy] = useState<"account" | "model">("account");
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

  const total = view?.totals.cost ?? 0;
  return (
    <Dialog className="usage" onClose={props.onClose}>
      <div className="usage-head">
        <h2>Usage</h2>
        <span className="usage-server">{l.name}</span>
      </div>
      <div className="usage-body">
        {now && <Limits now={now} />}
        <div className="usage-controls">
          <Choice label="Range" options={RANGES.map((r) => ({ value: r.days, label: r.label }))} value={days} onChange={setDays} />
        </div>
        {error && <p className="dialog-error usage-error">{error}</p>}
        {view?.scanning && <p className="usage-note">Counting your history…</p>}
        {view && !view.scanning && (
          <>
            <div className="usage-numbers">
              <Figure label="Cost" value={money(total)} note="at API prices" />
              <Figure label="Tokens" value={tokens(sumTokens(view.totals))} />
              <Figure label="Replies" value={view.totals.replies.toLocaleString("en-US")} />
              <Figure label="From cache" value={`${Math.round(cacheShare(view.totals) * 100)}%`} note="of input" />
            </div>
            <section className="usage-section" aria-label="Cost per day">
              <div className="usage-section-head">
                <h3>Cost per day</h3>
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
              <Bars view={view} by={by} />
            </section>
            <Table title="By account" total={total} rows={view.accounts.map((a) => ({ key: a.id, name: accountName(a), title: a.id || undefined, sum: a }))} />
            <Table title="By model" total={total} rows={view.models.map((m) => ({ key: m.model, name: m.model, sum: m, priced: m.priced }))}>
              {view.note && <p className="usage-note">{view.note}</p>}
              {view.unpriced.length > 0 && <p className="usage-note">No price for: {view.unpriced.join(", ")}. Add them to ~/.blimp/prices.json on the server.</p>}
            </Table>
            <Table title="By project" total={total} rows={view.projects.map((p) => ({ key: p.project, name: projectName(p.project, l.home), title: p.project || undefined, sum: p }))} />
          </>
        )}
      </div>
    </Dialog>
  );
}

const sumTokens = (s: Sum) => s.input + s.output + s.cacheRead + s.cacheWrite;

// A row of buttons, one of them pressed: the range, and what the bars are coloured by.
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

function Figure(props: { label: string; value: string; note?: string }) {
  return (
    <div className="usage-number">
      <span className="usage-number-label">{props.label}</span>
      <span className="usage-number-value">{props.value}</span>
      {props.note && <span className="usage-number-note">{props.note}</span>}
    </div>
  );
}

// One line per account, then Codex: meters with their percent and reset, "in use" or how old the numbers are.
function Limits(props: { now: NowView }) {
  const at = Date.now();
  const { accounts, codex, statusline } = props.now;
  if (!accounts.length && !codex && statusline) return null;
  const windows = (list: [string, Window | undefined][]) =>
    list.map(([label, w]) =>
      w ? (
        <span key={label} className="usage-window">
          {label}
          <Meter w={w} />
          <span className="usage-window-num">{w.reset ? 0 : Math.round(w.used)}%</span>
          <span className="usage-window-reset">{resetsIn(w.resetsAt, at)}</span>
        </span>
      ) : null,
    );
  return (
    <section className="usage-section" aria-label="Limits">
      <h3>Limits</h3>
      {accounts.map((a) => (
        <div key={a.id} className="usage-limit">
          <span className="usage-limit-name" title={a.id}>
            {accountName(a)}
          </span>
          <span className="usage-limit-age" title={a.at ? `Numbers from ${relTime(a.at, at)}` : undefined}>
            {a.inUse ? "in use" : a.at ? relTime(a.at, at) : ""}
          </span>
          {a.fiveHour || a.sevenDay ? (
            windows([
              ["5h", a.fiveHour],
              ["week", a.sevenDay],
            ])
          ) : (
            <span className="usage-window-none">No numbers yet</span>
          )}
        </div>
      ))}
      {codex && (
        <div className="usage-limit">
          <span className="usage-limit-name">Codex{codex.plan ? ` (${codex.plan})` : ""}</span>
          <span className="usage-limit-age">{relTime(codex.at, at)}</span>
          {windows(codex.windows.map((w) => [windowLabel(w.minutes), w]))}
        </div>
      )}
      {!statusline && <p className="usage-note">Claude's limits are not being read. Run blimpd install-statusline on the server.</p>}
    </section>
  );
}

// Cost per day, stacked by account or by model: plain divs, the height by cost. The 5 costliest series get a colour
// each and the rest share a grey; the legend under the bars names them, and each part says its day, name and cost.
function Bars(props: { view: UsageView; by: "account" | "model" }) {
  const v = props.view;
  const named = props.by === "account" ? v.accounts.filter((a) => a.cost > 0).map((a) => ({ id: a.id, name: accountName(a) })) : v.models.filter((m) => m.cost > 0).map((m) => ({ id: m.model, name: m.model }));
  const c = chart(v.days, props.by, named.map((n) => n.id));
  if (!c.max) return <p className="usage-note">No cost in this range.</p>;
  const names = named.slice(0, c.series.length).map((n) => n.name);
  const when = (b: (typeof c.bars)[number]) => (b.from === b.to ? dayLabel(b.from) : `${dayLabel(b.from)} – ${dayLabel(b.to)}`);
  const first = c.bars[0];
  const last = c.bars[c.bars.length - 1];
  return (
    <>
      <div className="usage-plot">
        <span className="usage-plot-max">{money(c.max)}</span>
        <div className={"usage-bars" + (c.bars.length > 120 ? " dense" : "")}>
          {c.bars.map((b) => (
            <div key={b.from} className="usage-bar-slot" title={`${when(b)} · ${money(b.total)}`}>
              <div className="usage-bar" style={{ height: `${(b.total / c.max) * 100}%` }}>
                {b.rest > 0 && <Part grow={b.rest} color="var(--series-rest)" title={`${when(b)} · Other · ${money(b.rest)}`} />}
                {b.costs
                  .map((cost, i) => ({ cost, i }))
                  .reverse()
                  .map(({ cost, i }) => cost > 0 && <Part key={i} grow={cost} color={`var(--series-${i + 1})`} title={`${when(b)} · ${names[i]} · ${money(cost)}`} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="usage-axis">
        <span>{dayLabel(first.from)}</span>
        {c.bars.length > 1 && <span>{dayLabel(last.to)}</span>}
      </div>
      <div className="usage-legend">
        {names.map((n, i) => (
          <span key={c.series[i]} className="usage-key">
            <span className="usage-swatch" style={{ background: `var(--series-${i + 1})` }} />
            {n}
          </span>
        ))}
        {c.rest && (
          <span className="usage-key">
            <span className="usage-swatch" style={{ background: "var(--series-rest)" }} />
            Other
          </span>
        )}
      </div>
    </>
  );
}

function Part(props: { grow: number; color: string; title: string }) {
  return <div className="usage-part" style={{ flexGrow: props.grow, background: props.color }} title={props.title} />;
}

// name, input, output, cached (read and written), cost, share of the range's cost. A model with no price says so.
function Table(props: { title: string; total: number; rows: { key: string; name: string; title?: string; sum: Sum; priced?: boolean }[]; children?: ReactNode }) {
  return (
    <section className="usage-section" aria-label={props.title}>
      <h3>{props.title}</h3>
      {props.rows.length === 0 ? (
        <p className="usage-note">Nothing in this range.</p>
      ) : (
        <table className="usage-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cached</th>
              <th>Cost</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.key}>
                <td className="usage-name" title={r.title ?? r.name}>
                  {r.name}
                </td>
                <td>{tokens(r.sum.input)}</td>
                <td>{tokens(r.sum.output)}</td>
                <td>{tokens(r.sum.cacheRead + r.sum.cacheWrite)}</td>
                <td>{r.priced === false ? "no price" : money(r.sum.cost)}</td>
                <td>{r.priced === false ? "—" : share(r.sum.cost, props.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.children}
    </section>
  );
}
