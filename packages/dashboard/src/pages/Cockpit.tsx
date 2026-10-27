import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Play, RotateCw, AlertTriangle, PauseCircle, ArrowRight, Inbox } from "lucide-react";
import { get, post } from "../api";
import type { AppState } from "../App";
import { FindingCard } from "../FindingCard";
import { RulingBox, RulingActions, History, type RulingMode } from "../Ruling";
import { Ico } from "../Timeline";
import { dayTime, plural } from "../fmt";

type Tab = "new" | "ruled" | "parked" | "dropped";
const TABS: { key: Tab; label: string }[] = [
  { key: "new", label: "New" },
  { key: "ruled", label: "Ruled" },
  { key: "parked", label: "Parked" },
  { key: "dropped", label: "Dropped drafts" },
];

const STAGE: Record<string, string> = {
  floor: "Below floor",
  rank: "Rank cap",
  root_cause: "Agent declined",
  gate: "Failed the gate",
  adversarial: "Broken in review",
  dedupe: "Dedupe",
};

function tabFromUrl(): Tab {
  const t = new URLSearchParams(location.search).get("tab") as Tab;
  return TABS.some((x) => x.key === t) ? t : "new";
}

/**
 * The cockpit: everything the radar wants from you as one card feed. Rulings
 * (File / Dismiss / Not now) are stored and override later passes. A card you
 * just ruled stays where it is until you leave the tab, so a ruling never
 * makes the page jump.
 */
