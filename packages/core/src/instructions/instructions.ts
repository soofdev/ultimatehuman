import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * "Teach your pipeline" (SPEC 7b): each pipeline's judgment lives in its own
 * versioned markdown briefs in the home (`instructions/<pipeline id>/`),
 * hot-loaded at the start of every pass. Every save is a new version of the
 * whole set (a snapshot in `instructions/<pipeline id>/versions/v<N>.json`), so
 * a pass names one version and any version is one revert away.
 *
 * What stays in code (the rails, never editable here): read-only tools, the
 * evidence-citation and verbatim-quote checks, the JSON output contracts, the
 * caps (clusters per run, brief size, proposals per run), and the bounds of
 * every knob a brief may set.
 */

export const BRIEF_IDS = ["mission", "collector", "admission", "gate", "scope"] as const;
export type BriefId = (typeof BRIEF_IDS)[number];

export interface BriefMeta {
  id: BriefId;
  file: string;
  title: string;
  /** Which step reads it, in plain words. */
  feeds: string;
}

export const BRIEFS: readonly BriefMeta[] = [
  { id: "mission", file: "mission.md", title: "Mission", feeds: "Both agents: what this pipeline looks for, and what a ticket from it is." },
  { id: "collector", file: "collector.md", title: "Investigation checklist", feeds: "The root-cause agent works through it on every cluster." },
  { id: "admission", file: "admission.md", title: "Admission rules", feeds: "The user floor (applied before any agent runs) and what the root-cause agent counts as a real problem." },
  { id: "gate", file: "gate.md", title: "Gate verdict policy", feeds: "The adversarial reviewer: what it checks and when a draft holds, is partly right, or is broken." },
  { id: "scope", file: "scope.md", title: "Scope", feeds: "Both agents: what is in and out of scope for this product." },
];

/** Rails: listed in the editor so the user sees what an edit can never change. */
export const RAILS: readonly string[] = [
  "Agents only read: Read, Grep and Glob on the pass's bundle and the read-only repo checkouts. No shell, no writes, no web.",
  "Every reasoning claim cites evidence and a quote that is re-found verbatim in the bundle; code pointers are re-found in the repo.",
  "Evidence items with links per finding: at least the pipeline's gates.minEvidence (default 2); the answer must match the step's JSON format.",
  "Caps: clusters investigated per pass (the pipeline's maxFindingsPerPass × 2), 6000 characters per brief, 2 agent proposals per pass.",
  "Knob bounds: minUsersAffected is a whole number from 0 (no floor) to 1000.",
  "Nothing is filed without your ruling; a proposal never applies itself.",
];

/** Rail: a brief cannot grow past this (instruction bloat is a failure mode, SPEC 7b.3). */
export const MAX_BRIEF_CHARS = 6000;

export interface Knobs {
  minUsersAffected: number;
}

export interface VersionRecord {
  version: number;
  at: string;
  /** "defaults" = written by the engine on first boot, "disk" = a hand edit of the files, "you" = saved in the cockpit, "proposal" = an agent proposal you applied. */
  by: "defaults" | "disk" | "you" | "proposal";
  note: string;
  changed: BriefId[];
  briefs: Record<BriefId, string>;
  revertOf?: number;
  proposalId?: string;
}

