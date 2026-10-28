import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "@ultimatehuman/sdk";
import type { RunRecord } from "../radar/types";

/**
 * SQLite store (node:sqlite). The schema is created and migrated by the engine
 * at startup; there are no manual steps and no external database.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY, trigger TEXT NOT NULL, phase TEXT NOT NULL,
     started_at TEXT NOT NULL, finished_at TEXT, json TEXT NOT NULL);
   CREATE TABLE findings (
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
     status TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL);
   CREATE INDEX findings_fp ON findings(fingerprint);
   CREATE TABLE dismiss_rules (fingerprint TEXT PRIMARY KEY, reason TEXT NOT NULL, at TEXT NOT NULL);
   CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, source_id TEXT NOT NULL,
     kind TEXT NOT NULL, run_id TEXT, json TEXT NOT NULL);
   CREATE TABLE kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);`,
  // Rulings: the human's decisions, append-only. The latest row per cluster is the ruling in force;
  // the full list is the card's history. "clear" withdraws the ruling, "resurfaced" is written by the engine.
  `CREATE TABLE rulings (id INTEGER PRIMARY KEY AUTOINCREMENT, cluster_id TEXT NOT NULL, ruling TEXT NOT NULL,
     reason TEXT, at TEXT NOT NULL, by TEXT NOT NULL, json TEXT NOT NULL);
   CREATE INDEX rulings_cluster ON rulings(cluster_id, id);`,
  // Agent proposals to amend the instruction briefs (SPEC 7b). The human's rulings on them live in the json (history).
  `CREATE TABLE proposals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL,
     created_at TEXT NOT NULL, json TEXT NOT NULL);`,
];

export interface ProposalRuling {
  ruling: "apply" | "reject" | "park";
  reason: string | null;
  at: string;
  by: "you";
  /** The instruction version an apply produced. */
  version?: number;
}

export interface Proposal {
  id: string;
  runId: string;
  brief: string;
  /** pending = waiting for your ruling; stale = the brief changed so the edit no longer applies. */
  status: "pending" | "applied" | "rejected" | "parked" | "stale";
  createdAt: string;
  title: string;
  gap: string;
  evidence: { ref: string; what: string; label?: string }[];
  edits: { find: string; replace: string; because: string }[];
  expectedEffect: string;
  /** Instruction version the proposal was drafted against, and the brief text it produces on it. */
  baseVersion: number;
  before: string;
  after: string;
  diff: { op: "=" | "+" | "-"; text: string }[];
  tokensBefore: number;
  tokensAfter: number;
  rulings: ProposalRuling[];
}

export type RulingKind = "file" | "dismiss" | "park" | "clear" | "resurfaced";

