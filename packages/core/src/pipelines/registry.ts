import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema";
import { BRIEF_IDS, Instructions, withFloor, type BriefId } from "../instructions/instructions";
import { PipelineSchema, type PipelineConfig, type PipelineInput } from "./schema";
import { TEMPLATES, type PipelineTemplate } from "./templates";
import { BLANK_BRIEFS } from "./templates/blank";
import { agentModel } from "../runner/provider";

/**
 * Config -> pipelines. Instantiating a template COPIES it into a config entry; from then on the
 * entry is the user's. The registry also owns each pipeline's namespaced instruction set
 * (instructions/<id>/), seeded once from the entry's `briefs`, else its template's briefs,
 * else the blank skeleton.
 */

export const templateById = (id: string | undefined): PipelineTemplate | undefined => TEMPLATES.find((t) => t.id === id);

/** A full, independent config entry copied from a template. */
export function instantiate(t: PipelineTemplate, over: Partial<PipelineInput> = {}): PipelineInput {
  return structuredClone({ id: t.id, name: t.name, description: t.description, template: t.id, ...t.pipeline, ...over }) as PipelineInput;
}

export function blankPipeline(id: string, name: string, over: Partial<PipelineInput> = {}): PipelineInput {
  return { id, name, description: "", enabled: false, schedule: "manual", sources: ["*"], signalTypes: [], ...over };
}

/**
 * Raw-config step (before validation): an entry that names a template but leaves fields out
 * (e.g. the chat wrote `{ "template": "security-check" }`) gets the template's values copied in.
 * The copy lands in the file on the next write. Explicit values always win.
 */
export function materialize(entry: Record<string, unknown>): Record<string, unknown> {
  const t = templateById(entry.template as string | undefined);
  if (!t) return entry;
  const base = instantiate(t) as Record<string, unknown>;
  return { ...base, ...entry, id: entry.id ?? base.id };
}

/** Seed for a pipeline's v1 briefs (and for briefs an older version lacks). */
export function seedBriefs(p: Pick<PipelineConfig, "briefs" | "template" | "minUsersAffected">): Record<BriefId, string> {
  const base = templateById(p.template)?.briefs ?? BLANK_BRIEFS;
  const out = Object.fromEntries(BRIEF_IDS.map((id) => [id, p.briefs?.[id] ?? base[id]])) as Record<BriefId, string>;
  if (!p.briefs?.admission) out.admission = withFloor(out.admission, p.minUsersAffected);
  return out;
}

/** Model a stage runs on for this pipeline: its override, else the global models block. */
export function modelFor(cfg: Config, p: PipelineConfig | undefined, stage: "radar" | "review" | "retrospective"): string {
  return agentModel(cfg, stage, p);
}

export function validationGateFor(cfg: Config, p: PipelineConfig | undefined): boolean {
  return p?.features?.validationGate ?? cfg.features.validationGate;
}

export class PipelineRegistry {
  private sets = new Map<string, Instructions>();
  constructor(
    private readonly home: string,
    private readonly getConfig: () => Config,
  ) {}

  list(): PipelineConfig[] {
    return this.getConfig().pipelines;
  }

  get(id: string): PipelineConfig | undefined {
    return this.list().find((p) => p.id === id);
  }

  /** The instruction set of one pipeline, provisioned on first use. Runs of a deleted pipeline still read their own history. */
  instructions(id: string): Instructions {
    let ins = this.sets.get(id);
    if (!ins) {
      ins = new Instructions(join(this.home, "instructions", id), () => seedBriefs(this.get(id) ?? PipelineSchema.parse({ id, name: id })));
      this.sets.set(id, ins);
    }
    ins.ensure();
    return ins;
  }

  /** Provision every configured pipeline's set (boot, and after a config change). */
  ensureAll(): void {
    for (const p of this.list()) this.instructions(p.id);
  }

  /** On delete: the set moves to instructions/.deleted/, so re-creating the id starts from its template again. */
  archive(id: string): void {
    const dir = join(this.home, "instructions", id);
    this.sets.delete(id);
    if (!existsSync(dir)) return;
    const to = join(this.home, "instructions", ".deleted");
    mkdirSync(to, { recursive: true, mode: 0o700 });
    renameSync(dir, join(to, `${id}-${Date.now()}`));
  }
}
