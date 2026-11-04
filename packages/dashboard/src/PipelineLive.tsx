import { useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, Clock3, Loader2, Settings2 } from "lucide-react";
import LiveClient from "../app/(app)/administration/pipeline-live/LiveClient";
import { workspaceLive } from "./workspace-live";
import "./pipeline-live.css";
import { Modal } from "./WorkspaceModal";

const human = (s: string) => s?.replaceAll("_", " ") || "";
const when = (s?: string) => s ? new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

export default function PipelineLive({ data, pipelines, project, offline, act, chatFirst = false }: any) {
  const snapshot = useMemo(() => {
    const value = workspaceLive(data, pipelines, project, offline);
    return chatFirst ? { ...value, settingsHref: "/chat?message=Show%20my%20pipelines", projectsHref: "/chat?message=Help%20me%20run%20a%20pipeline" } : value;
  }, [data, pipelines, project, offline, chatFirst]);
  const [blockerId, setBlockerId] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const blocker = snapshot.blocked.find((b) => b.id === blockerId);
  const provider = data.workspace.provider;
  const activity = (
    <section id="live-activity" className="uh-live-activity">
      <div className="uh-section-heading"><div><h2>Engine activity</h2></div>{!chatFirst && <a className="uh-btn" href="/runs">Full run history</a>}<a className="uh-btn" href={snapshot.settingsHref}><Settings2 size={15} />{chatFirst ? "Manage in chat" : "Manage pipelines"}</a></div>
      {snapshot.blocked.map((b) => <a className="uh-live-blocker" href={b.href} key={b.id}><span className="uh-dot warn" /><div><strong>{b.name}</strong><p>{b.detail}</p></div><ArrowUpRight size={17} /></a>)}
      {snapshot.queued.map((q: any, index: number) => <div className="uh-live-queued" key={q.pipelineId}><Clock3 size={16} /><span>#{index + 1} in queue</span><strong>{pipelines.find((p: any) => p.id === q.pipelineId)?.name || q.pipelineId}</strong><span>{when(q.at)}</span></div>)}
      {!snapshot.runs.length && <div className="uh-live-empty"><Activity size={22} /><h3>No runs yet</h3><p>{snapshot.blocked.length ? "Resolve the blocker above to run the pipeline." : "Start a pipeline to see its progress here."}</p><a className="uh-link" href={snapshot.projectsHref}>{chatFirst ? "Open chat" : "Open projects"} <ArrowUpRight size={13} /></a></div>}
      {snapshot.runs.slice(0, 12).map((run: any) => {
        const active = !["done", "failed"].includes(run.phase);
        const steps = run.steps || [];
        return <details className="uh-live-run" key={run.id} id={`run-${run.id}`} open={active || undefined}>
          <summary>{run.phase === "failed" ? <AlertTriangle size={18} /> : run.phase === "parked" ? <Clock3 size={18} /> : active ? <Loader2 size={18} className="uh-spin" /> : <CheckCircle2 size={18} />}<div><strong>{run.pipelineName || run.pipelineId}</strong><span>{human(run.phase)} · {when(run.startedAt)}</span></div><span>{run.signalsCollected ?? 0} signals</span><span>{run.findings ?? 0} findings</span><span>${(run.costUsd || 0).toFixed(3)}</span><ChevronDown size={16} /></summary>
          <div className="uh-live-run-body">
            <div className="uh-live-phases">{(run.phases || []).map((p: any, i: number) => <div key={i} data-state={p.status}><span className={`uh-dot ${p.status === "failed" ? "warn" : ""}`} /><strong>{human(p.phase)}</strong><span>{p.status}</span></div>)}</div>
            {steps.length > 0 && <div className="uh-live-steps">{steps.map((s: any, i: number) => <div key={i}><span className={`uh-live-step-state ${s.status}`}>{human(s.status)}</span><div><strong>{human(s.step)} · {s.clusterTitle || "Investigation"}</strong>{s.note && <p>{s.note}</p>}<small>{s.model || "Evidence check"}{s.startedAt ? ` · ${when(s.startedAt)}` : ""}</small></div>{s.costUsd != null && <span>${s.costUsd.toFixed(3)}</span>}</div>)}</div>}
            {(run.sources || []).map((s: any) => <p className="uh-live-source" key={s.pluginId}><strong>{s.pluginId}</strong> · {s.signals} signals · {s.ok ? "Read completed" : "Needs attention"}{s.note ? ` · ${s.note}` : ""}</p>)}
            {(run.error || run.emptyReason) && <p className="uh-live-run-note">{run.error || run.emptyReason}</p>}
            {(run.notes || []).map((n: string, i: number) => <p className="uh-live-run-note" key={i}>{n}</p>)}
            <small className="uh-muted">Run {run.id} · {run.repos?.map((r: any) => `${r.name} @ ${r.commit?.slice(0, 7) || "local checkout"}`).join(", ")}</small>
          </div>
        </details>;
      })}
    </section>
  );
  return <div className="uh-live-surface" onClick={(event) => {
    const href = (event.target as Element).closest("a")?.getAttribute("href");
    if (href?.startsWith("#blocker-")) {
      event.preventDefault();
      setBlockerId(href.slice("#blocker-".length));
      setError("");
    }
    if (href?.startsWith("#run-")) {
      const detail = document.getElementById(href.slice(1));
      if (detail instanceof HTMLDetailsElement) detail.open = true;
    }
  }}>
    <LiveClient initial={snapshot} snapshot={snapshot} workspace activity={activity}>
      <div className="uh-live-system">
        <div><span>Engine</span><strong><span className={`uh-dot ${offline ? "warn" : ""}`} />{offline ? "Reconnecting" : "Online"}</strong></div>
        <div><span>Configured pipelines</span><strong>{pipelines.length}<small>{pipelines.filter((p: any) => p.enabled && p.schedule !== "manual").length} scheduled</small></strong></div>
        <div><span>Active agents</span><strong>{snapshot.agents.length}<small>{snapshot.agents.map((s: any) => human(s.step)).join(", ") || "No model call running"}</small></strong></div>
        <div><span>Recent run cost</span><strong>${snapshot.cost.toFixed(3)}<small>{snapshot.runs.length} recorded runs · {data.workspace.reserve}% reserve</small></strong></div>
      </div>
    </LiveClient>
    {blockerId && <Modal title={blocker ? `${blocker.kind} · ${blocker.name}` : "Access verified"} close={() => setBlockerId("")}>
      <div className="uh-live-blocker-detail">
        <p>{blocker?.detail || "The account check succeeded. Your pipeline is ready to run with its saved settings."}</p>
        {blocker?.kind === "Claude account" && <>
          <dl><dt>Claude Code</dt><dd>{provider.available ? "Installed" : "Not found"}{provider.cliVersion ? ` · ${provider.cliVersion}` : ""}</dd><dt>Account source</dt><dd>{provider.authMethod || "Local Claude login"}</dd>{provider.configDirectory && <><dt>Claude configuration</dt><dd><code>{provider.configDirectory}</code></dd></>}{provider.verifiedAt && <><dt>Last live check</dt><dd>{when(provider.verifiedAt)}</dd></>}</dl>

          {provider.command && <div className="uh-activation-command"><code>{provider.command}</code><button className="uh-btn" onClick={() => navigator.clipboard.writeText(provider.command).catch(() => setError("Copy the command into your terminal."))}>Copy command</button></div>}
        </>}
        {error && <p role="alert" className="uh-error">{error}</p>}
        <div className="uh-modal-actions">
          <button className="uh-btn" onClick={() => setBlockerId("")}>Close</button>
          {blocker?.kind === "Claude account" ? <button className="uh-btn primary" disabled={checking} onClick={async () => {
            setChecking(true); setError("");
            try { await act("/api/workspace/provider/check", {}); } catch (e) { setError((e as Error).message); } finally { setChecking(false); }
          }}>{checking ? "Checking Claude access…" : "Check Claude access"}</button> : blocker?.kind === "Source access" ? <a className="uh-btn primary" href={chatFirst ? "/chat" : "/settings?tab=connections"}>Manage source connection</a> : blocker?.kind === "Failed run" ? <a className="uh-btn primary" onClick={() => setBlockerId("")} href={`#run-${snapshot.runs.find((r: any) => r.pipelineId === blocker.id)?.id}`}>Inspect run</a> : null}
        </div>
      </div>
    </Modal>}
  </div>;
}
