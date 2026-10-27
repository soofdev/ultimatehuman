import type { Finding } from "@ultimatehuman/sdk";
import type { Store, Ruling } from "./store/store";
import type { RunRecord, DroppedDraft, RuledEntry } from "./radar/types";

/**
 * The cockpit feed: everything the radar wants from the human, as cards.
 * Findings and dropped drafts are keyed by cluster id (a stable hash of what
 * the signals share), so a ruling made on either follows the item across runs.
 */

export interface HistoryEntry {
  at: string;
  kind: "found" | "dropped" | "previewed" | "refreshed" | "checked" | Ruling["ruling"];
  by: "you" | "radar";
  label: string;
  reason?: string | null;
}

export interface CockpitCard {
  kind: "finding" | "draft";
  clusterId: string;
  title: string;
  /** The ruling in force; null = waiting for one. */
  ruling: Ruling | null;
  /** Set when the radar brought the item back since the last human ruling. */
  resurfaced?: { at: string; note?: string };
  history: HistoryEntry[];
  finding?: Finding & Record<string, unknown>;
  draft?: DroppedDraft & { runId: string; runLabel: string; timesDropped: number };
}

export interface RunCard {
  id: string;
  label: string;
  trigger: RunRecord["trigger"];
  phase: RunRecord["phase"];
  startedAt: string;
  finishedAt?: string;
  lookbackHours: number;
  signals: number;
  findings: number;
  dropped: number;
  settled: number;
  suppressed: number;
  costUsd: number;
  emptyReason?: string;
  error?: string;
  parkedUntil?: string;
  notes: string[];
}

export interface DecisionCard {
  id: string;
  tone: "warn" | "bad" | "info";
  title: string;
  body: string;
  action?: { label: string; do: "retry" | "open_runs" | "open_usage" };
}

export function runLabel(r: Pick<RunRecord, "trigger" | "lookbackHours">): string {
  const span = r.lookbackHours % 24 === 0 ? `${r.lookbackHours / 24}-day` : `${r.lookbackHours}-hour`;
  return r.trigger === "onboarding" ? `First pass (${span})` : r.trigger === "schedule" ? `Daily ${span} pass` : `${span[0]!.toUpperCase()}${span.slice(1)} pass`;
}

const RULING_LABEL: Record<Ruling["ruling"], string> = {
  file: "Filed to GitHub",
  dismiss: "Dismissed",
  park: "Parked: not now",
  clear: "Ruling withdrawn",
  resurfaced: "Back in New",
};

const STAGE_LABEL: Record<string, string> = {
  floor: "below the user floor",
  rank: "outside the top clusters",
  root_cause: "by the root-cause agent",
  gate: "by the evidence gate",
  adversarial: "by the adversarial review",
  dedupe: "at dedupe",
};

const CHECKED: Partial<Record<RuledEntry["outcome"], string>> = {
  suppressed: "skipped it: suppressed by your ruling",
  parked: "checked it: nothing new since you parked it, stays parked",
  already_filed: "checked it: no new occurrence since you filed it",
  recurred_after_filing: "saw it again after you filed it: re-investigated",
  awaiting_ruling: "saw it again: kept the card as is, no agent re-run",
};

/** What later passes did with the item because of its ruling. */
function passHistory(runs: RunRecord[], cid: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const r of runs)
    for (const x of r.ruled ?? [])
      if (x.clusterId === cid && CHECKED[x.outcome]) out.push({ at: x.at, kind: "checked", by: "radar", label: `The ${runLabel(r).toLowerCase()} ${CHECKED[x.outcome]}` });
  return out;
}

function rulingHistory(rs: Ruling[]): HistoryEntry[] {
  return rs.map((r) => ({
    at: r.at,
    kind: r.ruling,
    by: r.by,
    label: r.ruling === "file" && r.dryRun ? "Filed to GitHub (dry run, nothing sent)" : r.ruling === "resurfaced" ? `Back in New: ${r.note ?? "new evidence"}` : RULING_LABEL[r.ruling],
    reason: r.reason,
  }));
}

function current(rs: Ruling[]): { ruling: Ruling | null; resurfaced?: { at: string; note?: string } } {
  const last = rs.at(-1);
  if (!last || last.ruling === "clear") return { ruling: null };
  if (last.ruling === "resurfaced") return { ruling: null, resurfaced: { at: last.at, ...(last.note ? { note: last.note } : {}) } };
  return { ruling: last };
}

