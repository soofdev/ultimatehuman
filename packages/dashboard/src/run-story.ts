/** Plain-language view of an engine run, shared by Pipeline live and the chat. Reads only fields the engine records. */

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const SOURCE_NAMES: Record<string, string> = { datadog: "Datadog", posthog: "PostHog", sentry: "Sentry", repos: "the repositories", github: "GitHub" };
export const sourceName = (id: string) => SOURCE_NAMES[id] ?? id;
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** The five steps every run goes through, in the order a person would describe them. */
export const RUN_STEPS = ["Read signals", "Group", "Investigate", "Verify", "Wrap up"] as const;

export const isActive = (run: any) => !!run && !["done", "failed"].includes(run.phase);

const runningPhase = (run: any) => [...(run.phases || [])].reverse().find((p: any) => p.status === "running")?.phase as string | undefined;
/** A paused run resumes where it stopped: its last recorded phase. */
const lastPhase = (run: any) => (run.phases || []).at(-1)?.phase as string | undefined;
const runningStep = (run: any) => (run.steps || []).find((s: any) => s.status === "running");

/** Index into RUN_STEPS of what the run is doing now (RUN_STEPS.length once finished). */
export function runStepIndex(run: any): number {
  if (!isActive(run)) return RUN_STEPS.length;
  const phase = runningPhase(run) || (run.phase === "parked" ? lastPhase(run) : run.phase);
  const step = runningStep(run);
  if (phase === "collecting" || phase === "scheduled") return 0;
  if (phase === "correlating") return 1;
  if (phase === "gating" || phase === "deduping" || (step && ["gate", "adversarial", "dedupe"].includes(step.step))) return 3;
  if (phase === "root_causing") return 2;
  return 4;
}

const lookback = (hours?: number) => !hours ? "" : hours > 24 && hours % 24 === 0 ? `last ${plural(hours / 24, "day")}` : `last ${plural(hours, "hour")}`;
const quote = (s: string) => `“${s.replace(/^Datadog event: |^PostHog: /, "")}”`;

/** One line: what the run is doing right now. */
export function runNow(run: any, sources: string[] = []): string {
  if (run.phase === "parked") return `Paused: waiting for AI capacity${run.parkedUntil ? ` until ${new Date(run.parkedUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}.`;
  const phase = runningPhase(run) || run.phase;
  const step = runningStep(run);
  const candidates = (run.clusters || []).length;
  const from = list((sources.length ? sources : (run.sources || []).map((s: any) => s.pluginId)).map(sourceName)) || "your sources";
  if (phase === "collecting" || phase === "scheduled") return `Reading ${from}${run.lookbackHours ? ` · ${lookback(run.lookbackHours)}` : ""}…`;
  if (phase === "correlating") return `Grouping ${plural(run.signalsCollected ?? 0, "signal")} into candidates…`;
  if (step) {
    const position = candidates > 1 ? ` (${(run.clusters || []).findIndex((c: any) => c.id === step.clusterId) + 1} of ${candidates})` : "";
    if (step.step === "root_cause") return `Investigating ${quote(step.clusterTitle)} against the code${position}…`;
    if (step.step === "gate") return `Checking the evidence for ${quote(step.clusterTitle)}…`;
    if (step.step === "adversarial") return `Challenging ${quote(step.clusterTitle)}: a second AI looks for reasons it is wrong…`;
    if (step.step === "dedupe") return `Checking ${quote(step.clusterTitle)} is not already known…`;
  }
  if (phase === "root_causing") return `Investigating ${plural(candidates, "candidate")}…`;
  if (phase === "retrospective") return "Reviewing its own instructions for the next run…";
  return "Preparing the results…";
}

/** Every candidate the run considered: the engine keeps only those past the users-affected floor in clusters, the rest in dropped. */
export const candidateCount = (run: any) => new Set([...(run.clusters || []).map((c: any) => c.id), ...(run.dropped || []).map((d: any) => d.clusterId)]).size;

/** What finished runs did, as a few short sentences. */
export function runOutcome(run: any): { read: string; candidates: string; result: string; setAside: string[] } {
  const sources = (run.sources || []) as any[];
  const failed = sources.filter((s) => !s.ok);
  const read = failed.length
    ? `${list(failed.map((s) => sourceName(s.pluginId)))} could not be read${failed[0].note ? `: ${failed[0].note}` : ""}.`
    : `Read ${plural(run.signalsCollected ?? 0, "signal")} from ${list(sources.map((s) => sourceName(s.pluginId))) || "its sources"}${run.lookbackHours ? ` (${lookback(run.lookbackHours)})` : ""}.`;
  const total = candidateCount(run);
  const dropped = (run.dropped || []) as any[];
  const candidates = total ? `${plural(total, "candidate")}${dropped.length ? `, ${dropped.length} set aside` : ""}.` : "No candidates to investigate.";
  const setAside = dropped.slice(0, 3).map((d) => `${quote(d.clusterTitle)}: ${String(d.reason).replace(/\s*\(instructions v\d+\)/, "")}`);
  const result = run.phase === "failed" ? `Stopped: ${run.error || "the run failed"}.`
    : run.findings ? `${plural(run.findings, "finding")} ready for your review.`
      : "No findings: nothing had enough evidence to show you.";
  return { read, candidates, result, setAside };
}

export function duration(from?: string, to?: string | number): string {
  if (!from) return "";
  const s = Math.max(0, Math.round(((typeof to === "number" ? to : to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

export function ago(at?: string, now = Date.now()): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Model calls in flight: a running investigation step, or the end-of-run instruction review. */
export function runAgents(run: any): string[] {
  if (!isActive(run)) return [];
  const steps = (run.steps || []).filter((s: any) => s.status === "running").map((s: any) => s.step.replaceAll("_", " "));
  // The end-of-run review can be recorded as a phase and as a step at once: one call, counted once.
  return runningPhase(run) === "retrospective" && !steps.includes("retrospective") ? [...steps, "retrospective"] : steps;
}
