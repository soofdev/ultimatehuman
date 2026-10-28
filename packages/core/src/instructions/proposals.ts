import { createHash } from "node:crypto";
import type { Store, Proposal } from "../store/store";
import type { ProposalDraft } from "../radar/prompts";
import type { RunRecord } from "../radar/types";
import { Instructions, InstructionError, BRIEFS, lineDiff, estimateTokens, validateBrief, type BriefId, type VersionRecord } from "./instructions";

/**
 * Agent proposals (SPEC 7b.2-3). The retrospective agent drafts amendments;
 * this module is the script that holds them to the card template before any
 * human sees them: every edit is re-found in the brief, every "because" names
 * a real cluster or run, the result passes the same validation as a hand
 * save, and the card carries the diff plus the token delta. Applying is a
 * ruling, done here and nowhere else.
 */

export const MAX_PROPOSALS_PER_RUN = 2;
const REF = /\b(c_[0-9a-f]{8}|run_\d{14}_[0-9a-f]{4})\b/g;

export function applyEdits(text: string, edits: Proposal["edits"]): { ok: true; text: string } | { ok: false; error: string } {
  let out = text;
  for (const e of edits) {
    if (e.find === "") {
      out = out.replace(/\n*$/, "\n") + e.replace.replace(/^\n+/, "") + (e.replace.endsWith("\n") ? "" : "\n");
      continue;
    }
    const at = out.indexOf(e.find);
    if (at < 0) return { ok: false, error: `the text to change is not in the brief any more: "${e.find.slice(0, 80)}"` };
    out = out.slice(0, at) + e.replace + out.slice(at + e.find.length);
  }
  return { ok: true, text: out };
}

/** What each recent pass really did with each cluster: the ground truth an evidence claim is checked against. */
export interface RunFacts {
  /** Why the pass died (its error), if it did: nothing it saw is evidence. */
  died?: string | undefined;
  seen: Set<string>;
  dropped: Map<string, string>;
  feed: Set<string>;
}

export function runFacts(runs: RunRecord[], findingCluster: (findingId: string) => string | undefined): Map<string, RunFacts> {
  const out = new Map<string, RunFacts>();
  for (const r of runs) {
    const dropped = new Map((r.dropped ?? []).map((d) => [d.clusterId, d.stage as string]));
    const feed = new Set(r.findingIds.map(findingCluster).filter((c): c is string => !!c));
    const seen = new Set([...(r.clusters ?? []).map((c) => c.id), ...dropped.keys(), ...(r.ruled ?? []).map((x) => x.clusterId)]);
    out.set(r.id, { died: r.phase === "failed" ? r.error || "failed" : undefined, seen, dropped, feed });
  }
  return out;
}

