import type { RunPhase, Signal } from "@ultimatehuman/sdk";

export interface PhaseEntry {
  phase: RunPhase | "gating" | "retrospective";
  status: "running" | "done" | "skipped" | "failed";
  startedAt: string;
  endedAt?: string;
  note?: string;
}

export interface StepEntry {
  clusterId: string;
  clusterTitle: string;
  step: "root_cause" | "gate" | "adversarial" | "dedupe" | "retrospective";
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
  usersAffected?: number;
  at: string;
}

/** What a standing ruling did to a cluster in this run (applied before any agent spend). */
export interface RuledEntry {
  clusterId: string;
  clusterTitle: string;
  outcome: "suppressed" | "parked" | "resurfaced" | "escalated" | "already_filed" | "recurred_after_filing" | "awaiting_ruling";
  note: string;
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
  /** Clusters a standing ruling acted on in this run. */
  ruled?: RuledEntry[];
  notes: string[];
  costUsd: number;
  /** Read-only repo checkout the agents could read for this run, if one was connected. */
  /** Legacy single checkout (runs before multi-repo). New runs use `repos`. */
  code?: { path: string; commit?: string; repo?: string };
  repos?: { name: string; path: string; commit?: string; repo?: string; notes?: string }[];
  /** The instruction set this run read (SPEC 7b): fixed at trigger time, so a resumed run keeps its version. */
  instructions?: { version: number; at: string; note: string; minUsersAffected: number; tokens: number };
  /** What the post-run retrospective did: proposal ids it put in the cockpit, or why it did not run. */
  retrospective?: { status: "proposed" | "nothing" | "skipped" | "failed"; note: string; proposalIds: string[] };
  /** Checkpoint: index of the next cluster to root-cause (resume after park/crash). */
  nextCluster: number;
  signals?: Signal[];
}