export function Cockpit({ s }: { s: AppState }) {
  const [data, setData] = useState<any>(null);
  const [tab, setTabState] = useState<Tab>(tabFromUrl());
  const [stay, setStay] = useState<Set<string>>(new Set());
  const load = useCallback(async () => setData(await get("/api/cockpit")), []);

  useEffect(() => {
    void load();
  }, [load, s.findings, s.run?.phase, s.run?.findings, s.rev]);

  const setTab = (t: Tab) => {
    setTabState(t);
    setStay(new Set());
    const u = new URL(location.href);
    if (t === "new") u.searchParams.delete("tab");
    else u.searchParams.set("tab", t);
    history.replaceState(null, "", u);
  };
  const ruled = (cid: string) => {
    setStay((x) => new Set(x).add(cid));
    void load();
    void s.refresh();
  };

  const lists = useMemo(() => {
    const cards: any[] = data?.cards ?? [];
    const kept = (c: any) => stay.has(c.clusterId);
    return {
      new: cards.filter((c) => c.kind === "finding" && (!c.ruling || (kept(c) && tab === "new"))),
      ruled: cards.filter((c) => (c.ruling && c.ruling.ruling !== "park") || (kept(c) && tab === "ruled")),
      parked: cards.filter((c) => c.ruling?.ruling === "park" || (kept(c) && tab === "parked")),
      dropped: cards.filter((c) => c.kind === "draft" && (!c.ruling || (kept(c) && tab === "dropped"))),
    };
  }, [data, stay, tab]);

  if (!data) return <div className="pulse" style={{ color: "var(--ink-3)" }}>Loading the cockpit…</div>;
  const counts = data.counts;
  const waiting = counts.new;
  const running = s.run && !["done", "failed", "parked"].includes(s.run.phase);
  const last = data.runs[0];
  const rerun = (hours: number) => void post("/api/runs", { trigger: "run_now", lookbackHours: hours }).then(() => s.refresh());

  return (
    <div className="cockpit">
      <header className="cp-head">
        <div>
          <h1 className="h1">{waiting ? `${plural(waiting, "finding")} waiting for your ruling` : "Nothing is waiting for your ruling"}</h1>
          <p className="lede">
            The radar asks, you rule. Every ruling is stored and overrides later passes: dismissed items stay out, parked ones come back only with new evidence.
          </p>
        </div>
        <div className="cp-actions">
          <button className="btn" onClick={() => rerun(last?.lookbackHours ?? 24)} disabled={!!running} data-action="run-now">
            {running ? <RotateCw size={14} className="spin" /> : <Play size={14} />} {running ? "Pass running" : `Run the ${last ? last.label.toLowerCase().replace(/^first pass \((.*)\)$/, "$1 pass") : "pass"}`}
          </button>
          {data.output?.dryRun && (
            <span className="cp-out" title="No GitHub token is connected: File to GitHub records your ruling and shows the exact issue, nothing is sent.">
              Filing: dry run{data.output.repo ? ` · ${data.output.repo}` : ""}
            </span>
          )}
        </div>
      </header>

      <nav className="ctabs" role="tablist" aria-label="Cockpit">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} data-tab={t.key} onClick={() => setTab(t.key)}>
            {t.label}
            <span className={`ccount ${t.key === "new" && counts.new ? "hot" : ""}`}>{counts[t.key]}</span>
          </button>
        ))}
      </nav>

      {tab === "new" && (
        <div className="stack">
          {data.decisions.map((d: any) => (
            <Decision key={d.id} d={d} s={s} onRetry={() => rerun(last?.lookbackHours ?? 24)} />
          ))}
          {lists.new.map((c) => (
            <FindingCard key={c.clusterId} f={c.finding} card={c} onChanged={() => ruled(c.clusterId)} />
          ))}
          {!lists.new.length && !data.decisions.length && (
            <div className="cempty">
              <Inbox size={22} />
              <h3>{running ? "A pass is running" : "All caught up"}</h3>
              <p>{running ? "Findings land here the moment one passes the gate and the adversarial review." : last?.emptyReason ?? "Every finding has a ruling. New ones land here the moment they pass the gate and the adversarial review."}</p>
            </div>
          )}
          {counts.dropped > 0 && (
            <button className="teaser" onClick={() => setTab("dropped")} data-action="open-dropped">
              <span>
                <b>{plural(counts.dropped, "draft")} the radar dropped</b> · each with the reason it was dropped. Rule on any of them so later passes skip it.
              </span>
              <ArrowRight size={15} />
            </button>
          )}
          <section className="passes">
            <h2 className="sect-h">Recent passes</h2>
            {data.runs.map((r: any) => (
              <RunLine key={r.id} r={r} s={s} drafts={(data.cards as any[]).filter((c) => c.kind === "draft" && c.draft.runId === r.id)} onRerun={rerun} onRuled={ruled} />
            ))}
          </section>
        </div>
      )}

      {tab === "ruled" && (
        <div className="stack">
          {lists.ruled.map((c) =>
            c.kind === "finding" ? <FindingCard key={c.clusterId} f={c.finding} card={c} onChanged={() => ruled(c.clusterId)} /> : <DraftCard key={c.clusterId} c={c} onRuled={() => ruled(c.clusterId)} defaultOpen />,
          )}
          {!lists.ruled.length && <Empty>Nothing ruled yet. Filed and dismissed items land here with your reason and date, and the rule each one created.</Empty>}
        </div>
      )}

      {tab === "parked" && (
        <div className="stack">
          {lists.parked.length > 0 && (
            <p className="tabnote">
              <PauseCircle size={14} /> Parked items are checked on every pass. One returns to New on its own the first time a pass sees an occurrence after you parked it.
            </p>
          )}
          {lists.parked.map((c) =>
            c.kind === "finding" ? <FindingCard key={c.clusterId} f={c.finding} card={c} onChanged={() => ruled(c.clusterId)} /> : <DraftCard key={c.clusterId} c={c} onRuled={() => ruled(c.clusterId)} defaultOpen />,
          )}
          {!lists.parked.length && <Empty>Nothing parked. Not now puts an item here until new evidence arrives.</Empty>}
        </div>
      )}

      {tab === "dropped" && (
        <div className="stack tight">
          {lists.dropped.length > 0 && (
            <p className="tabnote">
              What the radar looked at and chose not to raise, with its reason. Dismiss one to stop later passes from looking at it again; Not now to wait for new evidence.
            </p>
          )}
          {lists.dropped.map((c) => (
            <DraftCard key={c.clusterId} c={c} onRuled={() => ruled(c.clusterId)} />
          ))}
          {!lists.dropped.length && <Empty>No dropped drafts without a ruling.</Empty>}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="cempty-s">{children}</p>;
}

function Decision({ d, s, onRetry }: { d: any; s: AppState; onRetry: () => void }) {
  return (
    <article className={`decision ${d.tone}`} data-decision={d.id}>
      {d.tone === "bad" ? <AlertTriangle size={17} /> : <PauseCircle size={17} />}
      <div>
        <b>{d.title}</b>
        <p>{d.body}</p>
      </div>
      {d.action && (
        <button className="btn" onClick={() => (d.action.do === "retry" ? onRetry() : s.go(d.action.do === "open_usage" ? "usage" : "runs"))}>
          {d.action.label}
        </button>
      )}
    </article>
  );
}

/** A dropped draft: collapsed to one line, opens on why it was dropped. Rulings: Not now, Dismiss (no finding to file). */
export function DraftCard({ c, onRuled, defaultOpen = false }: { c: any; onRuled: () => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [mode, setMode] = useState<RulingMode>("idle");
  const d = c.draft;
  return (
    <article className={`dcard ${open ? "open" : ""} ${c.ruling ? `ruled-${c.ruling.ruling}` : ""}`} data-draft={c.clusterId}>
      <button className="dcard-top" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`stagetag st-${d.stage}`}>{STAGE[d.stage] ?? d.stage}</span>
        <span className="dtitle">
          {c.title}
          {c.resurfaced && (
            <span className="rtag back" title={c.resurfaced.note}>
              Back · new evidence
            </span>
          )}
        </span>
        <span className="dmeta">
          {Number.isFinite(d.usersAffected) ? plural(d.usersAffected, "person", "people") : ""}
          {c.ruling && <span className={`rtag ${c.ruling.ruling}`}>{c.ruling.ruling === "dismiss" ? "Dismissed" : c.ruling.ruling === "park" ? "Parked" : "Filed"}</span>}
        </span>
        <ChevronDown size={16} className="dchev" />
      </button>
      {open && (
        <div className="dbody">
          <div className="dwhy">
            <h4>Why the radar dropped it</h4>
            <p>{d.reason}</p>
            <small>
              {d.runLabel} · {dayTime(d.at)}
              {d.timesDropped > 1 ? ` · dropped in ${d.timesDropped} passes` : ""}
            </small>
          </div>
          {c.ruling && mode === "idle" ? <RulingBox card={c} onChange={() => setMode("changing")} /> : <RulingActions card={c} mode={mode} setMode={setMode} onRuled={onRuled} />}
          <History items={c.history} />
        </div>
      )}
    </article>
  );
}

/** One line per pass: "30-day pass · 1 finding · 6 dropped · $1.42". Opens on its notes and its drops. */
function RunLine({ r, s, drafts, onRerun, onRuled }: { r: any; s: AppState; drafts: any[]; onRerun: (h: number) => void; onRuled: (cid: string) => void }) {
  const [open, setOpen] = useState(false);
  const facts = [
    r.phase === "done" || r.phase === "failed" ? plural(r.findings, "finding") : r.phase === "parked" ? "parked" : "running",
    r.dropped ? `${r.dropped} dropped` : null,
    r.suppressed ? `${r.suppressed} suppressed by ruling` : null,
    `$${r.costUsd.toFixed(2)}`,
  ].filter(Boolean);
  return (
    <div className={`rline ${open ? "open" : ""}`} data-run={r.id}>
      <button className="rline-top" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Ico s={r.phase === "done" ? "done" : r.phase === "failed" ? "failed" : r.phase === "parked" ? "parked" : "running"} />
        <span className="rl-l">
          <b>{r.label}</b>
          {facts.map((f) => (
            <span key={f}> · {f}</span>
          ))}
        </span>
        <span className="rl-when">{dayTime(r.startedAt)}</span>
        <ChevronRight size={15} className="rl-chev" />
      </button>
      {open && (
        <div className="rline-b">
          {r.emptyReason && <p className="rnote">{r.emptyReason}</p>}
          {r.notes.map((n: string) => (
            <p className="rnote" key={n}>
              {n}
            </p>
          ))}
          {drafts.length > 0 && (
            <div className="stack tight" style={{ marginTop: 10 }}>
              {drafts.map((c) => (
                <DraftCard key={c.clusterId} c={c} onRuled={() => onRuled(c.clusterId)} />
              ))}
            </div>
          )}
          <div className="rbtns" style={{ marginTop: 12 }}>
            <button className="btn" onClick={() => s.go("runs", r.id)}>
              Phase timeline <ArrowRight size={13} />
            </button>
            <button className="btn ghost" onClick={() => onRerun(r.lookbackHours)} disabled={s.run && !["done", "failed"].includes(s.run.phase)} data-action="rerun">
              <RotateCw size={13} /> Run this pass again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
