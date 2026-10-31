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
  return r.trigger === "onboarding" ? `First pass (${span})` : r.trigger === "schedule" ? `Daily ${span} pass` : `${span.charAt(0).toUpperCase()}${span.slice(1)} pass`;
}

export function Runs({ s }: { s: AppState }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [queued, setQueued] = useState<any[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
  // Which pipeline the list shows ("" = all) and which one "Run now" starts.
  const [filter, setFilter] = useState<string>(() => new URLSearchParams(location.search).get("pipeline") ?? "");
  const [target, setTarget] = useState<string>("");
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    void get("/api/pipelines").then((r) => {
      setPipelines(r.config.map((p: any) => ({ id: p.id, name: p.name })));
      setTarget((t) => t || filter || r.config[0]?.id || "");
    });
  }, []);
  useEffect(() => {
    void get(`/api/runs${filter ? `?pipeline=${encodeURIComponent(filter)}` : ""}`).then((r) => {
      setRuns(r.runs);
      setQueued(r.queued ?? []);
      const fromPath = location.pathname.split("/")[2];
      setSel((x) => (x && r.runs.some((y: any) => y.id === x) ? x : (r.runs.some((y: any) => y.id === fromPath) ? fromPath : r.runs[0]?.id) ?? null));
    });
  }, [s.run?.phase, s.run?.findings, filter, flash]);
  const nameOf = (id: string) => pipelines.find((p) => p.id === id)?.name ?? id;
  const runNow = async () => {
    const r = await post("/api/runs", { trigger: "run_now", pipelineId: target });
    setFlash(r.queued ? `${nameOf(target)}: queued (position ${r.position}); one pass runs at a time.` : `${nameOf(target)}: pass started.`);
    s.refresh();
  };
  const run = s.run && s.run.id === sel ? s.run : runs.find((r) => r.id === sel);
  const nonFloor = run?.dropped?.filter((d: any) => d.stage !== "floor" && d.stage !== "rank") ?? [];
  const floor = run?.dropped?.filter((d: any) => d.stage === "floor" || d.stage === "rank") ?? [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="h1">Runs</h1>
          <p className="lede">Every pass of every pipeline, every phase, and every draft that was dropped with its reason. Nothing is silently discarded. One pass runs at a time; the others queue.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select data-run-target aria-label="Pipeline to run" className="input" value={target} onChange={(e) => setTarget(e.target.value)} style={{ minWidth: 180 }}>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button className="btn" data-run-now onClick={() => void runNow()} disabled={!target}>
            <Play size={14} /> Run now
          </button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "0 0 12px" }} data-run-filter>
        {[{ id: "", name: "All pipelines" }, ...pipelines].map((p) => (
          <button key={p.id || "all"} className={`chip${filter === p.id ? " on" : ""}`} aria-pressed={filter === p.id} data-filter-pipeline={p.id || "all"} onClick={() => setFilter(p.id)}>
            {p.name}
          </button>
        ))}
        {queued.length > 0 && <span className="sub" data-queued>Queued: {queued.map((q: any) => nameOf(q.pipelineId)).join(", ")}</span>}
        {flash && <span className="sub" data-run-flash>{flash}</span>}
      </div>
      <div className="runs">
        <div className="card runlist">
          {runs.map((r) => (
            <button key={r.id} aria-current={r.id === sel} onClick={() => setSel(r.id)}>
              <div className="rl-t">
                <span className="pipetag" data-run-pipeline={r.pipelineId}>{r.pipelineName ?? nameOf(r.pipelineId)}</span> {passLabel(r)}
              </div>
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
