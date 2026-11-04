import { Activity, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronRight, Circle, Code2, GitBranch, GitFork, Plus, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { setupOverview } from "../setup-overview";
import "../setup.css";

const tracking: Record<string, { description: string; docs: string; letter: string }> = {
  posthog: { description: "Product events, failed interactions, and user errors.", docs: "https://posthog.com/docs/libraries", letter: "P" },
  datadog: { description: "Backend error logs and service failures.", docs: "https://docs.datadoghq.com/logs/error_tracking/", letter: "D" },
};

export default function SetupPage({ data, project: projectId }: { data: any; project: string }) {
  const view = setupOverview(data, projectId);
  const { project, repos, pipelines, sources, steps, next, suggestions, ask } = view;
  const complete = steps.filter((s) => s.done).length;
  const firstIncomplete = steps.find((s) => !s.done)?.id;
  const unsupported = [...new Set(repos.flatMap((r) => r.trackers.map((t: any) => t.provider)))].filter((id) => !sources.some((s) => s.id === id));
  return <div className="setup-page">
    <div className="setup-heading"><div><span className="setup-eyebrow">PROJECT SETUP</span><h2>{project?.name || "Your first project"}</h2><p>What’s connected. What’s next.</p></div><a className="uh-btn" href={ask("Help me connect another repository")}><Plus size={14} />Add repository</a></div>

    <section className="setup-progress" aria-label="Setup progress">
      <div className="setup-progress-top"><span><CheckCheck size={16} />Setup progress</span><span>{complete} of {steps.length} complete</span></div>
      <ol>{steps.map((step, i) => <li key={step.id} className={step.done ? "is-done" : step.id === firstIncomplete ? "is-next" : ""} aria-current={!step.done && step.id === firstIncomplete ? "step" : undefined}>
        <span className="setup-step-marker">{step.done ? <Check size={14} /> : String(i + 1).padStart(2, "0")}</span><div><strong>{step.label}</strong><span>{step.detail}</span></div>
      </li>)}</ol>
    </section>

    <div className="setup-next" role="status"><div className="setup-next-icon"><ArrowRight size={20} /></div><div><span className="setup-eyebrow">{view.completed ? "FIRST RUN COMPLETE" : "NEXT STEP"}</span><h3>{next.title}</h3><p>{next.detail}</p></div><a className="uh-btn primary" href={next.href}>{next.label}<ArrowRight size={14} /></a></div>

    <div className="setup-columns">
      <div className="setup-primary">
        <section className="setup-section" aria-labelledby="setup-repositories">
          <div className="setup-section-heading"><h3 id="setup-repositories">Repositories <span>{repos.length}</span></h3><GitFork size={17} /></div>
          <div className="setup-repos">{repos.length ? repos.map((repo) => {
            const wired = pipelines.filter((p) => !p.repos || p.repos.includes(repo.name));
            const framework = repo.facts.filter((f: any) => f.kind === "application").map((f: any) => f.label).filter((n: string) => n !== "Node.js").join(" · ") || "Repository";
            return <div className="setup-repo" key={repo.name}><div className="setup-repo-icon"><Code2 size={18} /></div><div className="setup-repo-info"><div><strong>{repo.name}</strong><span className={`setup-label ${repo.available ? "positive" : "attention"}`}>{repo.available ? "Connected" : "Unavailable"}</span></div><p>{framework}{repo.branch && <><span>·</span><GitBranch size={11} />{repo.branch}</>}</p><details><summary>{wired.length ? `${wired.length} pipeline${wired.length === 1 ? "" : "s"}` : "No pipeline yet"}<ChevronRight size={11} /></summary><code>{repo.path}</code>{wired.length > 0 && <p>{wired.map((p) => p.name).join(" · ")}</p>}{repo.error && <p>{repo.error}</p>}</details></div></div>;
          }) : <div className="setup-empty"><GitFork size={24} /><p>Connect the frontend, backend, or any repos that make up your project.</p><a href={next.href}>Choose repositories in chat <ArrowRight size={13} /></a></div>}</div>
        </section>

        <section className="setup-section" aria-labelledby="setup-pipelines">
          <div className="setup-section-heading"><h3 id="setup-pipelines">Pipelines</h3><span>{view.completed ? "Add when useful" : "Start with one"}</span></div>
          <div className="setup-pipeline-list">{suggestions.map((suggestion: any) => <article className="setup-pipeline" key={suggestion.id} data-setup-pipeline={suggestion.id}>
            <div className="setup-pipeline-top"><span className="setup-pipeline-icon">{suggestion.id === "security-check" ? <ShieldCheck size={18} /> : <Activity size={18} />}</span><h4>{suggestion.name}</h4>{suggestion.recommended && !suggestion.existing.length && <span className="setup-recommended">{view.completed ? "Suggested next" : "Start here"}</span>}</div>
            <p>{suggestion.description}</p><div className="setup-pipeline-bottom"><span className={`setup-label ${suggestion.ready && suggestion.status !== "Paused" ? "positive" : ""}`}><Circle size={6} fill="currentColor" />{suggestion.status}</span><a href={suggestion.href}>{suggestion.existing.length ? "Continue in chat" : "Set up in chat"}<ArrowUpRight size={14} /></a></div>
          </article>)}</div>
          {pipelines.filter((p) => !suggestions.some((s: any) => s.id === p.template)).map((p) => <a className="setup-custom-pipeline" key={p.id} href={ask(`Show the setup and status of the existing pipeline ${JSON.stringify(p.id)}`)}><SlidersHorizontal size={15} />{p.name}<span>{p.enabled ? "Configured" : "Paused"}</span><ArrowUpRight size={13} /></a>)}
          <a className="setup-other" href={ask("Help me design another pipeline using the existing engine capabilities")}><Plus size={13} />Have another objective? Discuss it in chat.</a>
        </section>
      </div>

      <aside className="setup-secondary">
        <section className="setup-section" aria-labelledby="setup-tracking"><div className="setup-section-heading"><h3 id="setup-tracking">Tracking</h3><span>{view.tracked.length ? "Found in your code" : "For production signals"}</span></div>
          <p className="setup-section-copy">{view.tracked.length ? view.tracked.every(view.connected) ? "Your detected tools have read access. Check their coverage for this project." : "Connect a tool you already use to investigate real user problems." : view.available.length ? "Your workspace has connected sources. Check that they cover this project." : "No supported tracking SDK detected. Add one for production errors, or start with a code review."}</p>
          {sources.filter((s) => tracking[s.id]).sort((a, b) => Number(view.detected(b)) - Number(view.detected(a))).map((source) => {
            const installed = view.detected(source);
            const connected = view.connected(source);
            const info = tracking[source.id]!;
            const detectedRepos = repos.filter((r) => r.trackers.some((t: any) => t.provider === source.id));
            return <article className="setup-source" key={source.id} data-setup-source={source.id}>
              <div className="setup-source-top"><span className={`setup-source-logo ${source.id}`}>{info.letter}</span><h4>{source.name}</h4><span className={`setup-label ${connected ? "positive" : ""}`}>{connected ? "Connected" : installed ? "SDK detected" : "Optional"}</span></div>
              <p>{info.description}</p>
              {installed && <div className="setup-source-repos"><GitFork size={12} /><span>{detectedRepos.map((r) => r.name).join(" · ")}</span></div>}
              {connected ? <p className="setup-source-access"><Check size={12} />Workspace read access verified</p> : installed && <p className="setup-source-access">Read access not connected</p>}
              <div className="setup-source-actions"><a href={ask(connected ? `Check ${source.name} project mapping and data coverage for my repositories` : installed ? `Connect the existing ${source.name} tracking using the in-chat connection form, then continue my first Bug radar` : `Help me add ${source.name} tracking to my repositories. Inspect the existing setup first and explain what needs to be installed`)}>{connected ? "Check coverage" : installed ? `Connect ${source.name}` : "Set up with Claude"}<ArrowRight size={13} /></a><a href={info.docs} target="_blank" rel="noreferrer" aria-label={`${source.name} documentation`} title="Official documentation"><ArrowUpRight size={14} /></a></div>
            </article>;
          })}
          {unsupported.length > 0 && <p className="setup-unsupported">{unsupported.map((id) => id === "sentry" ? "Sentry" : id).join(", ")} detected. Collection is not available in this build.</p>}
        </section>
        <div className="setup-flow"><span className="setup-eyebrow">HOW IT WORKS</span><p>Signals <ArrowRight size={12} /> Investigation <ArrowRight size={12} /> Review</p><span>Claude checks the code and evidence. You decide which findings to act on.</span><a href={view.liveHref}>See Pipeline live<ArrowUpRight size={13} /></a></div>
      </aside>
    </div>
  </div>;
}
