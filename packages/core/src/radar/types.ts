import type { RunPhase, Signal } from "@ultimatehuman/sdk";

export interface PhaseEntry {
  phase: RunPhase | "gating";
  status: "running" | "done" | "skipped" | "failed";
  startedAt: string;
  endedAt?: string;
  note?: string;
}

export interface StepEntry {
  clusterId: string;
  clusterTitle: string;
  step: "root_cause" | "gate" | "adversarial" | "dedupe";
  status: "queued" | "running" | "passed" | "dropped" | "failed" | "parked";
  startedAt?: string;
  endedAt?: string;
  note?: string;
  model?: string;
  costUsd?: number;
}

export interface Cluster {
  id: string;
  key: string;
  title: string;
  route?: string;
  usersAffected: number;
  occurrences: number;
  trend: "new" | "rising" | "steady" | "falling";
  score: number;
  signalIds: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface DroppedDraft {
  clusterId: string;
  clusterTitle: string;
  stage: "floor" | "root_cause" | "gate" | "adversarial" | "dedupe" | "rank";
  reason: string;
  title?: string;
  at: string;
}

export interface SourceStat {
  pluginId: string;
  ok: boolean;
  signals: number;
  note: string;
}

export interface RunRecord {
  id: string;
  trigger: "schedule" | "run_now" | "onboarding";
  phase: RunPhase;
  startedAt: string;
  finishedAt?: string;
  lookbackHours: number;
  window: { from: string; to: string };
  signalsCollected: number;
  findings: number;
  findingIds: string[];
  emptyReason?: string;
  parkedUntil?: string;
  error?: string;
  phases: PhaseEntry[];
  steps: StepEntry[];
  sources: SourceStat[];
  clusters: Cluster[];
  dropped: DroppedDraft[];
  notes: string[];
  costUsd: number;
  /** Read-only repo checkout the agents could read for this run, if one was connected. */
  code?: { path: string; commit?: string; repo?: string };
  /** Checkpoint: index of the next cluster to root-cause (resume after park/crash). */
  nextCluster: number;
  signals?: Signal[];
}
