import type { Finding } from "@ultimatehuman/sdk";
import type { Store } from "../store/store";
import type { PassExecutor } from "../pass/executor";
import type { RunRecord } from "../pass/types";
import type { PipelineRegistry } from "./registry";
import { parseSchedule, due, describeSchedule } from "./schedule";
import { pipelineOfRun, pipelineOfFinding } from "./migrate";

/**
 * The generic runtime: one executor, any number of pipelines. Passes are serialized across
 * pipelines (one claude pass at a time, a parked pass keeps the slot); triggers that arrive while
 * one runs wait in a FIFO queue, one entry per pipeline. The 30 s tick fires each enabled
 * pipeline whose schedule names the current minute, once per minute.
 */
export interface QueuedPass {
  pipelineId: string;
  trigger: RunRecord["trigger"];
  lookbackHours?: number;
  at: string;
}

export interface PipelineSummary {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  template?: string;
  schedule: string;
  scheduleText: string;
  sources: string[];
  signalTypes: string[];
  lastRun: Pick<RunRecord, "id" | "phase" | "startedAt" | "finishedAt" | "findings" | "trigger"> | null;
  findings: { total: number; open: number };
  running: boolean;
  queued: boolean;
}

export interface RuntimeDeps {
  executor: PassExecutor;
  registry: PipelineRegistry;
  store: Store;
  log: (m: string) => void;
  emit: (ev: { type: string; [k: string]: unknown }) => void;
}

export class PipelineRuntime {
  private queue: QueuedPass[] = [];
  private fired = new Map<string, string>();

  constructor(private readonly d: RuntimeDeps) {}

  current(): RunRecord | null {
    return this.d.executor.current();
  }

  busy(): boolean {
    const a = this.current();
    return !!a && !["done", "failed"].includes(a.phase);
  }

  pending(): readonly QueuedPass[] {
    return this.queue;
  }

  /** Starts a pass now, or queues it behind the one running. A pipeline already running or queued is not queued twice. */
  trigger(pipelineId: string, trigger: RunRecord["trigger"], lookbackHours?: number): { run: RunRecord | null; queued: boolean; position: number } {
    const p = this.d.registry.get(pipelineId);
    if (!p) throw new Error(`no pipeline "${pipelineId}"`);
    const active = this.current();
    if (this.busy()) {
      if (active && pipelineOfRun(active) === pipelineId) return { run: active, queued: false, position: 0 };
      const at = this.queue.findIndex((q) => q.pipelineId === pipelineId);
      if (at >= 0) return { run: null, queued: true, position: at + 1 };
      this.queue.push({ pipelineId, trigger, ...(lookbackHours ? { lookbackHours } : {}), at: new Date().toISOString() });
      this.d.log(`pipeline ${pipelineId}: ${trigger} pass queued behind ${active ? pipelineOfRun(active) : "?"} (position ${this.queue.length})`);
      this.d.emit({ type: "pipelines.updated" });
      return { run: null, queued: true, position: this.queue.length };
    }
    const run = this.d.executor.start(p, trigger, lookbackHours);
    this.d.emit({ type: "pipelines.updated" });
    return { run, queued: false, position: 0 };
  }

  /** The executor calls this when a pass ends (done or failed): the next queued pipeline starts. */
  settled(): void {
    while (this.queue.length && !this.busy()) {
      const next = this.queue.shift()!;
      if (!this.d.registry.get(next.pipelineId)) continue; // deleted while waiting
      this.d.log(`pipeline ${next.pipelineId}: queued ${next.trigger} pass starts`);
      this.d.executor.start(this.d.registry.get(next.pipelineId)!, next.trigger, next.lookbackHours);
    }
    this.d.emit({ type: "pipelines.updated" });
  }

  tick(now: Date): void {
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
    for (const p of this.d.registry.list()) {
      if (!p.enabled || this.fired.get(p.id) === minute) continue;
      const s = parseSchedule(p.schedule);
      if ("error" in s || !due(s, now, p.timezone)) continue;
      this.fired.set(p.id, minute);
      this.trigger(p.id, "schedule");
    }
  }

  /** Drops a deleted pipeline's queued pass. */
  forget(pipelineId: string): void {
    this.queue = this.queue.filter((q) => q.pipelineId !== pipelineId);
  }

  summaries(): PipelineSummary[] {
    const runs = this.d.store.listRuns(300);
    const active = this.current();
    const findings = this.d.store.listFindings();
    return this.d.registry.list().map((p) => {
      const last = active && pipelineOfRun(active) === p.id ? active : runs.find((r) => pipelineOfRun(r) === p.id) ?? null;
      const mine = findings.filter((f) => pipelineOfFinding(f) === p.id);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        enabled: p.enabled,
        ...(p.template ? { template: p.template } : {}),
        schedule: p.schedule,
        scheduleText: describeSchedule(p.schedule),
        sources: p.sources,
        signalTypes: p.signalTypes,
        lastRun: last ? { id: last.id, phase: last.phase, startedAt: last.startedAt, ...(last.finishedAt ? { finishedAt: last.finishedAt } : {}), findings: last.findings, trigger: last.trigger } : null,
        findings: { total: mine.length, open: mine.filter((f: Finding) => f.status === "new").length },
        running: !!active && this.busy() && pipelineOfRun(active) === p.id,
        queued: this.queue.some((q) => q.pipelineId === p.id),
      };
    });
  }
}
