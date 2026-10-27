import { useEffect, useState } from "react";
import { Play, Info } from "lucide-react";
import type { AppState } from "../App";
import { get, post } from "../api";
import { RunTimeline, startedLine } from "../Timeline";
import { dayTime, plural } from "../fmt";

const STAGE: Record<string, string> = { floor: "User floor", rank: "Rank cap", root_cause: "Root-cause", gate: "Gate", adversarial: "Review", dedupe: "Dedupe" };
const OUTCOME: Record<string, string> = {
  suppressed: "Suppressed",
  parked: "Stays parked",
  resurfaced: "Resurfaced",
  escalated: "Escalated",
  already_filed: "Filed",
  recurred_after_filing: "Recurred",
  awaiting_ruling: "In your feed",
};

function passLabel(r: any): string {
  const span = r.lookbackHours % 24 === 0 ? `${r.lookbackHours / 24}-day` : `${r.lookbackHours}-hour`;
  return r.trigger === "onboarding" ? `First pass (${span})` : r.trigger === "schedule" ? `Daily ${span} pass` : `${span[0].toUpperCase()}${span.slice(1)} pass`;
}

export function Runs({ s }: { s: AppState }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    void get("/api/runs").then((r) => {
      setRuns(r.runs);
      const fromPath = location.pathname.split("/")[2];
      setSel((x) => x ?? (r.runs.some((y: any) => y.id === fromPath) ? fromPath : r.runs[0]?.id) ?? null);
    });
  }, [s.run?.phase, s.run?.findings]);
  const run = s.run && s.run.id === sel ? s.run : runs.find((r) => r.id === sel);
  const nonFloor = run?.dropped?.filter((d: any) => d.stage !== "floor" && d.stage !== "rank") ?? [];
  const floor = run?.dropped?.filter((d: any) => d.stage === "floor" || d.stage === "rank") ?? [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="h1">Runs</h1>
          <p className="lede">Every pass, every phase, and every draft that was dropped with its reason. Nothing is silently discarded.</p>
        </div>
        <button className="btn" onClick={() => void post("/api/runs", { trigger: "run_now", lookbackHours: run?.lookbackHours }).then(() => s.refresh())} disabled={s.run && !["done", "failed"].includes(s.run.phase)}>
          <Play size={14} /> Run {run ? (run.lookbackHours % 24 === 0 ? `a ${run.lookbackHours / 24}-day` : `a ${run.lookbackHours}-hour`) : "a"} pass
        </button>
      </div>
      <div className="runs">
        <div className="card runlist">
          {runs.map((r) => (
            <button key={r.id} aria-current={r.id === sel} onClick={() => setSel(r.id)}>
              <div className="rl-t">{passLabel(r)}</div>
              <div className="rl-s">
                {dayTime(r.startedAt)} · {r.phase === "done" ? plural(r.findings, "finding") : r.phase}
              </div>
            </button>
          ))}
        </div>
        {run && (
          <div className="stack">
            <section className="card">
              <div className="card-h">
                <h3>Phase timeline</h3>
                <span className="sub">{startedLine(run)}</span>
              </div>
              <div className="card-b">
                <RunTimeline run={run} />
              </div>
            </section>
            {run.ruled?.length > 0 && (
              <section className="card" data-section="rulings-applied">
                <div className="card-h">
                  <h3>Your rulings, applied</h3>
                  <span className="sub">{plural(run.ruled.length, "cluster")} settled before any agent ran</span>
                </div>
                <div className="card-b">
                  {run.ruled.map((d: any) => (
                    <div className="drop-row" key={d.clusterId}>
                      <span className={`stagetag out-${d.outcome}`}>{OUTCOME[d.outcome] ?? d.outcome}</span>
                      <div>
                        <div style={{ fontWeight: 560 }}>{d.clusterTitle}</div>
                        <div className="why">{d.note}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <section className="card">
              <div className="card-h">
                <h3>Dropped drafts</h3>
                <span className="sub">{plural(nonFloor.length, "draft")} root-caused and dropped · {floor.length} clusters filtered before any agent ran</span>
              </div>
              <div className="card-b">
                {[...nonFloor, ...floor].map((d: any, i: number) => (
                  <div className="drop-row" key={i}>
                    <span className="stagetag">{STAGE[d.stage] ?? d.stage}</span>
                    <div>
                      <div style={{ fontWeight: 560 }}>{d.title ?? d.clusterTitle}</div>
                      <div className="why">{d.reason}</div>
                    </div>
                  </div>
                ))}
                {!run.dropped?.length && <p className="note">Nothing dropped.</p>}
              </div>
            </section>
            <section className="card">
              <div className="card-h">
                <h3>Run detail</h3>
                <span className="sub mono">{run.id}</span>
              </div>
              <div className="card-b" style={{ padding: "14px 20px" }}>
                {run.notes?.map((n: string) => (
                  <p className="note" key={n} style={{ margin: "0 0 8px" }}>
                    <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} /> {n}
                  </p>
                ))}
                <p className="note" style={{ margin: 0 }}>
                  <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} /> {(run.steps ?? []).some((x: any) => x.model) ? `Agent steps: ${(run.steps ?? []).filter((x: any) => x.model).length} on Claude ${run.steps.find((x: any) => x.model).model}.` : "No agent step ran in this pass."} Notional API-equivalent cost reported by the CLI: ${run.costUsd?.toFixed(2)} (billed to your subscription, not charged).
                </p>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
