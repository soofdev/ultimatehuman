import type { Finding } from "@ultimatehuman/sdk";

/** Issue body rendered from structured fields only (never raw agent markdown). SPEC 6.6 */
const utc = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";

export function renderIssue(f: Finding, labels: readonly string[]): { title: string; body: string; labels: readonly string[] } {
  const ev = new Map(f.evidence.map((e) => [e.id, e]));
  const lines: string[] = [];
  const users = f.impact.usersAffected !== undefined ? `${f.impact.usersAffected} users` : "unknown number of users";
  lines.push(`> Found by ultimatehuman from ${[...new Set(f.evidence.map((e) => e.sourcePluginId))].join(", ")} data. Confidence: **${f.confidence}**. Severity: **${f.severity}**.`, "");
  lines.push("## Impact", `- ${users}, ${f.impact.occurrences} occurrences, trend: ${f.impact.trend}`, `- First seen ${utc(f.impact.firstSeen)}, last seen ${utc(f.impact.lastSeen)}`, "");
  lines.push("## What users experience", f.symptom, "");
  lines.push("## Root cause", f.rootCause.statement, "");
  for (const r of f.rootCause.reasoning) lines.push(`- ${r.claim} (${r.evidenceIds.map((id) => `[${id}](${ev.get(id)?.url ?? "#"})`).join(", ")})`);
  if (f.rootCause.codePointers?.length) {
    lines.push("", "**Code pointers** (each line re-checked against the repo before this was written):");
    for (const p of f.rootCause.codePointers) {
      const loc = `${p.path}${p.line ? `:${p.line}` : ""}`;
      lines.push(`- ${p.url ? `[\`${loc}\`](${p.url})` : `\`${loc}\``}${p.why ? `: ${p.why}` : ""}`);
      if (p.text) lines.push("  ```", `  ${p.text}`, "  ```");
    }
  }
  if (f.rootCause.ruledOut?.length) lines.push("", "**Ruled out:**", ...f.rootCause.ruledOut.map((x) => `- ${x}`));
  lines.push("", "## Evidence");
  for (const e of f.evidence) lines.push(`- **${e.id}** · ${(e as { label?: string }).label ?? e.kind} · [open in ${e.sourcePluginId}](${e.url})`, `  > ${e.excerpt.replace(/\n/g, "\n  > ")}`);
  lines.push("", "## Reproduction");
  if ("steps" in f.reproduction) f.reproduction.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  else lines.push(`Not established: ${f.reproduction.notEstablished}`);
  if (f.suggestedFix) lines.push("", "## Suggested direction", f.suggestedFix);
  lines.push("", "## Not established");
  if (f.openQuestions.length) lines.push(...f.openQuestions.map((q) => `- ${q}`));
  else lines.push("- Nothing open.");
  lines.push("", "---", `Fingerprint: \`${f.dedupe.fingerprint}\``);
  return { title: f.title, body: lines.join("\n"), labels };
}
