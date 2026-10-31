import type { BriefId } from "../../instructions/instructions";
import type { PipelineConfig } from "../schema";

/**
 * A template is a SUGGESTION: plain data copied into the user's config (and its briefs into the
 * pipeline's instruction store) when instantiated. Nothing reads a template after that; the user
 * owns every word. No logic lives in templates.
 */
export interface PipelineTemplate {
  /** Also the default pipeline id when instantiated. */
  id: string;
  name: string;
  description: string;
  /** Wizard default: offered as [Y/n] when true, [y/N] when false. */
  suggestedByDefault: boolean;
  /** Every pipeline field except id/name/description/template, copied as is. */
  pipeline: Omit<PipelineConfig, "id" | "name" | "description" | "template" | "briefs" | "legacyClusterIds">;
  /** Copied into instructions/<pipeline id>/ as v1. */
  briefs: Record<BriefId, string>;
}