export interface Ruling {
  id: number;
  clusterId: string;
  ruling: RulingKind;
  reason: string | null;
  at: string;
  /** "you" for a human ruling (single-user v1), "radar" for an engine event. */
  by: "you" | "radar";
  findingId?: string;
  fingerprint?: string;
  title?: string;
  dryRun?: boolean;
  /** Impact when the ruling was made: the baseline new evidence is measured against. */
  usersAtRuling?: number;
  lastSeenAtRuling?: string;
  note?: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(home: string) {
    const path = join(home, "state.db");
    const fresh = !existsSync(path);
    this.db = new DatabaseSync(path);
    if (fresh) chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    let version = row ? Number(row.value) : 0;
    while (version < MIGRATIONS.length) {
      this.db.exec(MIGRATIONS[version]!);
      version++;
      this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(version));
    }
  }

  schemaVersion(): number {
    return MIGRATIONS.length;
  }

  saveRun(run: RunRecord): void {
    this.db
      .prepare("INSERT OR REPLACE INTO runs(id,trigger,phase,started_at,finished_at,json) VALUES(?,?,?,?,?,?)")
      .run(run.id, run.trigger, run.phase, run.startedAt, run.finishedAt ?? null, JSON.stringify(run));
  }

  getRun(id: string): RunRecord | undefined {
    const r = this.db.prepare("SELECT json FROM runs WHERE id=?").get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as RunRecord) : undefined;
  }

  listRuns(limit = 50): RunRecord[] {
    return (this.db.prepare("SELECT json FROM runs ORDER BY started_at DESC LIMIT ?").all(limit) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as RunRecord,
    );
  }

  saveFinding(f: Finding): void {
    this.db
      .prepare("INSERT OR REPLACE INTO findings(id,run_id,fingerprint,status,created_at,json) VALUES(?,?,?,?,?,?)")
      .run(f.id, f.runId, f.dedupe.fingerprint, f.status, (f as Finding & { createdAt?: string }).createdAt ?? new Date().toISOString(), JSON.stringify(f));
  }

  getFinding(id: string): Finding | undefined {
    const r = this.db.prepare("SELECT json FROM findings WHERE id=?").get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Finding) : undefined;
  }

  listFindings(): Finding[] {
    return (this.db.prepare("SELECT json FROM findings ORDER BY created_at DESC").all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Finding,
    );
  }

  findingsByFingerprint(fp: string): Finding[] {
    return (this.db.prepare("SELECT json FROM findings WHERE fingerprint=?").all(fp) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Finding,
    );
  }

  addDismissRule(fingerprint: string, reason: string): void {
    this.db.prepare("INSERT OR REPLACE INTO dismiss_rules(fingerprint,reason,at) VALUES(?,?,?)").run(fingerprint, reason, new Date().toISOString());
  }

  dismissRule(fingerprint: string): { reason: string; at: string } | undefined {
    return this.db.prepare("SELECT reason, at FROM dismiss_rules WHERE fingerprint=?").get(fingerprint) as
      | { reason: string; at: string }
      | undefined;
  }

  addRuling(r: Omit<Ruling, "id" | "at"> & { at?: string }): Ruling {
    const at = r.at ?? new Date().toISOString();
    const { clusterId, ruling, reason, by, ...rest } = r;
    const res = this.db
      .prepare("INSERT INTO rulings(cluster_id,ruling,reason,at,by,json) VALUES(?,?,?,?,?,?)")
      .run(clusterId, ruling, reason ?? null, at, by, JSON.stringify({ ...rest, at: undefined }));
    return { ...r, id: Number(res.lastInsertRowid), at, reason: reason ?? null };
  }

  rulingHistory(clusterId: string): Ruling[] {
    return (this.db.prepare("SELECT * FROM rulings WHERE cluster_id=? ORDER BY id").all(clusterId) as any[]).map(rowToRuling);
  }

  allRulings(): Ruling[] {
    return (this.db.prepare("SELECT * FROM rulings ORDER BY id").all() as any[]).map(rowToRuling);
  }

  /** The ruling in force for a cluster: the latest human ruling, unless it was cleared or the radar resurfaced the item since. */
  currentRuling(clusterId: string): Ruling | undefined {
    const last = this.db.prepare("SELECT * FROM rulings WHERE cluster_id=? ORDER BY id DESC LIMIT 1").get(clusterId) as any;
    if (!last) return undefined;
    const r = rowToRuling(last);
    return r.ruling === "clear" || r.ruling === "resurfaced" ? undefined : r;
  }

  removeDismissRule(fingerprint: string): void {
    this.db.prepare("DELETE FROM dismiss_rules WHERE fingerprint=?").run(fingerprint);
  }

  addUsage(sourceId: string, kind: string, runId: string | null, data: unknown): void {
    this.db.prepare("INSERT INTO usage(at,source_id,kind,run_id,json) VALUES(?,?,?,?,?)").run(new Date().toISOString(), sourceId, kind, runId, JSON.stringify(data));
  }

  listUsage(kind: string, limit = 200): { at: string; sourceId: string; runId: string | null; data: any }[] {
    return (this.db.prepare("SELECT at, source_id, run_id, json FROM usage WHERE kind=? ORDER BY id DESC LIMIT ?").all(kind, limit) as any[]).map((r) => ({
      at: r.at,
      sourceId: r.source_id,
      runId: r.run_id,
      data: JSON.parse(r.json),
    }));
  }

  saveProposal(p: Proposal): void {
    this.db
      .prepare("INSERT OR REPLACE INTO proposals(id,run_id,brief,status,created_at,json) VALUES(?,?,?,?,?,?)")
      .run(p.id, p.runId, p.brief, p.status, p.createdAt, JSON.stringify(p));
  }

  getProposal(id: string): Proposal | undefined {
    const r = this.db.prepare("SELECT json FROM proposals WHERE id=?").get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Proposal) : undefined;
  }

  listProposals(limit = 50): Proposal[] {
    return (this.db.prepare("SELECT json FROM proposals ORDER BY created_at DESC LIMIT ?").all(limit) as { json: string }[]).map((r) => JSON.parse(r.json) as Proposal);
  }

  getKv<T>(key: string): T | undefined {
    const r = this.db.prepare("SELECT json FROM kv WHERE key=?").get(key) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : undefined;
  }

  setKv(key: string, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO kv(key,json) VALUES(?,?)").run(key, JSON.stringify(value));
  }
}

function rowToRuling(row: any): Ruling {
  return { ...JSON.parse(row.json), id: row.id, clusterId: row.cluster_id, ruling: row.ruling, reason: row.reason, at: row.at, by: row.by };
}
