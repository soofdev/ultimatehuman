import type { Config, PendingItem } from "../config/schema";
import type { SetupGrade } from "./grade";
import { TEMPLATES } from "../pipelines/templates";
import { describeSchedule } from "../pipelines/schedule";

/** A pending item is done when every env var it waits for is set, or its grade check passes. */
export function isResolved(item: PendingItem, grade: SetupGrade, env: NodeJS.ProcessEnv = process.env): boolean {
  if (item.envVars?.length) return item.envVars.every((v) => !!env[v]);
  if (item.gradeCheck) return !!grade.checks.find((c) => c.id === item.gradeCheck)?.ok;
  return false;
}

export function resolvedItems(cfg: Config, grade: SetupGrade, env: NodeJS.ProcessEnv = process.env): PendingItem[] {
  return (cfg.pending ?? []).filter((i) => isResolved(i, grade, env));
}

const tierName = (t: string | null | undefined) => (t ? t[0]!.toUpperCase() + t.slice(1) : "not set up");

/** Plain-text setup status for the chat prompt: grade, what unlocks the next tier, the pending ledger. */
export function setupStatusText(cfg: Config, grade: SetupGrade, scopes: Record<string, readonly string[]> = {}): string {
  const lines = [`Setup grade: ${tierName(grade.tier)}${grade.next ? ` · next tier: ${tierName(grade.next)}` : " (top tier)"}`];
  if (grade.unlocks.length) lines.push(`What unlocks ${tierName(grade.next)}: ${grade.unlocks.map((c) => `${c.label} (${c.hint})`).join("; ")}`);
  const pending = cfg.pending ?? [];
  if (!pending.length) lines.push("Pending ledger: empty (nothing was skipped at install).");
  else {
    lines.push(`Pending ledger (${pending.length} item${pending.length === 1 ? "" : "s"} skipped at install):`);
    for (const p of pending) {
      const sc = p.plugin ? scopes[p.plugin] : undefined;
      lines.push(
        `- [${p.id}] ${p.label}${p.tier ? ` · helps reach ${tierName(p.tier)}` : ""} · why: ${p.why} · next step: ${p.unlock}` +
          (p.envVars?.length ? ` · resolves when ${p.envVars.map((v) => "$" + v).join(" + ")} is in the engine env file` : "") +
          (sc?.length ? ` · read-only scopes needed: ${sc.join(", ")}` : ""),
      );
    }
  }
  lines.push("", pipelinesText(cfg));
  return lines.join("\n");
}

/** The pipelines and the templates, as plain text for the chat prompt. */
export function pipelinesText(cfg: Config): string {
  const lines = [`Pipelines (${cfg.pipelines.length}):`];
  if (!cfg.pipelines.length) lines.push("- none: nothing runs until one is added.");
  for (const p of cfg.pipelines)
    lines.push(`- [${p.id}] "${p.name}" · ${p.enabled ? "enabled" : "DISABLED"} · ${describeSchedule(p.schedule)} · sources ${p.sources.join(", ")}${p.signalTypes.length ? ` · signal types ${p.signalTypes.join(", ")}` : ""} · max ${p.maxFindingsPerPass} tickets/pass${p.template ? ` · from template ${p.template}` : ""}`);
  lines.push(`Templates (suggestions, copied on add): ${TEMPLATES.map((t) => `[${t.id}] "${t.name}" (${describeSchedule(t.pipeline.schedule)}, sources ${t.pipeline.sources.join(", ")}): ${t.description}`).join(" | ")}`);
  return lines.join("\n");
}
