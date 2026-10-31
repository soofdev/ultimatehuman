import type { Finding } from "@ultimatehuman/sdk";
import type { RunRecord } from "../pass/types";
import type { Proposal } from "../store/store";
import { instantiate, materialize, templateById } from "./registry";

/**
 * Single radar -> pipelines. The old `radar` block becomes ONE pipeline copied from the
 * bug-radar template, carrying the old knobs, under this id; runs, tickets and proposals stored
 * before pipelines existed belong to it, and its instruction set is the old one (moved by
 * migrateLegacyInstructions at boot).
 */
export const LEGACY_PIPELINE_ID = "bug-radar";

export const pipelineOfRun = (r: Pick<RunRecord, "pipelineId">): string => r.pipelineId ?? LEGACY_PIPELINE_ID;
export const pipelineOfFinding = (f: Finding): string => ((f as Finding & { pipelineId?: string }).pipelineId ?? LEGACY_PIPELINE_ID);
export const pipelineOfProposal = (p: Pick<Proposal, "pipelineId">): string => p.pipelineId ?? LEGACY_PIPELINE_ID;

/** Raw config step, idempotent. No `pipelines` key = an old file: build the one pipeline from `radar`. An explicit `pipelines: []` stays empty. */
export function migratePipelines(c: Record<string, any>): Record<string, any> {
  const { radar, ...rest } = c;
  if (Array.isArray(c.pipelines)) return { ...rest, pipelines: c.pipelines.map((p: unknown) => (p && typeof p === "object" ? materialize(p as Record<string, unknown>) : p)) };
  const r = (radar ?? {}) as Record<string, any>;
  const over: Record<string, unknown> = { legacyClusterIds: true };
  for (const k of ["schedule", "lookbackHours", "firstPassLookbackHours", "minUsersAffected"]) if (r[k] !== undefined) over[k] = r[k];
  if (r.maxFindingsPerRun !== undefined) over.maxFindingsPerPass = r.maxFindingsPerRun;
  return { ...rest, pipelines: [instantiate(templateById(LEGACY_PIPELINE_ID)!, { id: LEGACY_PIPELINE_ID, ...over })] };
}