export interface LoadedInstructions {
  version: number;
  at: string;
  note: string;
  knobs: Knobs;
  /** Brief bodies as the agents read them (front matter removed, knobs substituted). */
  bodies: Record<BriefId, string>;
  tokens: number;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

const FRONT = /^---\n([\s\S]*?)\n---\n?/;

/** Knobs live in the admission brief's front matter ("minUsersAffected: 2"). Bounds are a rail. */
export function parseKnobs(admission: string): { ok: true; knobs: Knobs } | { ok: false; error: string } {
  const fm = FRONT.exec(admission)?.[1] ?? "";
  const line = /^\s*minUsersAffected\s*:\s*(\S+)\s*$/m.exec(fm);
  if (!line) return { ok: false, error: 'admission.md must keep its front matter line "minUsersAffected: <number>"' };
  const n = Number(line[1]);
  if (!Number.isInteger(n) || n < 0 || n > 1000) return { ok: false, error: `minUsersAffected must be a whole number from 0 to 1000 (got "${line[1]}")` };
  return { ok: true, knobs: { minUsersAffected: n } };
}

export function validateBrief(id: BriefId, text: string): string | null {
  if (!text.trim()) return `${id}.md cannot be empty`;
  if (text.length > MAX_BRIEF_CHARS) return `${id}.md is ${text.length} characters; the cap is ${MAX_BRIEF_CHARS}. Trim before adding.`;
  if (id === "admission") {
    const k = parseKnobs(text);
    if (!k.ok) return k.error;
  }
  return null;
}

/** The admission brief with its floor knob set to `n` (used once, when a pipeline's v1 is written). */
export function withFloor(admission: string, n: number): string {
  return admission.replace(/^(\s*minUsersAffected\s*:\s*)\S+\s*$/m, `$1${n}`);
}

/** Brief as the agent reads it: front matter (knobs, comments) removed, {{knob}} placeholders filled. */
export function briefBody(text: string, knobs: Knobs): string {
  return text
    .replace(FRONT, "")
    .replace(/\{\{\s*minUsersAffected\s*\}\}/g, String(knobs.minUsersAffected))
    .trim();
}

export interface DiffLine {
  op: "=" | "+" | "-";
  text: string;
}

/** Line diff (LCS). Briefs are small, so the quadratic table is fine. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) out.push({ op: "=", text: x[i++]! }), j++;
    else if (t[i + 1]![j]! >= t[i]![j + 1]!) out.push({ op: "-", text: x[i++]! });
    else out.push({ op: "+", text: y[j++]! });
  }
  while (i < n) out.push({ op: "-", text: x[i++]! });
  while (j < m) out.push({ op: "+", text: y[j++]! });
  return out;
}

const same = (a: Record<string, string>, b: Record<string, string>) => BRIEF_IDS.every((id) => a[id] === b[id]);

/**
 * One pipeline's instruction set. `seed` gives the briefs v1 is written from (the pipeline's
 * template copy, or a blank skeleton); a brief missing from an older version (e.g. `mission`,
 * added with multi-pipeline) reads as its seed, so old versions stay valid.
 */
export class Instructions {
  readonly dir: string;
  private readonly vdir: string;

  constructor(
    dir: string,
    private readonly seed: () => Record<BriefId, string>,
  ) {
    this.dir = dir;
    this.vdir = join(this.dir, "versions");
  }

  /** Engine-side provisioning: the files and v1 exist after the first boot, whatever the install path. */
  ensure(): void {
    mkdirSync(this.vdir, { recursive: true, mode: 0o700 });
    if (this.latestNumber() === 0) {
      const defaults = this.seed();
      const onDisk = this.readDisk();
      const briefs = Object.fromEntries(BRIEF_IDS.map((id) => [id, onDisk[id] ?? defaults[id]])) as Record<BriefId, string>;
      this.write({ version: 1, at: new Date().toISOString(), by: "defaults", note: "Copied from the pipeline's template by the engine", changed: [...BRIEF_IDS], briefs });
    }
    // Missing files are restored from the latest version (the cockpit always edits through a save).
    const latest = this.get(this.latestNumber())!;
    for (const b of BRIEFS) if (!existsSync(join(this.dir, b.file))) writeFileSync(join(this.dir, b.file), latest.briefs[b.id], { mode: 0o600 });
  }

  private readDisk(): Partial<Record<BriefId, string>> {
    const out: Partial<Record<BriefId, string>> = {};
    for (const b of BRIEFS) {
      const p = join(this.dir, b.file);
      if (existsSync(p)) out[b.id] = readFileSync(p, "utf8");
    }
    return out;
  }

  private latestNumber(): number {
    if (!existsSync(this.vdir)) return 0;
    return Math.max(0, ...readdirSync(this.vdir).map((f) => Number(/^v(\d+)\.json$/.exec(f)?.[1] ?? 0)));
  }

  private write(v: VersionRecord): VersionRecord {
    writeFileSync(join(this.vdir, `v${v.version}.json`), JSON.stringify(v, null, 2), { mode: 0o600 });
    for (const b of BRIEFS) writeFileSync(join(this.dir, b.file), v.briefs[b.id], { mode: 0o600 });
    return v;
  }

  get(version: number): VersionRecord | undefined {
    const p = join(this.vdir, `v${version}.json`);
    if (!existsSync(p)) return undefined;
    const v = JSON.parse(readFileSync(p, "utf8")) as VersionRecord;
    const missing = BRIEF_IDS.filter((id) => typeof v.briefs[id] !== "string");
    if (missing.length) {
      const seed = this.seed();
      for (const id of missing) v.briefs[id] = seed[id];
    }
    return v;
  }

