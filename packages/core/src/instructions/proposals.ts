import { createHash } from "node:crypto";
import type { Store, Proposal } from "../store/store";
import type { ProposalDraft } from "../radar/prompts";
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

/** Turns an agent draft into a card, or says why the script refused it. `known` maps every citable id to a plain label. */
export function buildProposal(d: ProposalDraft, base: VersionRecord, runId: string, known: Map<string, string>): { ok: true; proposal: Proposal } | { ok: false; reason: string } {
  const brief = d.brief as BriefId;
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
