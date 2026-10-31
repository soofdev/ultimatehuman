import { useEffect, useRef, useState } from "react";
import { ArrowRight, CircleDashed, History, Radar, SearchCheck } from "lucide-react";
import { get, post } from "../api";
import type { AppState } from "../App";
import { Ico, RunTimeline, startedLine } from "../Timeline";
import { FindingCard } from "../FindingCard";
import { timeS, dur } from "../fmt";

const ORDER = ["claude", "code", "posthog", "sentry", "datadog", "github", "telegram"];
const TIER: Record<string, string> = { bronze: "Bronze", silver: "Silver", gold: "Gold", platinum: "Platinum" };

/** Setup grade + the pending ledger (what init skipped and why it matters). Re-read every 15 s: the engine clears items as they get done. */
function GradeCard() {
  const [g, setG] = useState<any>(null);
  useEffect(() => {
    const load = () => void get("/api/setup-grade").then(setG).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  if (!g) return null;
  const pending: any[] = g.pending ?? [];
  return (
    <section className="card" data-setup-grade={g.tier ?? "none"}>
      <div className="card-h">
        <h3>
          Setup grade <span className={`tier-pill tier-${g.tier ?? "none"}`} data-grade-tier>{g.tier ? TIER[g.tier] : "Not set up"}</span>
        </h3>
        <span className="sub">{g.next ? `next: ${TIER[g.next]}` : "top tier"} · everything is optional</span>
      </div>
      <div className="card-b">
        {g.next && g.unlocks.length > 0 && (
          <div className="unlocks" data-unlocks>
            <b>What unlocks {TIER[g.next]}</b>
            <ul>
              {g.unlocks.map((u: any) => (
                <li key={u.id}>
                  <span>{u.label}.</span> {u.hint}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="pending-h">
          <b>Pending</b> <span className="sub">{pending.length ? `${pending.length} skipped at install · cleared automatically when done · ask the Chat “what's missing?”` : "nothing skipped at install"}</span>
        </div>
        {pending.map((p) => (
          <div className="check" key={p.id} data-pending={p.id}>
            <CircleDashed size={16} color="var(--warn, #b45309)" style={{ marginTop: 2 }} />
            <div className="who">{p.tier ? TIER[p.tier] : ""}</div>
            <div className="what">
              {p.label}
              <small>{p.why}</small>
              <small>→ {p.unlock}</small>
            </div>
            <div className="when">{timeS(p.since)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Setup({ s, land }: { s: AppState; land: () => void }) {
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
  // Setup ends on the cockpit: when a pass finishes while you watch, it hands over after a short beat.
  const prevPhase = useRef(run?.phase);
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = run?.phase;
    if (was && was !== "done" && run?.phase === "done") {
      const t = setTimeout(land, 2500);
      return () => clearTimeout(t);
    }
  }, [run?.phase, land]);
  const widen = () => {
    setWidening(true);
    void post("/api/runs", { trigger: "run_now", lookbackHours: 720 }).then(() => s.refresh()).finally(() => setWidening(false));
  };

  return (
    <div className="stack">
      <div>
        <h1 className="h1">{first ? "Your first finding is in." : wider ? (done ? `${days}-day pass complete.` : `Looking back ${days} days.`) : done ? "First pass complete." : run ? "You're set up. The first pass is running." : "You're set up. The radar waits for a tracker."}</h1>
        <p className="lede">
          {first
            ? "Root-caused from your own PostHog data, checked by a gate and a second agent that tried to break it. Every claim links back to the data."
            : "Everything below was detected and checked live by init. Nothing is written anywhere: the radar only reads your trackers."}
        </p>
      </div>

      <GradeCard />

      <section className="card" data-pipeline-note>
        <div className="card-h">
          <h3>Where findings go</h3>
        </div>
        <div className="card-b">
          <p>
            New findings land on the Pipeline page as tickets under Needs decision: File to GitHub, Dismiss or Not now. Filed
            ones move to Shipped; dismissals and the drafts the radar dropped show there as cancelled. Fixes arrive in v2:
            until then Awaiting validation, Ready to merge and Manual stay empty, and Claims stays empty because no agent is
            connected.
          </p>
        </div>
      </section>

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
                {done ? "The pass is complete. Your cockpit is ready." : "The pass keeps going in the background; more land in your cockpit as they pass."}
              </p>
            </div>
            <button className="btn" style={{ marginLeft: "auto" }} onClick={land} data-action="open-cockpit">
              Rule on it in the cockpit <ArrowRight size={14} />
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
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 18 }}>
            {run.lookbackHours < 720 && (
              <button className="btn primary" onClick={widen} disabled={widening}>
                <History size={14} /> Look back 30 days
              </button>
            )}
            <button className="btn" onClick={land} data-action="open-cockpit">
              Open the cockpit <ArrowRight size={14} />
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
