import type { AuthSourceState } from "../auth/sources";

/**
 * Window governor. The subscription window is SHARED with the human, so the
 * engine governs from the outside in:
 *   1. read actual remaining window before admitting any agent work
 *   2. never consume the human reserve (default: last 30%)
 *   3. on API keys, enforce a hard daily USD cap (pre-admission estimate + live ledger)
 *   4. on a limit hit mid-run: checkpoint, park the run, resume at window reset.
 *      Never a sleeping process, never a silent death.
 */

export interface WorkEstimate {
  /** Estimated share of a 5h window this step will use, in percent points. */
  windowPct: number;
  /** Estimated USD if run on an API key. */
  usd: number;
}

export type AdmitDecision =
  | { admit: true; sourceId: string }
  | { admit: false; reason: "reserve_reached" | "cap_reached" | "no_auth"; resumeAt: string | null };

export class WindowGovernor {
  constructor(private readonly humanReservePct: number) {}

  admit(states: readonly AuthSourceState[], est: WorkEstimate): AdmitDecision {
    let earliestReset: string | null = null;
    let lastReason: "reserve_reached" | "cap_reached" | "no_auth" = "no_auth";
    for (const s of states) {
      if (!s.available) continue;
      if (s.kind === "anthropic_api_key") {
        const spent = s.spendTodayUsd ?? 0;
        if (s.dailyCapUsd !== undefined && spent + est.usd <= s.dailyCapUsd) return { admit: true, sourceId: s.id };
        lastReason = "cap_reached";
        earliestReset = minIso(earliestReset, nextLocalMidnight());
        continue;
      }
      // Unknown usage is treated as "admit one small step, then re-read" by the caller.
      const used = s.usedPct ?? 0;
      if (used + est.windowPct <= 100 - this.humanReservePct) return { admit: true, sourceId: s.id };
      lastReason = "reserve_reached";
      earliestReset = minIso(earliestReset, s.resetsAt);
    }
    return { admit: false, reason: lastReason, resumeAt: earliestReset };
  }
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function nextLocalMidnight(): string {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}
