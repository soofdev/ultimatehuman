import type { Config, ModelStage } from "../config/schema";
import type { PipelineConfig } from "../pipelines/schema";
import { runClaude, type ClaudeRunOptions } from "./claude";
import { runCodex } from "./codex";

export type AgentProvider = "claude" | "codex";
export const providerFor = (config: Config): AgentProvider => config.auth.sources[0]?.kind === "codex_login" ? "codex" : "claude";
export const providerLabel = (provider: AgentProvider): string => provider === "codex" ? "Codex" : "Claude Code";
export const runAgent = (provider: AgentProvider, options: ClaudeRunOptions) => provider === "codex" ? runCodex(options) : runClaude(options);

/** Provider choices never overwrite the other CLI's models or pipeline overrides. */
export function agentModel(config: Config, stage: ModelStage, pipeline?: PipelineConfig): string {
  const pipelineStage = stage === "radar" || stage === "review" || stage === "retrospective" ? stage : undefined;
  if (providerFor(config) === "codex") return (pipelineStage ? pipeline?.codexModels?.[pipelineStage] : undefined) ?? config.codexModels[stage] ?? "";
  return (pipelineStage ? pipeline?.models?.[pipelineStage] : undefined) ?? config.models[stage];
}

export function selectProvider(raw: Record<string, any>, provider: AgentProvider): void {
  const sources = raw.auth?.sources ?? [];
  const selected = sources.find((s: any) => (s.kind === "codex_login") === (provider === "codex"));
  let id = `local-${provider}`;
  for (let n = 2; sources.some((s: any) => s.id === id); n++) id = `local-${provider}-${n}`;
  const source = selected ?? { id, kind: provider === "codex" ? "codex_login" : "claude_login" };
  raw.auth = { ...(raw.auth ?? {}), sources: [source, ...sources.filter((s: any) => s !== selected)] };
}
