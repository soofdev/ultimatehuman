import type { Finding, RunSummary } from "@ultimatehuman/sdk";
import type { Store } from "./store";

/** Stub store for the skeleton; replaced by SQLite in the core-engine leg. */
export class MemoryStore implements Store {
  private runs = new Map<string, RunSummary>();
  private findings = new Map<string, Finding>();
  private checkpoints = new Map<string, unknown>();

  async saveRun(run: RunSummary) { this.runs.set(run.id, run); }
  async getRun(id: string) { return this.runs.get(id); }
  async listRuns(limit: number) { return [...this.runs.values()].slice(-limit).reverse(); }
  async saveFinding(f: Finding) { this.findings.set(f.id, f); }
  async listFindings(filter?: { status?: Finding["status"] }) {
    return [...this.findings.values()].filter((f) => !filter?.status || f.status === filter.status);
  }
  async findByFingerprint(fp: string) {
    return [...this.findings.values()].find((f) => f.dedupe.fingerprint === fp);
  }
  async saveCheckpoint(runId: string, data: unknown) { this.checkpoints.set(runId, data); }
  async loadCheckpoint(runId: string) { return this.checkpoints.get(runId); }
  async recordUsage() {}
}
