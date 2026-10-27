/**
 * Dashboard <-> engine API (served on 127.0.0.1 by the daemon).
 * Auth: a session cookie obtained by redeeming a single-use login link
 * (`ultimatehuman dashboard` prints it). No bearer tokens in URLs ever persist.
 */
import type { Finding } from "./finding";
import type { ProbeResult } from "./plugin";

export interface WindowStatus {
  authSource: string; // id of the active auth source
  kind: "subscription" | "api_key";
  /** 0-100; null when the provider does not expose it (then the governor uses its own ledger). */
  usedPct: number | null;
  resetsAt: string | null;
  humanReservePct: number;
  /** API-key spend today and the configured hard cap, in USD. */
  spendTodayUsd?: number;
  dailyCapUsd?: number;
  queued: number;
  state: "admitting" | "reserve_reached" | "parked_until_reset" | "cap_reached" | "no_auth";
}

export type RunPhase =
  | "scheduled"
  | "collecting"
  | "correlating"
  | "root_causing"
  | "deduping"
  | "ready"
  | "parked"
  | "failed"
  | "done";

export interface RunSummary {
  id: string;
  trigger: "schedule" | "run_now" | "onboarding";
  phase: RunPhase;
  startedAt: string;
  finishedAt?: string;
  signalsCollected: number;
  findings: number;
  /** Set when the run finished with nothing worth filing. Shown verbatim. */
  emptyReason?: string;
  parkedUntil?: string;
  error?: string;
}

export interface PluginStatus {
  id: string;
  displayName: string;
  configured: boolean;
  lastProbe?: ProbeResult & { at: string };
}

/** REST surface. Keys are "METHOD path". */
export interface ApiRoutes {
  "GET /api/health": { res: { ok: true; version: string } };
  "POST /api/auth/redeem": { req: { code: string }; res: { ok: true } }; // sets cookie
  "POST /api/auth/logout": { res: { ok: true } };
  "GET /api/status": { res: { window: WindowStatus; lastRun?: RunSummary; plugins: PluginStatus[] } };
  "GET /api/onboarding/detect": { res: { candidates: { pluginId: string; envVarsFound: string[] }[] } };
  "POST /api/plugins/:id/probe": { req: { credentials?: Record<string, string> }; res: ProbeResult };
  "GET /api/config": { res: { config: unknown; schema: unknown } }; // secrets shown as ${REFS}
  "PATCH /api/config": { req: { path: string; value: unknown }; res: { ok: true; warnings: string[] } };
  "GET /api/runs": { res: { runs: RunSummary[] } };
  "POST /api/runs": { req: { trigger: "run_now" }; res: { run: RunSummary } };
  "GET /api/findings": { res: { findings: Finding[] } };
  "GET /api/findings/:id": { res: { finding: Finding; issuePreview: { title: string; body: string } } };
  "POST /api/findings/:id/file": { res: { issue: { ref: string; url: string } } };
  "POST /api/findings/:id/dismiss": { req: { reason: string }; res: { ok: true } };
  /** The cockpit feed: finding and dropped-draft cards (with ruling + history), pass outcomes, decision cards, tab counts. */
  "GET /api/cockpit": { res: { cards: unknown[]; runs: unknown[]; decisions: unknown[]; counts: { new: number; ruled: number; parked: number; dropped: number } } };
  /** Rule on a cluster (finding or dropped draft). File goes through /api/findings/:id/file. */
  "POST /api/rulings": { req: { clusterId: string; ruling: "dismiss" | "park" | "clear"; reason?: string }; res: { ok: true } };
  "GET /api/doctor": { res: { checks: DoctorCheck[] } };
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  message: string;
  fixable: boolean;
}

/** Server -> client events on WS /api/events. */
export type ServerEvent =
  | { type: "run.phase"; run: RunSummary }
  | { type: "finding.new"; finding: Finding }
  | { type: "finding.updated"; finding: Finding }
  | { type: "ruling"; ruling: { clusterId: string; ruling: string; at: string } }
  | { type: "window.updated"; window: WindowStatus }
  | { type: "probe.result"; pluginId: string; result: ProbeResult };
