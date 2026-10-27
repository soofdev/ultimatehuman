import { useState } from "react";
import { ArrowRight, History, Radar, SearchCheck } from "lucide-react";
import { post } from "../api";
import type { AppState } from "../App";
import { Ico, RunTimeline, startedLine } from "../Timeline";
import { FindingCard } from "../FindingCard";
import { timeS, dur } from "../fmt";

const ORDER = ["claude", "posthog", "sentry", "github", "code"];

export function Setup({ s }: { s: AppState }) {
  const ob = s.onboarding;
  const run = s.run;
  const checks: any[] = ob?.checks ?? [];
  const grouped = ORDER.map((id) => ({ id, items: checks.filter((c) => c.id.startsWith(id + ".")) })).filter((g) => g.items.length);
  const runFindings = run ? s.findings.filter((f) => f.runId === run.id) : [];
  const first = runFindings[runFindings.length - 1];
  const sinceInit = first && ob?.initStartedAt ? Date.parse(first.createdAt) - Date.parse(ob.initStartedAt) : null;
  const done = run?.phase === "done";
  const wider = run && run.trigger !== "onboarding";
  const days = run ? Math.round(run.lookbackHours / 24) : 7;
  const [widening, setWidening] = useState(false);
  const widen = () => {
    setWidening(true);
    void post("/api/runs", { trigger: "run_now", lookbackHours: 720 }).then(() => s.refresh()).finally(() => setWidening(false));
  };

  return (
    <div className="stack">
      <div>
        <h1 className="h1">{first ? "Your first finding is in." : wider ? (done ? `${days}-day pass complete.` : `Looking back ${days} days.`) : done ? "First pass complete." : "You're set up. The first pass is running."}</h1>
        <p className="lede">
          {first
            ? "Root-caused from your own PostHog data, checked by a gate and a second agent that tried to break it. Every claim links back to the data."
            : "Everything below was detected and checked live by init. Nothing is written anywhere: the radar only reads your trackers."}
        </p>
      </div>

      <section className="card">
        <div className="card-h">
          <h3>Connections</h3>
          <span className="sub">{ob?.initStartedAt ? `checked live by init at ${timeS(ob.initStartedAt)}` : "waiting for init"}</span>
        </div>
        <div className="card-b">
          {grouped.flatMap((g) =>
            g.items.map((c: any, i: number) => (
              <div className="check" key={c.id}>
                <Ico s={c.status === "ok" ? "ok" : c.status === "warn" ? "parked" : c.status === "missing" ? "missing" : "failed"} />
                <div className="who">{i === 0 ? c.label : ""}</div>
                <div className="what">
                  {c.summary}
                  {c.detail && <small>{c.detail}</small>}
                  {c.helpUrl && c.status !== "ok" && (
                    <small>
                      <a className="helplink" href={c.helpUrl} target="_blank" rel="noreferrer">
                        {c.status === "warn" ? "Create a read-only key" : "Get one"} <ArrowRight size={11} style={{ verticalAlign: -1 }} />
                      </a>
                    </small>
                  )}
                </div>
                <div className="when">{timeS(c.at)}</div>
              </div>
            )),
          )}
        </div>
      </section>

      {run && (
        <section className="card">
          <div className="card-h">
            <h3>
              <Radar size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
              {wider ? `Wider pass · ${days} days` : "First radar pass"}
            </h3>
            <span className="sub">{startedLine(run)}</span>
          </div>
          <div className="card-b">
            <RunTimeline run={run} />
          </div>
        </section>
      )}

      {first && (
        <div className="fade-in">
          <div className="banner-first">
            <SearchCheck size={22} />
            <div>
              <b>First finding, {sinceInit !== null ? `${dur(sinceInit)} after you ran init` : "just now"}</b>
              <p>
                {runFindings.length > 1 ? `${runFindings.length} findings so far. ` : ""}
                {done ? "The pass is complete." : "The pass keeps going in the background; more land in Findings as they pass."}
              </p>
            </div>
            <button className="btn" style={{ marginLeft: "auto" }} onClick={() => s.go("findings")}>
              Open the feed <ArrowRight size={14} />
            </button>
          </div>
          <FindingCard f={first} onChanged={s.refresh} />
        </div>
      )}

      {done && !first && (
        <section className="card empty">
          <SearchCheck size={28} color="var(--ok)" />
          <h3>No clear problems in the last {days} days</h3>
          <p>{run.emptyReason}</p>
          {run.lookbackHours < 720 && (
            <button className="btn primary" style={{ marginTop: 18 }} onClick={widen} disabled={widening}>
              <History size={14} /> Look back 30 days
            </button>
          )}
        </section>
      )}
    </div>
  );
}
