/**
 * A finding is the radar's unit of output. Precision over recall: a finding is
 * only emitted when every REQUIRED evidence field is filled from real data.
 * "No clear problems found" is a valid, first-class run result.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type Confidence = "confirmed" | "likely";

export interface Finding {
  id: string; // stable hash of the root-cause fingerprint
  runId: string;
  title: string; // user-visible symptom, plain words, <= 90 chars
  severity: Severity;
  confidence: Confidence;

  /** What users experience, in one paragraph. No speculation. */
  symptom: string;
  /** Measured impact inside the window. */
  impact: {
    usersAffected?: number;
    occurrences: number;
    firstSeen: string;
    lastSeen: string;
    trend: "new" | "rising" | "steady" | "falling";
  };
  /** The root cause the radar committed to, and the chain of evidence for it. */
  rootCause: {
    statement: string;
    /** Each step cites at least one evidence item by id. */
    reasoning: readonly { claim: string; evidenceIds: readonly string[] }[];
    /** Code location when the repo is connected (read-only clone). */
    codePointers?: readonly { repo?: string; path: string; line?: number; commit?: string; text?: string; why?: string; url?: string }[];
    /** What was checked and ruled out. */
    ruledOut?: readonly string[];
  };
  evidence: readonly Evidence[];
  /** Reproduction recipe, if derivable from recordings/events. Marked "not established" otherwise. */
  reproduction: { steps: readonly string[] } | { notEstablished: string };
  /** Suggested fix direction. Advice only; v1 never writes code. */
  suggestedFix?: string;
  /** Plain list of what is NOT known yet. Required, may be empty. */
  openQuestions: readonly string[];

  dedupe: {
    fingerprint: string;
    /** Existing issue this was matched against, if any. */
    matchedIssue?: { ref: string; url: string; similarity: number; decision: "duplicate" | "related" | "new" };
  };
  status: FindingStatus;
  /** Name of the configured repo (config repos[].name) this finding is about, when known. */
  repo?: string;
  filedIssue?: { ref: string; url: string; filedAt: string; filedBy: "human" | "auto" };
}

export type FindingStatus = "new" | "filed" | "dismissed" | "duplicate" | "superseded";

export interface Evidence {
  id: string; // e.g. "e1"
  sourcePluginId: string;
  kind: "error_group" | "stack_trace" | "event_series" | "funnel" | "recording" | "log_lines" | "release" | "code";
  /** Deep link the human can click to see the raw thing. Required. */
  url: string;
  /** Short quoted excerpt (redacted). */
  excerpt: string;
  /** When the excerpt was read. Evidence older than the run window is rejected. */
  observedAt: string;
}
