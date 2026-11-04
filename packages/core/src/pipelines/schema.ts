import { z } from "zod";
import { BRIEF_IDS } from "../instructions/instructions";
import { parseSchedule } from "./schedule";

/**
 * A pipeline is DATA: which sources feed it, which signal types it keeps, its own briefs, its
 * schedule, its model/gate overrides. One generic runtime executes any of them (runtime.ts);
 * nothing in the engine knows what a "bug radar" or a "security check" is.
 */

export const PIPELINE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Tickets enqueued from outside (POST /api/findings) without a pipeline id. Not usable as a pipeline id. */
export const EXTERNAL_PIPELINE_ID = "external";
/** Built-in source: each watched repo itself (manifests, commits in the window, sensitive paths) is the signal. */
export const REPOS_SOURCE = "repos";
/** Signal types the bundled plugins emit. Open list: a pipeline may name any type a plugin emits. */
export const SIGNAL_TYPE_SUGGESTIONS = ["error_group", "performance_regression", "funnel_drop", "event_anomaly", "rage_click", "session_recording", "log_pattern", "repo_audit"] as const;

/** Model stages a pipeline may override (ids of config.models). */
export const PIPELINE_MODEL_STAGES = ["radar", "review", "retrospective"] as const;
const modelId = z.string().regex(/^[A-Za-z0-9._\[\]-]+$/, "a model id like claude-opus-5-5");

export const PipelineSchema = z
  .object({
    id: z.string().regex(PIPELINE_ID, "lowercase letters, digits and dashes (max 40)").refine((id) => id !== EXTERNAL_PIPELINE_ID, `"${EXTERNAL_PIPELINE_ID}" is reserved for tickets from outside`).describe("Stable id: names the instruction set and tags every run and ticket"),
    name: z.string().min(1).max(60).describe("Shown on ticket badges and in the Runs list"),
    description: z.string().max(500).default("").describe("What this pipeline looks for, in a sentence"),
    enabled: z.boolean().default(true).describe("Off: never scheduled; Run now still works"),
    template: z.string().optional().describe("The template it was created from. Informational only: nothing is read from the template after creation"),
    repos: z.array(z.string().min(1)).min(1).optional().describe("Repository names this pipeline may read. Omitted for legacy workspace-wide pipelines."),
    timezone: z.string().refine((v) => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }, "Use an IANA timezone, such as America/New_York").optional().describe("Schedule timezone; defaults to the engine's local timezone"),
    schedule: z
      .string()
      .default("0 7 * * *")
      .refine((v) => !("error" in parseSchedule(v)), { message: 'use "M H * * *", "every N hours", a 5-field cron, or "manual"' })
      .describe('"M H * * *" (daily, local time), any 5-field cron with numbers, lists and */N, "every N hours", or "manual"'),
    sources: z.array(z.string().min(1)).default(["*"]).describe('Source plugin ids that feed it. "*" = every configured source; "repos" = the watched repos themselves (an audit pass)'),
    signalTypes: z.array(z.string().min(1)).default([]).describe(`Keep only these signal types; empty = all. Open strings; the bundled plugins emit ${SIGNAL_TYPE_SUGGESTIONS.join(", ")}`),
    lookbackHours: z.number().int().min(1).max(24 * 14).default(24),
    firstPassLookbackHours: z.number().int().min(1).max(24 * 14).default(168).describe("The first pass looks further back so a new install has data on day one"),
    minUsersAffected: z.number().int().min(0).max(1000).default(2).describe("Seeds the floor knob of this pipeline's admission brief on its first boot; from then on the brief (editable in Config > Instructions) is in force. 0 = no floor"),
    maxFindingsPerPass: z.number().int().min(1).max(20).default(5).describe("At most this many tickets per pass (twice as many clusters are investigated)"),
    models: z.partialRecord(z.enum(PIPELINE_MODEL_STAGES), modelId).default({}).describe("Per-stage model overrides; a missing stage uses the global models block"),
    codexModels: z.partialRecord(z.enum(PIPELINE_MODEL_STAGES), modelId).optional().describe("Codex stage overrides; omitted stages inherit the workspace Codex models"),
    features: z.object({ validationGate: z.boolean().optional().describe("Overrides features.validationGate for this pipeline's tickets") }).default({}),
    gates: z
      .object({ minEvidence: z.number().int().min(1).max(6).default(2).describe("Evidence items a finding must cite (each re-found verbatim)") })
      .prefault({}),
    briefs: z.partialRecord(z.enum(BRIEF_IDS), z.string().max(6000)).optional().describe("Seed for this pipeline's instruction set, read once when its v1 is written; then Config > Instructions owns the briefs"),
    legacyClusterIds: z.boolean().optional().describe("Set by the migration from the single radar: keeps cluster ids un-namespaced so earlier rulings still match"),
  })
  .strict();

export type PipelineConfig = z.infer<typeof PipelineSchema>;
export type PipelineInput = z.input<typeof PipelineSchema>;
