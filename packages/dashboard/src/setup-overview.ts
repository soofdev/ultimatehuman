/** Derive setup from saved configuration, discovery, and real runs. No setup score or simulated activity. */
export const chatLink = (message: string) => `/chat?message=${encodeURIComponent(message)}`;

export function setupOverview(data: any, projectId: string) {
  const projects = data.workspace.projects;
  const project = projects.find((p: any) => p.id === projectId) ?? projects[0];
  const repos: any[] = project?.repos ?? [];
  const names = repos.map((r) => r.name);
  const pipelines: any[] = project ? data.pipelines.config.filter((p: any) => !p.repos || p.repos.some((r: string) => names.includes(r))) : [];
  const sources: any[] = data.workspace.connections.filter((s: any) => s.supported);
  const connected = (s: any) => s.configured && s.probe?.ok === true;
  const detected = (s: any) => repos.some((r) => r.trackers.some((t: any) => t.provider === s.id));
  const tracked = sources.filter(detected);
  const available = sources.filter(connected);
  const repositoriesReady = repos.length > 0 && repos.every((r) => r.available);
  const accountReady = data.workspace.provider.authenticated === true;
  const hasSources = (p: any) => p.sources.some((id: string) => id === "repos" ? repositoriesReady : id === "*" ? available.length > 0 : available.some((s) => s.id === id));
  const missingSources = (p: any) => p.sources.some((id: string) => id !== "repos" && id !== "*" && !available.some((s) => s.id === id));
  const ready = (p: any) => repositoriesReady && accountReady && hasSources(p) && !missingSources(p);
  const pipelineReady = pipelines.some(ready);
  const runs: any[] = data.runs.filter((r: any) => pipelines.some((p) => p.id === r.pipelineId));
  const active = runs.find((r) => !["done", "failed"].includes(r.phase));
  const queued = (data.pipelines.queued ?? []).some((q: any) => pipelines.some((p) => p.id === q.pipelineId));
  // A pass with no readable source can end without crashing; it is not a successful first investigation.
  const completed = runs.find((r) => r.phase === "done" && !r.error && r.sources?.some((s: any) => s.ok));
  const liveHref = `/pipeline-live${project ? `?project=${encodeURIComponent(project.id)}` : ""}`;
  const scope = project ? ` for project ${JSON.stringify(project.id)}` : "";
  const ask = (message: string) => chatLink(message + scope + ".");
  const bug = pipelines.find((p) => p.template === "bug-radar");
  const preferredSource = sources.find((s) => bug?.sources.includes(s.id) && !connected(s)) ?? tracked.find(connected) ?? tracked[0] ?? available[0];
  let next = { title: "Connect your first project", detail: "Tell Claude which repositories belong to it.", label: "Choose repositories", href: ask("Help me connect my repositories") };
  if (project) {
    if (!repositoriesReady) next = { title: "Reconnect a repository", detail: "One of this project’s checkouts is unavailable.", label: "Resolve in chat", href: ask("Help me restore access to the unavailable repository") };
    else if (!accountReady) next = { title: "Check the Claude connection", detail: "Use the account already installed on this machine.", label: "Check in chat", href: ask("Check my existing Claude Code account connection") };
    else if (active || queued) next = { title: active?.phase === "parked" ? "Investigation is waiting" : queued ? "Investigation is queued" : "Your pipeline is running", detail: "Follow the investigation and its evidence as it progresses.", label: "Open Pipeline live", href: liveHref };
    else if ((bug && !ready(bug)) || (!pipelineReady && preferredSource && !connected(preferredSource))) next = { title: preferredSource ? `Connect ${preferredSource.name}` : "Connect an error source", detail: "Give Bug radar access to real errors for its next run.", label: "Continue in chat", href: ask(preferredSource ? `Connect ${preferredSource.name} and run the existing Bug radar, or set up the original Bug radar if none exists` : "Help me connect a tracking source and run Bug radar") };
    else if (completed) next = { title: "Your first investigation is complete", detail: completed.findings ? `The completed run produced ${completed.findings} finding${completed.findings === 1 ? "" : "s"}.` : "The run completed without a supported finding. You can inspect its coverage.", label: completed.findings ? "Open Review" : "View run", href: completed.findings ? `/review?tab=decide&pipeline=${encodeURIComponent(completed.pipelineId)}` : liveHref };
    else if (pipelineReady) {
      const p = pipelines.find(ready)!;
      next = { title: `Run ${p.name}`, detail: "Check the evidence, then send supported findings to Review.", label: "Start in chat", href: ask(`Run the existing pipeline ${JSON.stringify(p.id)} now, keeping its saved settings`) };
    } else next = { title: preferredSource ? "Set up Bug radar" : "Start with a Security check", detail: preferredSource ? "Use your connected source to investigate real user problems." : "Review your code now. Add production tracking when you’re ready.", label: "Set up in chat", href: ask(preferredSource ? "Set up and run the original Bug radar using my connected source" : "Set up and run the original Security check on my repositories") };
  }
  const steps = [
    { id: "repos", label: "Repositories", done: repositoriesReady, detail: !repos.length ? "Not connected" : repositoriesReady ? `${repos.length} connected` : "Access needed" },
    { id: "account", label: "Claude Code", done: accountReady, detail: accountReady ? "Account connected" : "Check connection" },
    { id: "pipeline", label: "Pipeline", done: pipelineReady, detail: pipelineReady ? "Ready to run" : pipelines.length ? "Connection needed" : "Not set up" },
    { id: "run", label: "First run", done: !!completed, detail: completed ? "Completed" : active?.phase === "parked" ? "Waiting for capacity" : active ? "Running" : queued ? "Queued" : runs[0]?.phase === "failed" ? "Needs attention" : "Not started" },
  ];
  const suggestions = data.pipelines.templates.map((template: any) => {
    const existing = pipelines.filter((p) => p.template === template.id);
    const code = template.id === "security-check";
    const templateReady = repositoriesReady && accountReady && (code || available.length > 0);
    const existingReady = existing.some(ready);
    const recommended = tracked.length || available.length ? !code : code;
    return { ...template, existing, recommended, ready: existing.length ? existingReady : templateReady,
      status: existing.length ? existingReady ? existing.every((p) => !p.enabled) ? "Paused" : "Configured" : "Connection needed" : templateReady ? "Ready to add" : !repositoriesReady ? "Needs repositories" : !accountReady ? "Needs Claude" : "Needs tracking",
      description: code ? "Find exposed secrets, risky dependencies, and gaps in authentication." : "Trace production errors and failed interactions back to the code.",
      href: ask(existing.length ? `Check the setup of the existing ${template.name} pipeline${existing.length === 1 ? " " + JSON.stringify(existing[0].id) : "s"} and help me run it, preserving its saved settings` : `Help me set up ${template.name} using the original template defaults, then run it`),
    };
  }).sort((a: any, b: any) => Number(b.recommended) - Number(a.recommended));
  return { project, repos, pipelines, sources, tracked, available, connected, detected, steps, next, suggestions, liveHref, ask, completed };
}
