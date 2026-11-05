import { runAgents } from "./run-story";

/** Maps real engine activity to the original live flow. No sample work is inserted. */
export function workspaceLive(data: any, pipelines: any[], project: string, offline = false) {
  const ids = new Set(pipelines.map((p) => p.id));
  const names = new Set(data.workspace.projects.filter((p: any) => project === "all" || p.id === project).flatMap((p: any) => p.repos.map((r: any) => r.name)));
  const scoped = (x: any) => project === "all" || ids.has(x.pipelineId) || names.has(x.finding?.repo);
  const link = (page: string, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({ ...(project === "all" ? {} : { project }), ...extra });
    return `/${page}${query.size ? `?${query}` : ""}`;
  };
  const stages = [
    { key: "validate", label: "To validate", owner: "you", hint: "Findings awaiting your go-ahead.", href: link("review", { tab: "validate" }), linkLabel: "Review validation" },
    { key: "queued", label: "Queued", owner: "pipeline", hint: "Investigations waiting for the engine.", href: "#live-activity", linkLabel: "See activity" },
    { key: "building", label: "Investigating", owner: "pipeline", hint: "Reading signals and tracing their cause.", href: "#live-activity", linkLabel: "See agent steps" },
    { key: "merge", label: "Verifying", owner: "pipeline", hint: "Checking evidence and challenging findings.", href: "#live-activity", linkLabel: "See verification" },
    { key: "decide", label: "Needs decision", owner: "you", hint: "Prepared findings and guideline proposals.", href: link("review", { tab: "decide" }), linkLabel: "Open review" },
    { key: "manual", label: "Blocked", owner: "you", hint: "Access, capacity, or a run needs attention.", href: "#live-activity", linkLabel: "Inspect blockers" },
    { key: "shipped", label: "Accepted", owner: "done", hint: "Findings accepted and guidelines applied in the last 7 days.", href: link("review", { tab: "shipped" }), linkLabel: "Review accepted" },
  ];
  const runs = data.runs.filter(scoped);
  const queued = (data.pipelines.queued || []).filter((q: any) => project === "all" || ids.has(q.pipelineId));
  const tickets: any[] = [];
  for (const c of data.cockpit.cards.filter(scoped)) {
    const f = c.finding;
    if (!f || c.ruling?.ruling === "dismiss") continue;
    const ruling = c.ruling?.ruling;
    const validation = ["pending", "later"].includes(f.validation?.state);
    const stage = ruling === "file" ? "shipped" : validation ? "validate" : "decide";
    const parked = ruling === "park" || f.validation?.state === "later";
    tickets.push({ key: `F-${f.id}`, title: c.title, live_stage: stage, live_href: link("review", { finding: f.id }),
      live_state: { turn: ruling === "file" ? "done" : parked ? "parked" : "you", status: ruling === "file" ? "You accepted this finding." : parked ? "Set aside for later review." : validation ? "Waiting for your validation." : "Evidence prepared. Waiting for your decision." },
      jira_created: f.createdAt, createdAt: f.createdAt, merged_at: ruling === "file" ? c.ruling.at : null });
  }
  for (const p of (data.cockpit.proposals || []).filter(scoped)) {
    if (!["pending", "parked", "applied"].includes(p.status)) continue;
    const applied = p.status === "applied";
    tickets.push({ key: `G-${p.id}`, title: p.title, live_stage: applied ? "shipped" : "decide",
      live_href: link("review", { tab: applied ? "shipped" : "decide", proposal: p.id, pipeline: p.pipelineId }),
      live_state: { turn: applied ? "done" : p.status === "parked" ? "parked" : "you", status: applied ? "Guideline improvement applied." : "Review the proposed guideline change." },
      createdAt: p.createdAt, jira_created: p.createdAt, merged_at: applied ? p.rulings?.at(-1)?.at : null });
  }
  const active = runs.filter((r: any) => !["done", "failed"].includes(r.phase));
  const blocked: { id: string; name: string; detail: string; href: string; kind: string }[] = [];
  for (const r of active) {
    const step = r.steps?.find((s: any) => s.status === "running");
    const verifying = step && ["gate", "adversarial", "dedupe"].includes(step.step);
    const parked = r.phase === "parked";
    tickets.push({ key: `RUN-${r.id}`, title: r.pipelineName || r.pipelineId, live_stage: parked ? "manual" : verifying ? "merge" : "building",
      live_href: `#run-${r.id}`, live_state: { turn: parked ? "parked" : "pipeline", status: parked ? `Waiting for capacity${r.parkedUntil ? ` until ${new Date(r.parkedUntil).toLocaleString()}` : ""}.` : step ? `${step.step.replaceAll("_", " ")}: ${step.clusterTitle}` : r.phase.replaceAll("_", " ") },
      createdAt: r.startedAt, jira_created: r.startedAt });
  }
  for (const q of queued) tickets.push({ key: `QUEUE-${q.pipelineId}`, title: pipelines.find((p) => p.id === q.pipelineId)?.name || q.pipelineId,
    live_stage: "queued", live_href: "#live-activity", live_state: { turn: "pipeline", status: "Queued behind the current investigation." }, createdAt: q.at, jira_created: q.at });
  for (const p of pipelines) {
    if (active.some((r: any) => r.pipelineId === p.id) || queued.some((q: any) => q.pipelineId === p.id)) continue;
    const last = runs.find((r: any) => r.pipelineId === p.id);
    const unavailable = data.workspace.projects.flatMap((x: any) => x.repos).filter((r: any) => (!p.repos || p.repos.includes(r.name)) && !r.available);
    const missingSources = p.sources.filter((id: string) => id !== "repos" && id !== "*" && !data.workspace.connections.some((c: any) => c.id === id && c.configured && c.probe?.ok));
    const detail = unavailable.length ? `Repository unavailable: ${unavailable.map((r: any) => r.name).join(", ")}` :
      !data.workspace.provider.authenticated ? data.workspace.provider.detail :
        missingSources.length ? `Read access needed: ${missingSources.join(", ")}` : last?.phase === "failed" ? last.error || "Last investigation failed. Inspect its steps." : "";
    if (!detail) continue;
    const kind = unavailable.length ? "Repository access" : !data.workspace.provider.authenticated ? "AI account" : missingSources.length ? "Source access" : "Failed run";
    const href = `#blocker-${p.id}`;
    blocked.push({ id: p.id, name: p.name, detail, href, kind });
    tickets.push({ key: `BLOCKER-${p.id}`, displayKey: kind, title: `${p.name} · ${kind}`, live_stage: "manual", live_href: href, live_state: { turn: "you", status: detail } });
  }
  const recorded = [...runs.map((r: any) => r.startedAt), ...tickets.map((t) => t.createdAt)].filter(Boolean).sort();
  return { tickets, stages, read_at: new Date().toISOString(), historyStart: recorded[0] || null, sync: null, reviewHref: link("review", { tab: "decide" }), offline,
    // A step's model is only known once its call returns, so a running step counts as an active agent on its own.
    runs, queued, active, blocked, agents: active.flatMap(runAgents),
    cost: runs.reduce((sum: number, r: any) => sum + (r.costUsd || 0), 0),
    settingsHref: link("pipelines"), projectsHref: link("projects") };
}
