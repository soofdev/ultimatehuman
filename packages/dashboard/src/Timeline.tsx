import { useEffect, useState } from "react";
import { Check, Loader2, PauseCircle, X, Minus } from "lucide-react";
import { dur, timeS, until, time, plural } from "./fmt";

export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const STEP_LABEL: Record<string, string> = { root_cause: "Root-cause", gate: "Gate", adversarial: "Review", dedupe: "Dedupe" };

export function Ico({ s }: { s: string }) {
  if (s === "done" || s === "passed" || s === "ok")
    return (
      <span className="ico ok">
        <Check size={13} strokeWidth={3} />
      </span>
    );
  if (s === "running")
    return (
      <span className="ico run">
        <Loader2 size={13} strokeWidth={2.6} className="spin" />
      </span>
    );
  if (s === "parked")
    return (
      <span className="ico warn">
        <PauseCircle size={14} strokeWidth={2.4} />
      </span>
    );
  if (s === "failed")
    return (
      <span className="ico fail">
        <X size={13} strokeWidth={3} />
      </span>
    );
  if (s === "missing")
    return (
      <span className="ico missing">
        <Minus size={13} strokeWidth={3} />
      </span>
    );
  return <span className="ico wait" />;
}

function span(a?: string, b?: string) {
  if (!a) return "";
  return dur((b ? Date.parse(b) : Date.now()) - Date.parse(a));
}

export function RunTimeline({ run }: { run: any }) {
  useTick();
  if (!run) return null;
  const ph = (name: string) => run.phases?.find((p: any) => p.phase === name);
  const collect = ph("collecting");
  const correlate = ph("correlating");
  const rc = ph("root_causing");
  const ready = ph("ready");
  const parked = run.phase === "parked";
  const clusters: any[] = run.clusters ?? [];
  const byCluster = (id: string) => (run.steps ?? []).filter((s: any) => s.clusterId === id);
  const rcStatus = parked ? "parked" : rc?.status ?? "wait";
  const processed = clusters.filter((c) => byCluster(c.id).some((s: any) => ["dropped", "failed"].includes(s.status) || (s.step === "dedupe" && s.status === "passed"))).length;

  return (
    <ol className="tl">
      <li className={collect?.status === "done" ? "done" : ""}>
        <Ico s={collect?.status ?? "wait"} />
        <div>
          <div className="t-title">Collect signals</div>
          <div className="t-note">{collect?.note ?? `Reading the last ${run.lookbackHours} h from your sources`}</div>
          {collect?.status === "done" && run.sources?.length > 0 && (
            <div className="t-note">{run.sources.map((s: any) => `${s.pluginId}: ${s.ok ? plural(s.signals, "signal") : `failed (${s.note})`}`).join(" · ")}</div>
          )}
        </div>
        <div className="t-time">{span(collect?.startedAt, collect?.endedAt)}</div>
      </li>
      <li className={correlate?.status === "done" ? "done" : ""}>
        <Ico s={correlate?.status ?? "wait"} />
        <div>
          <div className="t-title">Correlate</div>
          <div className="t-note">{correlate?.note ?? "Group signals that share a page, an error or the same people"}</div>
        </div>
        <div className="t-time">{span(correlate?.startedAt, correlate?.endedAt)}</div>
      </li>
      <li className={rc?.status === "done" ? "done" : ""}>
        <Ico s={rcStatus} />
        <div>
          <div className="t-title">Root-cause, gate and adversarial review</div>
          <div className="t-note">
            {parked
              ? `Parked to protect your reserve. Resumes at ${time(run.parkedUntil)} (${until(run.parkedUntil)}), no process left running.`
              : rc
                ? `${processed} of ${clusters.length} clusters done · ${plural(run.findings, "finding")} passed so far`
                : "One agent step per cluster, then a deterministic gate and a second agent that tries to break the draft"}
          </div>
          {clusters.length > 0 && rc && (
            <div className="substeps">
              {clusters.map((c) => {
                const steps = byCluster(c.id);
                return (
                  <div className="substep" key={c.id}>
                    <span className="nm" title={c.title}>
                      {c.title} <span style={{ color: "var(--ink-4)" }}>· {plural(c.usersAffected, "user")}</span>
                    </span>
                    <span className="pills">
                      {["root_cause", "gate", "adversarial", "dedupe"].map((k) => {
                        const s = steps.find((x: any) => x.step === k);
                        if (!s) return null;
                        return (
                          <span key={k} className={`pill ${s.status}`} title={s.note ?? ""}>
                            {s.status === "running" && <Loader2 size={11} className="spin" />}
                            {STEP_LABEL[k]}
                            {s.status === "running" ? ` ${span(s.startedAt)}` : s.status === "dropped" ? " · dropped" : s.status === "parked" ? " · parked" : ""}
                          </span>
                        );
                      })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="t-time">{span(rc?.startedAt, rc?.endedAt)}</div>
      </li>
      <li>
        <Ico s={run.phase === "done" ? "done" : run.phase === "failed" ? "failed" : "wait"} />
        <div>
          <div className="t-title">Ready</div>
          <div className="t-note">
            {run.phase === "failed" ? `Failed: ${run.error}` : ready?.note ?? "Findings land in your feed as soon as each one passes"}
          </div>
        </div>
        <div className="t-time">{run.finishedAt ? `total ${span(run.startedAt, run.finishedAt)}` : ""}</div>
      </li>
    </ol>
  );
}

export function startedLine(run: any) {
  return `Started ${timeS(run.startedAt)} · looking back ${run.lookbackHours >= 48 ? `${run.lookbackHours / 24} days` : `${run.lookbackHours} h`}`;
}