const RUN_REF = /\brun_\d{14}_[0-9a-f]{4}\b/g;
const CLUSTER_REF = /\bc_[0-9a-f]{8}\b/g;
// One claim per clause: sentences, "then", "but", ", and", ", while", and the "evidence -> line" arrow.
const CLAUSE = /[.;]\s|,?\s+then\s+|,?\s+but\s+|,\s+(?:and|while|whereas)\s+|\s*->\s*/;
const NEGATED = /\b(never|not|no longer|didn't|did not|without|failed to)\b/;
const STAGE_WORDS: [RegExp, string[]][] = [
  [/\b(floor|admission)\b/, ["floor"]],
  [/\b(gate|adversarial|reviewer)\b/, ["gate", "adversarial"]],
  [/\broot[ _-]?cause\b/, ["root_cause"]],
];

/**
 * Checks what an agent SAYS about each ref against what the pass really did (SPEC 7b.3): a
 * cluster said to have reached the feed in run X must be a finding of run X, one said to be
 * dropped (at a stage) in run X must be in run X's drops (at that stage), and no ref may come
 * from a pass that died. Claims are read clause by clause; a clause with no run named is not checked.
 */
export function falseClaims(d: ProposalDraft, facts: Map<string, RunFacts>): string[] {
  const texts = [d.gap, ...d.evidence.map((e) => `${e.ref}: ${e.what}`), ...d.edits.map((e) => e.because)];
  const bad: string[] = [];
  for (const id of new Set(texts.flatMap((t) => t.match(RUN_REF) ?? []))) {
    const died = facts.get(id)?.died;
    if (died) bad.push(`${id} died mid-pass (${died.slice(0, 80)}): nothing from it is evidence`);
  }
  for (const e of d.evidence) {
    const subject = e.ref.match(CLUSTER_REF)?.[0];
    for (const clause of e.what.split(CLAUSE)) check(clause, subject);
  }
  for (const e of d.edits) for (const clause of e.because.split(CLAUSE)) check(clause, undefined);
  return [...new Set(bad)];

  function check(clause: string, subject: string | undefined): void {
    const lc = clause.toLowerCase();
    const runIds = (clause.match(RUN_REF) ?? []).filter((id) => facts.has(id));
    const clusters = clause.match(CLUSTER_REF) ?? (subject ? [subject] : []);
    if (!runIds.length || !clusters.length) return;
    const negated = NEGATED.test(lc);
    const feed = /reach(ed|es|ing)? the feed|in the feed|made it to the feed|became a finding/.test(lc);
    const drop = /\bdropp(ed|s|ing)\b|floor-dropped|below the floor/.test(lc);
    const stages = drop ? STAGE_WORDS.filter(([re]) => re.test(lc)).flatMap(([, s]) => s) : [];
    for (const run of runIds) {
      const f = facts.get(run)!;
      for (const c of clusters) {
        if (feed && f.feed.has(c) === negated) bad.push(`it says ${c} ${negated ? "did not reach" : "reached"} the feed in ${run}, but it ${f.feed.has(c) ? "did" : "did not"}`);
        if (drop && !negated) {
          const at = f.dropped.get(c);
          if (!at) bad.push(`it says ${c} was dropped in ${run}, but that pass did not drop it`);
          else if (stages.length && !stages.includes(at)) bad.push(`it says ${c} was dropped at the ${stages.join("/")} in ${run}, but it was dropped at ${at}`);
        }
      }
    }
  }
}

/** Where an applied proposal stands now: still in force, or undone by a later version (a revert or an edit). */
export function proposalFate(p: Proposal, versions: VersionRecord[]): string | null {
  const applied = p.rulings.find((r) => r.ruling === "apply")?.version;
  if (p.status !== "applied" || !applied) return null;
  const brief = p.brief as BriefId;
  const added = p.diff.filter((l) => l.op === "+" && l.text.trim()).map((l) => l.text);
  const removed = p.diff.filter((l) => l.op === "-" && l.text.trim()).map((l) => l.text);
  const inForce = (text: string) => (added.length ? added.every((l) => text.includes(l)) : removed.every((l) => !text.includes(l)));
  const later = [...versions].filter((v) => v.version > applied).sort((a, b) => a.version - b.version);
  for (const v of later) {
    if (inForce(v.briefs[brief])) continue;
    const how = v.revertOf !== undefined ? `reverted by your human in v${v.version} (back to v${v.revertOf})` : `undone by an edit in v${v.version} ("${v.note}")`;
    const now = later.at(-1)!;
    return `applied in v${applied}, ${how}; ${inForce(now.briefs[brief]) ? `back in force in v${now.version}` : `NOT in force in v${now.version}, on purpose`}`;
  }
  return `applied in v${applied}, still in force${later.length ? ` in v${later.at(-1)!.version}` : ""}`;
}

/** Turns an agent draft into a card, or says why the script refused it. `known` maps every citable id to a plain label. */
export function buildProposal(d: ProposalDraft, base: VersionRecord, runId: string, known: Map<string, string>, facts?: Map<string, RunFacts>): { ok: true; proposal: Proposal } | { ok: false; reason: string } {
  const brief = d.brief as BriefId;
  // Evidence accuracy: what the draft claims about each ref must be what the radar recorded.
  const lies = facts ? falseClaims(d, facts) : [];
  if (lies.length) return { ok: false, reason: `"${d.title}": its evidence does not check out: ${lies.join("; ")}` };
  const refsIn = (s: string) => [...s.matchAll(REF)].map((m) => m[1]!).filter((r) => known.has(r));
  const evidence = d.evidence.filter((e) => known.has(e.ref)).map((e) => ({ ...e, label: known.get(e.ref)! }));
  if (!evidence.length) return { ok: false, reason: `"${d.title}": none of its evidence is a cluster or run the radar knows` };
  // Prompt-budget rail: an edit that does not name the miss that pays for it is cut.
  const edits = d.edits.filter((e) => refsIn(e.because).length > 0);
  if (!edits.length) return { ok: false, reason: `"${d.title}": no edit names the cluster or run that pays for it` };
  const before = base.briefs[brief];
  const applied = applyEdits(before, edits);
  if (!applied.ok) return { ok: false, reason: `"${d.title}": ${applied.error}` };
  if (applied.text === before) return { ok: false, reason: `"${d.title}": the edits change nothing` };
  const invalid = validateBrief(brief, applied.text);
  if (invalid) return { ok: false, reason: `"${d.title}": ${invalid}` };
  const proposal: Proposal = {
    id: "p_" + createHash("sha1").update(runId + brief + applied.text).digest("hex").slice(0, 10),
    runId,
    brief,
    status: "pending",
    createdAt: new Date().toISOString(),
    title: d.title,
    gap: d.gap,
    evidence,
    edits,
    expectedEffect: d.expectedEffect,
    baseVersion: base.version,
    before,
    after: applied.text,
    diff: lineDiff(before, applied.text).filter((l) => l.op !== "="),
    tokensBefore: estimateTokens(before),
    tokensAfter: estimateTokens(applied.text),
    rulings: [],
  };
  return { ok: true, proposal };
}

/** Your ruling on a proposal. Apply re-plays the edits on the brief in force (it may have moved since the draft). */
export function ruleProposal(store: Store, ins: Instructions, id: string, ruling: "apply" | "reject" | "park", reason: string | null): { proposal: Proposal; version?: VersionRecord } {
  const p = store.getProposal(id);
  if (!p) throw new InstructionError(404, "no such proposal");
  if (p.status === "applied" || p.status === "rejected" || p.status === "stale") throw new InstructionError(409, `this proposal is already ${p.status}`);
  const at = new Date().toISOString();
  if (ruling === "reject") {
    if (!reason) throw new InstructionError(400, "say why you reject it: the next retrospectives read your reason");
    p.status = "rejected";
    p.rulings.push({ ruling, reason, at, by: "you" });
    store.saveProposal(p);
    return { proposal: p };
  }
  if (ruling === "park") {
    p.status = "parked";
    p.rulings.push({ ruling, reason, at, by: "you" });
    store.saveProposal(p);
    return { proposal: p };
  }
  const cur = ins.current().version;
  const replay = applyEdits(cur.briefs[p.brief as BriefId], p.edits);
  if (!replay.ok) {
    p.status = "stale";
    p.rulings.push({ ruling, reason: `could not apply: ${replay.error}`, at, by: "you" });
    store.saveProposal(p);
    throw new InstructionError(409, `${BRIEFS.find((b) => b.id === p.brief)?.file} changed since this proposal was drafted (v${p.baseVersion} → v${cur.version}): ${replay.error}`);
  }
  const v = ins.save(p.brief as BriefId, replay.text, `Applied proposal: ${p.title}`, "proposal", { proposalId: p.id });
  p.status = "applied";
  p.rulings.push({ ruling, reason, at, by: "you", version: v.version });
  store.saveProposal(p);
  return { proposal: p, version: v };
}
