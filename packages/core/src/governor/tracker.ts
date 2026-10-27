import type { WindowStatus } from "@ultimatehuman/sdk";
import type { RateLimitReading } from "../runner/claude";
import type { Store } from "../store/store";

/**
 * Holds the latest real `rate_limit_event` per auth source and turns it into
 * the admission decision + the dashboard meter. Estimates per step kind are a
 * rolling p75 of observed window deltas, seeded until 5 samples exist.
 */
const SEED_PCT: Record<string, number> = { probe: 0.2, root_cause: 2, adversarial: 1 };

export interface AdmitResult {
  admit: boolean;
  usedPct: number | null;
  estimatePct: number;
  ceilingPct: number;
  resumeAt: string | null;
  reason?: string;
}

export class WindowTracker {
  private latest = new Map<string, RateLimitReading>();
  queued = 0;
  parkedUntil: string | null = null;

  constructor(
    private readonly store: Store,
    private readonly sourceId: string,
    private readonly sourceKind: "subscription" | "api_key",
    private readonly humanReservePct: number,
  ) {
    const saved = store.getKv<RateLimitReading>(`window:${sourceId}`);
    if (saved) this.latest.set(sourceId, saved);
  }

  ingest(r: RateLimitReading, runId: string | null = null): void {
    this.latest.set(this.sourceId, r);
    this.store.setKv(`window:${this.sourceId}`, r);
    this.store.addUsage(this.sourceId, "rate_limit", runId, r);
  }

  reading(): RateLimitReading | undefined {
    return this.latest.get(this.sourceId);
  }

  isStale(staleAfterMin: number): boolean {
    const r = this.reading();
    return !r || Date.now() - Date.parse(r.observedAt) > staleAfterMin * 60_000;
  }

  estimate(kind: string): number {
    const samples = this.store
      .listUsage("step", 200)
      .filter((u) => u.data.kind === kind && typeof u.data.windowDeltaPct === "number" && u.data.windowDeltaPct >= 0)
      .map((u) => u.data.windowDeltaPct as number)
      .sort((a, b) => a - b);
    if (samples.length < 5) return SEED_PCT[kind] ?? 1;
    return samples[Math.floor(samples.length * 0.75)]!;
  }

  admit(kind: string): AdmitResult {
    const r = this.reading();
    const est = this.estimate(kind);
    const ceiling = 100 - this.humanReservePct;
    const used = r?.fiveHourPct ?? null;
    const resumeAt = r?.fiveHourResetsAt ? new Date(r.fiveHourResetsAt * 1000).toISOString() : r?.resetsAt ? new Date(r.resetsAt * 1000).toISOString() : null;
    if (r?.status === "rejected") return { admit: false, usedPct: used, estimatePct: est, ceilingPct: ceiling, resumeAt, reason: "window_exhausted" };
    // Unknown utilization: admit one small step at a time and re-read after it (SPEC 5.2).
    if (used === null) return { admit: true, usedPct: null, estimatePct: est, ceilingPct: ceiling, resumeAt };
    if (used + est <= ceiling) return { admit: true, usedPct: used, estimatePct: est, ceilingPct: ceiling, resumeAt };
    return { admit: false, usedPct: used, estimatePct: est, ceilingPct: ceiling, resumeAt, reason: "reserve_reached" };
  }

  status(): WindowStatus & { sevenDayPct: number | null; observedAt: string | null; source: "rate_limit_event" | "unavailable"; estimates: Record<string, number> } {
    const r = this.reading();
    const used = r?.fiveHourPct ?? null;
    const resets = r?.fiveHourResetsAt ?? r?.resetsAt;
    let state: WindowStatus["state"] = "admitting";
    if (this.parkedUntil) state = "parked_until_reset";
    else if (used !== null && used >= 100 - this.humanReservePct) state = "reserve_reached";
    return {
      authSource: this.sourceId,
      kind: this.sourceKind,
      usedPct: used,
      resetsAt: resets ? new Date(resets * 1000).toISOString() : null,
      humanReservePct: this.humanReservePct,
      queued: this.queued,
      state,
      sevenDayPct: r?.sevenDayPct ?? null,
      observedAt: r?.observedAt ?? null,
      source: r ? "rate_limit_event" : "unavailable",
      estimates: { root_cause: this.estimate("root_cause"), adversarial: this.estimate("adversarial") },
    };
  }
}