export function buildCockpit(store: Store, active: RunRecord | null, opts: { dryRun: boolean; repo: string }) {
  const runs = store.listRuns(30).map((r) => (active && r.id === active.id ? active : r));
  const byId = new Map(runs.map((r) => [r.id, r]));
  const rulings = new Map<string, Ruling[]>();
  for (const r of store.allRulings()) rulings.set(r.clusterId, [...(rulings.get(r.clusterId) ?? []), r]);

  const cards: CockpitCard[] = [];
  const seen = new Set<string>();
  for (const f of store.listFindings() as (Finding & Record<string, any>)[]) {
    const cid = (f.clusterId as string) ?? `finding:${f.id}`;
    if (seen.has(cid)) continue; // newest finding per cluster
    seen.add(cid);
    const rs = rulings.get(cid) ?? [];
    const run = byId.get(f.runId);
    const history: HistoryEntry[] = [{ at: f.createdAt ?? f.impact.lastSeen, kind: "found", by: "radar", label: `Found by the ${run ? runLabel(run).toLowerCase() : "radar"}` }];
    if (f.dryRunPreview && !rs.some((r) => r.ruling === "file")) history.push({ at: f.dryRunPreview.at, kind: "previewed", by: "you", label: "Issue preview opened (dry run)" });
    if (f.refreshedBy) history.push({ at: f.refreshedBy.at, kind: "refreshed", by: "radar", label: "Impact refreshed by a later pass" });
    history.push(...rulingHistory(rs), ...passHistory(runs, cid));
    history.sort((a, b) => a.at.localeCompare(b.at));
    cards.push({ kind: "finding", clusterId: cid, title: f.title, ...current(rs), history, finding: f });
  }

  // Dropped drafts: the latest drop per cluster, across recent runs.
  const drops = new Map<string, { d: DroppedDraft; run: RunRecord; times: number; all: { d: DroppedDraft; run: RunRecord }[] }>();
  for (const run of runs) {
    for (const d of run.dropped ?? []) {
      if (seen.has(d.clusterId)) continue;
      const cur = drops.get(d.clusterId);
      if (cur) {
        cur.times++;
        cur.all.push({ d, run });
      } else drops.set(d.clusterId, { d, run, times: 1, all: [{ d, run }] });
    }
  }
  for (const [cid, { d, run, times, all }] of drops) {
    const rs = rulings.get(cid) ?? [];
    const users = d.usersAffected ?? run.clusters?.find((x) => x.id === cid)?.usersAffected ?? Number(/^(\d+) user/.exec(d.reason)?.[1] ?? NaN);
    const history: HistoryEntry[] = all.map(({ d: x, run: r }) => ({ at: x.at, kind: "dropped" as const, by: "radar" as const, label: `Dropped ${STAGE_LABEL[x.stage] ?? x.stage} in the ${runLabel(r).toLowerCase()}` }));
    history.push(...rulingHistory(rs), ...passHistory(runs, cid));
    history.sort((a, b) => a.at.localeCompare(b.at));
    cards.push({
      kind: "draft",
      clusterId: cid,
      title: d.title ?? d.clusterTitle,
      ...current(rs),
      history,
      draft: { ...d, ...(Number.isFinite(users) ? { usersAffected: users } : {}), runId: run.id, runLabel: runLabel(run), timesDropped: times },
    });
  }

  const runCards: RunCard[] = runs.slice(0, 8).map((r) => ({
    id: r.id,
    label: runLabel(r),
    trigger: r.trigger,
    phase: r.phase,
    startedAt: r.startedAt,
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    lookbackHours: r.lookbackHours,
    signals: r.signalsCollected,
    findings: r.findings,
    dropped: (r.dropped ?? []).length,
    settled: (r.ruled ?? []).length,
    suppressed: (r.ruled ?? []).filter((x) => x.outcome === "suppressed").length,
    costUsd: r.costUsd,
    ...(r.emptyReason ? { emptyReason: r.emptyReason } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.parkedUntil ? { parkedUntil: r.parkedUntil } : {}),
    notes: (r.notes ?? []).filter((n) => !n.startsWith("Dedupe ran against") && !n.startsWith("Code connected") && !n.startsWith("No code connected")),
  }));

  const decisions: DecisionCard[] = [];
  const last = runs[0];
  if (last?.phase === "failed")
    decisions.push({ id: `failed:${last.id}`, tone: "bad", title: "The last pass failed", body: last.error ?? "No error message was recorded.", action: { label: "Run again", do: "retry" } });
  if (last?.phase === "parked" && last.parkedUntil)
    decisions.push({ id: `parked:${last.id}`, tone: "warn", title: "The radar paused to protect your Claude reserve", body: `It resumes on its own at ${last.parkedUntil}. No process is left running meanwhile.`, action: { label: "See the window", do: "open_usage" } });

  const inNew = (c: CockpitCard) => c.kind === "finding" && !c.ruling;
  const counts = {
    new: cards.filter(inNew).length,
    ruled: cards.filter((c) => c.ruling && c.ruling.ruling !== "park").length,
    parked: cards.filter((c) => c.ruling?.ruling === "park").length,
    dropped: cards.filter((c) => c.kind === "draft" && !c.ruling).length,
  };
  return { cards, runs: runCards, decisions, counts, output: opts };
}

/** Older findings predate cluster ids: recover each one's cluster from its run (codebase-side backfill at startup). */
export function backfillFindingClusters(store: Store): number {
  let n = 0;
  for (const f of store.listFindings() as (Finding & Record<string, any>)[]) {
    if (f.clusterId) continue;
    const run = store.getRun(f.runId);
    if (!run) continue;
    const passed = run.steps.filter((s) => s.step === "dedupe" && s.status === "passed");
    const i = run.findingIds.indexOf(f.id);
    const step = passed[i];
    if (!step) continue;
    f.clusterId = step.clusterId;
    store.saveFinding(f);
    n++;
  }
  return n;
}