  versions(): VersionRecord[] {
    const out: VersionRecord[] = [];
    for (let v = this.latestNumber(); v >= 1; v--) {
      const r = this.get(v);
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * The set in force, read from disk. A valid hand edit of the files becomes a
   * version of its own ("edited outside the cockpit"); an invalid one is ignored
   * and the latest valid version is used, with the reason returned.
   */
  current(): { version: VersionRecord; warning?: string } {
    this.ensure();
    const latest = this.get(this.latestNumber())!;
    const disk = { ...latest.briefs, ...this.readDisk() };
    if (same(disk, latest.briefs)) return { version: latest };
    const errors = BRIEF_IDS.map((id) => validateBrief(id, disk[id])).filter(Boolean);
    if (errors.length) return { version: latest, warning: `the instruction files were edited by hand but are invalid (${errors.join("; ")}): v${latest.version} is used` };
    const changed = BRIEF_IDS.filter((id) => disk[id] !== latest.briefs[id]);
    return { version: this.write({ version: latest.version + 1, at: new Date().toISOString(), by: "disk", note: "Edited outside the cockpit", changed, briefs: disk }) };
  }

  /** Saves one brief as a new version of the set. The note is required: it is the version's history line. */
  save(id: BriefId, text: string, note: string, by: "you" | "proposal" = "you", extra: Partial<VersionRecord> = {}): VersionRecord {
    if (!BRIEF_IDS.includes(id)) throw new InstructionError(400, "unknown brief");
    const err = validateBrief(id, text);
    if (err) throw new InstructionError(400, err);
    if (!note.trim()) throw new InstructionError(400, "a note is required: it is the version's history line");
    const cur = this.current().version;
    if (cur.briefs[id] === text) throw new InstructionError(400, "nothing changed");
    return this.write({ version: cur.version + 1, at: new Date().toISOString(), by, note: note.trim().slice(0, 300), changed: [id], briefs: { ...cur.briefs, [id]: text }, ...extra });
  }

  /** One-tap revert: restores the set exactly as it was in `to`, as a new version (history is never rewritten). */
  revert(to: number, note?: string): VersionRecord {
    const target = this.get(to);
    if (!target) throw new InstructionError(404, `no version v${to}`);
    const cur = this.current().version;
    if (same(cur.briefs, target.briefs)) throw new InstructionError(400, `v${cur.version} already matches v${to}`);
    const changed = BRIEF_IDS.filter((id) => cur.briefs[id] !== target.briefs[id]);
    return this.write({ version: cur.version + 1, at: new Date().toISOString(), by: "you", note: note?.trim() || `Reverted to v${to}`, changed, briefs: { ...target.briefs }, revertOf: to });
  }

  /** A version, ready for the agents (knobs parsed, bodies cleaned). */
  load(v: VersionRecord): LoadedInstructions {
    const k = parseKnobs(v.briefs.admission);
    const fallback = parseKnobs(this.seed().admission);
    const knobs = k.ok ? k.knobs : fallback.ok ? fallback.knobs : { minUsersAffected: 1 };
    const bodies = Object.fromEntries(BRIEF_IDS.map((id) => [id, briefBody(v.briefs[id], knobs)])) as Record<BriefId, string>;
    return { version: v.version, at: v.at, note: v.note, knobs, bodies, tokens: BRIEF_IDS.reduce((a, id) => a + estimateTokens(bodies[id]), 0) };
  }
}

export class InstructionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Multi-pipeline migration (codebase-side, runs at boot): a home from before pipelines kept ONE
 * set at `instructions/` (briefs + versions/). It moves, history intact, to `instructions/<id>/`
 * of the pipeline the old radar config became. Idempotent: does nothing once moved.
 */
export function migrateLegacyInstructions(home: string, toPipelineId: string): boolean {
  const root = join(home, "instructions");
  const target = join(root, toPipelineId);
  if (!existsSync(join(root, "versions")) || existsSync(target)) return false;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  renameSync(join(root, "versions"), join(target, "versions"));
  for (const b of BRIEFS) if (existsSync(join(root, b.file))) renameSync(join(root, b.file), join(target, b.file));
  return true;
}
