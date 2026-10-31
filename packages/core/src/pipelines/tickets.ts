import { createHash } from "node:crypto";
import { z } from "zod";
import type { Finding } from "@ultimatehuman/sdk";
import type { Store } from "../store/store";
import { EXTERNAL_PIPELINE_ID } from "./schema";

/**
 * The ONE narrow door through which a pipeline run (or an external tool) puts tickets in the
 * queue: create a ticket, or refresh the impact of one it already has. No raw store access.
 * Every ticket carries the id of the pipeline that produced it ("external" from outside).
 */
export interface TicketWriter {
  readonly pipelineId: string;
  /** Saves a new ticket stamped with this writer's pipeline id and announces it (finding.new). */
  create(finding: Finding): Finding;
  /** Updates the impact numbers of an existing ticket after a later pass saw it again. */
  refresh(findingId: string, impact: Finding["impact"], runId: string): Finding | undefined;
}

type Emit = (ev: { type: string; [k: string]: unknown }) => void;

export function ticketWriter(store: Pick<Store, "saveFinding" | "getFinding">, emit: Emit, pipelineId: string): TicketWriter {
  return {
    pipelineId,
    create(finding) {
      const f = { ...finding, pipelineId } as Finding;
      store.saveFinding(f);
      emit({ type: "finding.new", finding: f });
      return f;
    },
    refresh(findingId, impact, runId) {
      const f = store.getFinding(findingId) as (Finding & Record<string, unknown>) | undefined;
      if (!f) return undefined;
      f.impact = impact;
      f.refreshedBy = { runId, at: new Date().toISOString() };
      store.saveFinding(f);
      emit({ type: "finding.updated", finding: f });
      return f;
    },
  };
}

/** Body of POST /api/findings: the minimum a ticket needs, from any tool. */
export const ExternalTicketSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    summary: z.string().trim().min(3).max(4000).describe("What happens, in a paragraph"),
    pipelineId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional().describe(`Pipeline to attribute it to; default "${EXTERNAL_PIPELINE_ID}"`),
    severity: z.enum(["critical", "high", "medium", "low"]).default("medium"),
    confidence: z.enum(["confirmed", "likely"]).default("likely"),
    rootCause: z.string().trim().max(2000).optional(),
    repo: z.string().regex(/^[A-Za-z0-9._-]+$/).optional().describe("A configured repo name, shown as the repo badge"),
    fingerprint: z.string().trim().min(3).max(200).optional().describe("Stable id of the problem; the same fingerprint is one ticket (409 while one is open)"),
    evidence: z.array(z.object({ url: z.url(), label: z.string().max(200).optional(), excerpt: z.string().max(1000).default("") })).max(10).default([]),
    reproduction: z.array(z.string().max(500)).max(20).optional(),
    suggestedFix: z.string().max(2000).optional(),
    source: z.string().max(60).optional().describe("Free-form name of the tool that sent it"),
  })
  .strict();
export type ExternalTicket = z.infer<typeof ExternalTicketSchema>;

/** Turns a validated external ticket into a Finding (cluster id derived from the fingerprint, so rulings work on it). */
export function externalFinding(t: ExternalTicket): Finding & Record<string, unknown> {
  const now = new Date().toISOString();
  const fp = t.fingerprint ?? `external|${t.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`;
  const id = createHash("sha1").update(`ext:${fp}`).digest("hex");
  return {
    id: "f_" + createHash("sha1").update(fp + now).digest("hex").slice(0, 10),
    runId: "external",
    title: t.title,
    severity: t.severity,
    confidence: t.confidence,
    symptom: t.summary,
    impact: { occurrences: 1, firstSeen: now, lastSeen: now, trend: "new" },
    rootCause: { statement: t.rootCause ?? "Not established: reported by an external tool.", reasoning: [] },
    evidence: t.evidence.map((e, i) => ({ id: `E${i + 1}`, sourcePluginId: t.source ?? "external", kind: "event_series", url: e.url, excerpt: e.excerpt, observedAt: now, ...(e.label ? { label: e.label } : {}) })),
    reproduction: t.reproduction?.length ? { steps: t.reproduction } : { notEstablished: "not provided by the reporting tool" },
    ...(t.suggestedFix ? { suggestedFix: t.suggestedFix } : {}),
    openQuestions: [],
    dedupe: { fingerprint: fp },
    status: "new",
    createdAt: now,
    clusterId: "c_" + id.slice(0, 8),
    ...(t.repo ? { repo: t.repo } : {}),
    ...(t.source ? { reportedBy: t.source } : {}),
  };
}
