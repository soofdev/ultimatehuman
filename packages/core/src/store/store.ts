import type { Finding, RunSummary } from "@ultimatehuman/sdk";

/** Persistence port. v1 target: a single SQLite file next to the config, schema created by the engine at startup. */
export interface Store {
  saveRun(run: RunSummary): Promise<void>;
  getRun(id: string): Promise<RunSummary | undefined>;
  listRuns(limit: number): Promise<RunSummary[]>;
  saveFinding(f: Finding): Promise<void>;
  listFindings(filter?: { status?: Finding["status"] }): Promise<Finding[]>;
  findByFingerprint(fp: string): Promise<Finding | undefined>;
  /** Checkpoints let a parked run resume where it stopped. */
  saveCheckpoint(runId: string, data: unknown): Promise<void>;
  loadCheckpoint(runId: string): Promise<unknown>;
  recordUsage(entry: { at: string; sourceId: string; runId: string; usd?: number; windowPct?: number }): Promise<void>;
}
