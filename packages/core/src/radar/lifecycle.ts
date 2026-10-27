import type { Finding, RunPhase, RunSummary, Signal, SourcePlugin, OutputPlugin, PluginContext } from "@ultimatehuman/sdk";
import type { AgentRunner } from "../runner/agent";
import type { WindowGovernor } from "../governor/window";
import type { Store } from "../store/store";

/**
 * One radar pass: schedule -> collect -> correlate -> root-cause -> dedupe -> ready.
 * Filing happens later, on a human click (or autoFile). Each phase transition is
 * persisted before work starts, so a crash or a usage-limit park resumes at the
 * last completed phase instead of re-spending.
 */

export interface RunDeps {
  sources: readonly { plugin: SourcePlugin; ctx: PluginContext }[];
  output: { plugin: OutputPlugin; ctx: PluginContext } | null;
  runner: AgentRunner;
  governor: WindowGovernor;
  store: Store;
  emit: (run: RunSummary) => void;
}

export class RadarRun {
  constructor(
    private summary: RunSummary,
    private readonly deps: RunDeps,
  ) {}

  get id() { return this.summary.id; }

  private async enter(phase: RunPhase, patch: Partial<RunSummary> = {}) {
    this.summary = { ...this.summary, ...patch, phase };
    await this.deps.store.saveRun(this.summary);
    this.deps.emit(this.summary);
  }

  async execute(window: { from: string; to: string }): Promise<RunSummary> {
    await this.enter("collecting");
    const signals: Signal[] = [];
    for (const { plugin, ctx } of this.deps.sources) {
      for await (const s of plugin.source.collect(ctx, window)) signals.push(s);
    }
    await this.enter("correlating", { signalsCollected: signals.length });
    const clusters = await this.correlate(signals);
    await this.enter("root_causing");
    const findings = await this.rootCause(clusters);
    await this.enter("deduping");
    const kept = await this.dedupe(findings);
    for (const f of kept) await this.deps.store.saveFinding(f);
    const patch: Partial<RunSummary> = { findings: kept.length, finishedAt: new Date().toISOString() };
    if (kept.length === 0) patch.emptyReason = "No clear problems found in this window.";
    await this.enter("done", patch);
    return this.summary;
  }

  /** Deterministic pre-grouping by shared keys (release, route, fingerprint) before any LLM call. */
  protected async correlate(_signals: Signal[]): Promise<Signal[][]> { return []; }
  /** Governor-admitted agent step per cluster; refuses to emit without full evidence. */
  protected async rootCause(_clusters: Signal[][]): Promise<Finding[]> { return []; }
  /** Fingerprint match vs store, then similarity vs open/closed GitHub issues. */
  protected async dedupe(findings: Finding[]): Promise<Finding[]> { return findings; }
}
