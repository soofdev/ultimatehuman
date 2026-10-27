import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { Finding, Evidence, Plugin, PluginContext, Signal, SourcePlugin, ServerEvent } from "@ultimatehuman/sdk";
import type { Config } from "../config/schema";
import type { Store } from "../store/store";
import type { WindowTracker } from "../governor/tracker";
import { runClaude, extractJson, type ClaudeRunResult } from "../runner/claude";
import { readOnlyHttp } from "../plugins/http";
import { redact, hashUser } from "./redact";
import { DraftSchema, ReviewSchema, rootCausePrompt, adversarialPrompt, type Draft, type Review, type CodeContext } from "./prompts";
import type { Cluster, RunRecord, StepEntry, PhaseEntry, RuledEntry } from "./types";

export interface RadarDeps {
  home: string;
  store: Store;
  getConfig: () => Config;
  plugins: readonly Plugin[];
  resolveCredentials: (pluginId: string) => Promise<Record<string, string>>;
  runnerEnv: () => Promise<Record<string, string>>;
  tracker: WindowTracker;
  emit: (ev: ServerEvent | { type: string; [k: string]: unknown }) => void;
  log: (msg: string) => void;
  model?: string;
}

const now = () => new Date().toISOString();

export class Radar {
  private active: RunRecord | null = null;
  private parkTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: RadarDeps) {}

  current(): RunRecord | null {
    return this.active;
  }

  /** Single-flight: a second trigger while one is running returns the running run. */
  trigger(trigger: RunRecord["trigger"], lookbackHours?: number): RunRecord {
    if (this.active && !["done", "failed"].includes(this.active.phase)) return this.active;
    const cfg = this.d.getConfig();
    const hours = lookbackHours ?? (trigger === "onboarding" ? cfg.radar.firstPassLookbackHours : cfg.radar.lookbackHours);
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3600_000);
    const run: RunRecord = {
      id: `run_${to.toISOString().replace(/[-:T]/g, "").slice(0, 14)}_${randomBytes(2).toString("hex")}`,
      trigger,
      phase: "scheduled",
      startedAt: now(),
      lookbackHours: hours,
      window: { from: from.toISOString(), to: to.toISOString() },
      signalsCollected: 0,
      findings: 0,
      findingIds: [],
      phases: [],
      steps: [],
      sources: [],
      clusters: [],
      dropped: [],
      notes: ["Dedupe ran against the local store only: no GitHub issue search in this build (dry run)."],
      costUsd: 0,
      nextCluster: 0,
    };
    const code = codeContext(cfg);
    if (code) {
      run.code = code;
      run.notes.push(`Code connected read-only: ${code.path}${code.commit ? ` at ${code.commit.slice(0, 10)}` : ""}. Agents may Read/Grep it; code pointers are re-checked against the files.`);
    } else run.notes.push("No code connected: root causes stay at the level the analytics data supports.");
    this.active = run;
    this.save(run);
    void this.execute(run).catch((e) => this.fail(run, e));
    return run;
  }

  /** Re-arm parked or interrupted runs after a restart. */
  rearm(): void {
    for (const r of this.d.store.listRuns(5)) {
      if (r.phase === "parked" && r.parkedUntil) {
        this.active = r;
        this.d.tracker.parkedUntil = r.parkedUntil;
        this.armPark(r);
      } else if (r.phase === "root_causing") {
        this.d.log(`resuming interrupted run ${r.id} at cluster ${r.nextCluster}`);
        this.active = r;
        void this.rootCauseLoop(r).catch((e) => this.fail(r, e));
      }
    }
  }

  private save(run: RunRecord): void {
    const { signals, ...rest } = run;
    this.d.store.saveRun(rest as RunRecord);
    this.d.emit({ type: "run.phase", run: publicRun(run) as any });
  }

  private runDir(run: RunRecord): string {
    const dir = join(this.d.home, "runs", run.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private phaseStart(run: RunRecord, phase: PhaseEntry["phase"], note?: string): PhaseEntry {
    const p: PhaseEntry = { phase, status: "running", startedAt: now(), ...(note ? { note } : {}) };
    run.phases.push(p);
    if (phase !== "gating") run.phase = phase as RunRecord["phase"];
    this.save(run);
    return p;
  }

  private phaseEnd(run: RunRecord, p: PhaseEntry, note?: string, status: PhaseEntry["status"] = "done"): void {
    p.status = status;
    p.endedAt = now();
    if (note) p.note = note;
    this.save(run);
  }

  private fail(run: RunRecord, e: unknown): void {
    run.phase = "failed";
    run.error = (e as Error).message ?? String(e);
    run.finishedAt = now();
    this.d.log(`run ${run.id} failed: ${run.error}`);
    this.save(run);
  }

  private salt(): string {
    let s = this.d.store.getKv<string>("install_salt");
    if (!s) {
      s = randomBytes(16).toString("hex");
      this.d.store.setKv("install_salt", s);
    }
    return s;
  }

  private async ctxFor(plugin: Plugin, signal?: AbortSignal): Promise<PluginContext> {
    const cfg = this.d.getConfig();
    const inst = cfg.plugins[plugin.manifest.id];
    return {
      credentials: await this.d.resolveCredentials(plugin.manifest.id),
      options: inst?.options ?? {},
      http: readOnlyHttp(plugin.manifest.id, plugin.readOnlyPostAllowlist ?? [], this.d.log, signal),
      log: (level, msg) => this.d.log(`[${plugin.manifest.id}] ${level}: ${msg}`),
      signal: signal ?? new AbortController().signal,
    };
  }

  private async execute(run: RunRecord): Promise<void> {
    const cfg = this.d.getConfig();
    const dir = this.runDir(run);

    // 1. collect (no LLM)
    const pc = this.phaseStart(run, "collecting", `Reading the last ${run.lookbackHours} h`);
    const signals: Signal[] = [];
    for (const p of this.d.plugins) {
      if (p.manifest.kind !== "source" || cfg.plugins[p.manifest.id]?.enabled === false || !cfg.plugins[p.manifest.id]) continue;
      const before = signals.length;
      try {
        const ctx = await this.ctxFor(p);
        for await (const s of (p as SourcePlugin).source.collect(ctx, run.window)) signals.push(s);
        run.sources.push({ pluginId: p.manifest.id, ok: true, signals: signals.length - before, note: `${signals.length - before} signals` });
      } catch (e) {
        run.sources.push({ pluginId: p.manifest.id, ok: false, signals: 0, note: (e as Error).message });
      }
      this.save(run);
    }
    run.signalsCollected = signals.length;
    run.signals = signals;
    const salt = this.salt();
    writeFileSync(
      join(dir, "signals.jsonl"),
      signals.map((s) => redact(JSON.stringify({ ...s, keys: { ...s.keys, users: undefined, usersHashed: ((s.keys.users as string[]) ?? []).map((u) => hashUser(salt, u)) } }))).join("\n") + "\n",
      { mode: 0o600 },
    );
    this.phaseEnd(run, pc, `${signals.length} signals from ${run.sources.filter((s) => s.ok).length} source${run.sources.length === 1 ? "" : "s"}`);
    if (run.sources.length && run.sources.every((s) => !s.ok)) throw new Error(`every source failed: ${run.sources.map((s) => s.note).join("; ")}`);

    // 2. correlate (deterministic)
    const pr = this.phaseStart(run, "correlating");
    const all = correlate(signals);
    const clusters = this.applyRulings(run, all);
    const floor = cfg.radar.minUsersAffected;
    const keep: Cluster[] = [];
    for (const c of clusters) {
      if (c.usersAffected < floor) {
        run.dropped.push({ clusterId: c.id, clusterTitle: c.title, stage: "floor", reason: `${c.usersAffected} user${c.usersAffected === 1 ? "" : "s"} affected, below the ${floor}-user floor`, usersAffected: c.usersAffected, at: now() });
      } else keep.push(c);
    }
    const cap = cfg.radar.maxFindingsPerRun * 2;
    for (const c of keep.slice(cap)) run.dropped.push({ clusterId: c.id, clusterTitle: c.title, stage: "rank", reason: `ranked below the top ${cap} clusters`, usersAffected: c.usersAffected, at: now() });
    run.clusters = keep.slice(0, cap);
    for (const c of run.clusters)
      run.steps.push({ clusterId: c.id, clusterTitle: c.title, step: "root_cause", status: "queued" });
    const ruledN = all.length - clusters.length;
    this.phaseEnd(run, pr, `${all.length} clusters${ruledN ? ` · ${ruledN} settled by your rulings` : ""} · ${run.clusters.length} above the ${floor}-user floor go to root-cause`);
    writeFileSync(join(dir, "signals.full.json"), JSON.stringify(signals), { mode: 0o600 });
    await this.rootCauseLoop(run);
  }

  private async rootCauseLoop(run: RunRecord): Promise<void> {
    const cfg = this.d.getConfig();
    const dir = this.runDir(run);
    if (!run.signals) {
      const p = join(dir, "signals.full.json");
      run.signals = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Signal[]) : [];
    }
    let pr = run.phases.find((p) => p.phase === "root_causing" && p.status === "running");
    if (!pr) pr = this.phaseStart(run, "root_causing", `${run.clusters.length} clusters`);
    run.phase = "root_causing";
    this.d.tracker.parkedUntil = null;
    run.parkedUntil = undefined as any;
    this.save(run);

    for (let i = run.nextCluster; i < run.clusters.length; i++) {
      const c = run.clusters[i]!;
      this.d.tracker.queued = run.clusters.length - i - 1;
      const parked = await this.processCluster(run, c, i, dir);
      if (parked) return;
      run.nextCluster = i + 1;
      this.save(run);
    }
    this.d.tracker.queued = 0;
    this.d.emit({ type: "window.updated", window: this.d.tracker.status() });
    this.phaseEnd(run, pr, `${run.findings} finding${run.findings === 1 ? "" : "s"} passed the gate`);
    const pd = this.phaseStart(run, "ready");
    if (run.findings === 0) run.emptyReason = emptyReason(run, cfg.radar.minUsersAffected);
    this.phaseEnd(run, pd, run.findings ? `${run.findings} in the feed` : "honest empty result");
    run.phase = "done";
    run.finishedAt = now();
    this.save(run);
    this.d.log(`run ${run.id} done: ${run.findings} findings, ${run.dropped.length} dropped, $${run.costUsd.toFixed(2)}`);
  }

  private step(run: RunRecord, c: Cluster, kind: StepEntry["step"]): StepEntry {
    let s = run.steps.find((x) => x.clusterId === c.id && x.step === kind);
    if (!s) {
      s = { clusterId: c.id, clusterTitle: c.title, step: kind, status: "queued" };
      run.steps.push(s);
    }
    s.status = "running";
    s.startedAt = now();
    this.save(run);
    return s;
  }

  private endStep(run: RunRecord, s: StepEntry, status: StepEntry["status"], note?: string): void {
    s.status = status;
    s.endedAt = now();
    if (note) s.note = note;
    this.save(run);
  }

  private park(run: RunRecord, s: StepEntry, resumeAt: string | null, why: string): boolean {
    const until = resumeAt ?? new Date(Date.now() + 30 * 60_000).toISOString();
    this.endStep(run, s, "parked", why);
    run.phase = "parked";
    run.parkedUntil = until;
    this.d.tracker.parkedUntil = until;
    this.save(run);
    this.armPark(run);
    return true;
  }

  private armPark(run: RunRecord): void {
    if (this.parkTimer) clearTimeout(this.parkTimer);
    const ms = Math.max(1000, Date.parse(run.parkedUntil!) - Date.now() + 60_000);
    this.d.log(`run ${run.id} parked until ${run.parkedUntil}; one timer armed, no child process`);
    this.parkTimer = setTimeout(() => void this.rootCauseLoop(run).catch((e) => this.fail(run, e)), ms);
  }

  /** Runs one governor-admitted agent step; returns null when parked. */
  private async agent(run: RunRecord, s: StepEntry, kind: "root_cause" | "adversarial", prompt: string, cwd: string, resumeSessionId?: string): Promise<ClaudeRunResult | null> {
    const cfg = this.d.getConfig();
    const tr = this.d.tracker;
    if (tr.isStale(cfg.governor.staleAfterMin)) {
      const probe = await runClaude({ prompt: "Reply with the single word ok.", cwd, model: "haiku", maxTurns: 1, env: await this.d.runnerEnv(), tools: [] });
      for (const r of probe.rateLimits) tr.ingest(r, run.id);
      this.d.emit({ type: "window.updated", window: tr.status() });
    }
    const adm = tr.admit(kind);
    if (!adm.admit) {
      this.park(run, s, adm.resumeAt, `window ${adm.usedPct}% used + ~${adm.estimatePct}% for this step > ${adm.ceilingPct}% ceiling (your ${100 - adm.ceilingPct}% reserve); resumes at reset`);
      return null;
    }
    const before = tr.reading()?.fiveHourPct;
    const model = this.d.model ?? "opus";
    s.model = model;
    const res = await runClaude({
      prompt,
      cwd,
      model,
      maxTurns: 14,
      env: await this.d.runnerEnv(),
      transcriptPath: join(cwd, `${kind}${resumeSessionId ? ".repair" : ""}.transcript.jsonl`),
      ...(run.code ? { addDirs: [run.code.path] } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    for (const r of res.rateLimits) tr.ingest(r, run.id);
    const after = tr.reading()?.fiveHourPct;
    s.costUsd = res.costUsd;
    run.costUsd += res.costUsd;
    this.d.store.addUsage(tr.status().authSource, "step", run.id, {
      kind,
      model: res.model,
      costUsd: res.costUsd,
      durationMs: res.durationMs,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      windowDeltaPct: before !== undefined && after !== undefined ? Math.round((after - before) * 10) / 10 : null,
    });
    this.d.emit({ type: "window.updated", window: tr.status() });
    if (res.limitHit) {
      this.park(run, s, tr.status().resetsAt, "usage limit hit mid-step; result discarded, resumes at reset");
      return null;
    }
    return res;
  }

  private async parseWithRepair<T>(
    run: RunRecord,
    s: StepEntry,
    kind: "root_cause" | "adversarial",
    res: ClaudeRunResult,
    cwd: string,
    schema: { safeParse: (x: unknown) => { success: boolean; data?: T; error?: { message: string } } },
  ): Promise<T | null | "parked"> {
    const tryParse = (text: string) => {
      try {
        const r = schema.safeParse(extractJson(text));
        return r.success ? { ok: true as const, data: r.data as T } : { ok: false as const, err: r.error!.message };
      } catch (e) {
        return { ok: false as const, err: (e as Error).message };
      }
    };
    let p = tryParse(res.text);
    if (p.ok) return p.data;
    if (!res.sessionId) return null;
    // One repair retry, same session.
    const rep = await this.agent(run, s, kind, `Your answer did not validate: ${p.err.slice(0, 800)}\nReply again with ONLY the corrected JSON object.`, cwd, res.sessionId);
    if (!rep) return "parked";
    p = tryParse(rep.text);
    return p.ok ? p.data : null;
  }

  private async processCluster(run: RunRecord, c: Cluster, idx: number, dir: string): Promise<boolean> {
    const cfg = this.d.getConfig();
    const cdir = join(dir, `c${idx + 1}`);
    const bundle = await this.buildBundle(run, c, cdir);

    // root-cause
    const s1 = this.step(run, c, "root_cause");
    const r1 = await this.agent(run, s1, "root_cause", rootCausePrompt(cfg.radar.minUsersAffected, run.code), cdir);
    if (!r1) return true;
    if (!r1.ok) {
      this.endStep(run, s1, "failed", r1.error ?? "agent failed");
      run.dropped.push({ clusterId: c.id, clusterTitle: c.title, stage: "root_cause", reason: `agent step failed: ${r1.error}`, usersAffected: c.usersAffected, at: now() });
      return false;
    }
    const draft = await this.parseWithRepair<Draft>(run, s1, "root_cause", r1, cdir, DraftSchema as any);
    if (draft === "parked") return true;
    writeFileSync(join(cdir, "draft.json"), JSON.stringify(draft, null, 2));
    if (!draft) {
      this.endStep(run, s1, "dropped", "answer failed schema validation twice");
      run.dropped.push({ clusterId: c.id, clusterTitle: c.title, stage: "root_cause", reason: "the agent's answer failed schema validation twice", usersAffected: c.usersAffected, at: now() });
      return false;
    }
    if (draft.verdict === "no_finding") {
      this.endStep(run, s1, "dropped", draft.reason);
      run.dropped.push({ clusterId: c.id, clusterTitle: c.title, stage: "root_cause", reason: `agent declined: ${draft.reason}`, usersAffected: c.usersAffected, at: now() });
      return false;
    }
    this.endStep(run, s1, "passed", draft.title);

    // deterministic gate
    const s2 = this.step(run, c, "gate");
    const gate = deterministicGate(draft, bundle, c, cfg.radar.minUsersAffected, run.code);
    if (!gate.ok) {
      this.endStep(run, s2, "dropped", gate.reason);
      run.dropped.push({ clusterId: c.id, clusterTitle: c.title, stage: "gate", reason: gate.reason, usersAffected: c.usersAffected, title: draft.title ?? "", at: now() });
      return false;
    }
    this.endStep(run, s2, "passed", gate.note);

    // adversarial
    const s3 = this.step(run, c, "adversarial");
    const r3 = await this.agent(run, s3, "adversarial", adversarialPrompt(JSON.stringify(draft, null, 2), run.code), cdir);
    if (!r3) return true;
    const review = r3.ok ? await this.parseWithRepair<Review>(run, s3, "adversarial", r3, cdir, ReviewSchema as any) : null;
    if (review === "parked") return true;
    writeFileSync(join(cdir, "review.json"), JSON.stringify(review, null, 2));
    if (!review || review.verdict === "broken") {
      const why = review ? review.reasons.join(" ") : `review step failed: ${r3.error ?? "unparseable answer"}`;
      this.endStep(run, s3, "dropped", why);
      run.dropped.push({ clusterId: c.id, clusterTitle: c.title, stage: "adversarial", reason: why, usersAffected: c.usersAffected, title: draft.title ?? "", at: now() });
      return false;
    }
    this.endStep(run, s3, "passed", review.verdict === "holds" ? "holds as written" : `partly: ${review.reasons[0]}`);

    // dedupe (local store; no GitHub search in this build)
    const s4 = this.step(run, c, "dedupe");
    const finding = assembleFinding(run, c, draft, review, bundle);
    const resurfaced = run.ruled?.some((r) => r.clusterId === c.id && (r.outcome === "resurfaced" || r.outcome === "escalated"));
    const rule = resurfaced ? undefined : this.d.store.dismissRule(finding.dedupe.fingerprint);
    if (rule) {
      this.endStep(run, s4, "dropped", `dismissed earlier: ${rule.reason}`);
      run.dropped.push({ clusterId: c.id, clusterTitle: c.title, stage: "dedupe", reason: `suppressed by a dismiss rule: ${rule.reason}`, usersAffected: c.usersAffected, title: finding.title, at: now() });
      return false;
    }
    const prior = this.d.store.findingsByFingerprint(finding.dedupe.fingerprint).filter((f) => f.runId !== run.id);
    if (prior.length) (finding as any).recurredFrom = prior[0]!.id;
    this.endStep(run, s4, "passed", prior.length ? `recurred: matches ${prior[0]!.id}` : "new: no match in the local store");
    this.d.store.saveFinding(finding);
    run.findings++;
    run.findingIds.push(finding.id);
    if (!(run as any).firstFindingAt) (run as any).firstFindingAt = now();
    this.save(run);
    this.d.emit({ type: "finding.new", finding });
    return false;
  }

  /**
   * Rulings are ground truth and run before any agent spend. Per cluster, the ruling in force decides:
   * - Dismiss: suppressed. It comes back only if the impact escalates (at least twice the people, and 2 more, than when dismissed).
   * - Not now: stays parked until a run sees an occurrence after the ruling; then it resurfaces in New and is re-investigated.
   * - File: tracked for recurrence. An occurrence after filing re-investigates it as a recurrence; otherwise it is skipped.
   * - No ruling yet, but already in the feed: not re-investigated. New occurrences refresh the card's impact numbers.
   */
  applyRulings(run: RunRecord, clusters: Cluster[]): Cluster[] {
    const store = this.d.store;
    const ruled: RuledEntry[] = (run.ruled = []);
    const after = (c: Cluster, iso?: string) => !!iso && Date.parse(c.lastSeen) > Date.parse(iso);
    const findings = store.listFindings();
    const keep: Cluster[] = [];
    const add = (c: Cluster, outcome: RuledEntry["outcome"], note: string) => ruled.push({ clusterId: c.id, clusterTitle: c.title, outcome, note, at: now() });
    for (const c of clusters) {
      const r = store.currentRuling(c.id);
      if (r?.ruling === "dismiss") {
        const base = r.usersAtRuling ?? 0;
        if (base && c.usersAffected >= Math.max(base * 2, base + 2)) {
          store.addRuling({ clusterId: c.id, ruling: "resurfaced", reason: null, by: "radar", note: `${c.usersAffected} people now, ${base} when you dismissed it`, title: c.title });
          if (r.fingerprint) store.removeDismissRule(r.fingerprint);
          add(c, "escalated", `dismissed ${shortDate(r.at)}, but ${c.usersAffected} people are affected now (${base} then): back in New and re-investigated`);
          keep.push(c);
        } else add(c, "suppressed", `dismissed ${shortDate(r.at)}: "${r.reason}". Not re-investigated.`);
        continue;
      }
      if (r?.ruling === "park") {
        if (after(c, r.at)) {
          store.addRuling({ clusterId: c.id, ruling: "resurfaced", reason: null, by: "radar", note: `new occurrence ${shortDate(c.lastSeen)}, after you parked it`, title: c.title });
          add(c, "resurfaced", `parked ${shortDate(r.at)}; a new occurrence on ${shortDate(c.lastSeen)} brings it back to New`);
          keep.push(c);
        } else add(c, "parked", `parked ${shortDate(r.at)}; last occurrence ${shortDate(c.lastSeen)}, nothing new since your ruling. Stays parked.`);
        continue;
      }
      if (r?.ruling === "file") {
        if (after(c, r.at)) {
          add(c, "recurred_after_filing", `filed ${shortDate(r.at)}; seen again ${shortDate(c.lastSeen)}: re-investigated as a recurrence`);
          keep.push(c);
        } else add(c, "already_filed", `filed ${shortDate(r.at)}; no occurrence since. Not re-investigated.`);
        continue;
      }
      const open = findings.find((f: any) => f.clusterId === c.id && f.status === "new");
      if (open) {
        const fresh = after(c, open.impact.lastSeen);
        if (fresh) {
          (open as any).impact = { ...open.impact, usersAffected: c.usersAffected, occurrences: c.occurrences, lastSeen: c.lastSeen, trend: c.trend };
          (open as any).refreshedBy = { runId: run.id, at: now() };
          store.saveFinding(open);
          this.d.emit({ type: "finding.updated", finding: open });
        }
        add(c, "awaiting_ruling", fresh ? `already in your feed; impact refreshed to ${c.usersAffected} people, ${c.occurrences} occurrences. Not re-investigated.` : "already in your feed, waiting for your ruling. Not re-investigated.");
        continue;
      }
      keep.push(c);
    }
    const n = (o: RuledEntry["outcome"]) => ruled.filter((x) => x.outcome === o);
    const titles = (xs: RuledEntry[]) => xs.map((x) => x.clusterTitle).join("; ");
    if (n("suppressed").length) run.notes.push(`${n("suppressed").length} suppressed by ruling: ${titles(n("suppressed"))}. Dismissed items stay out unless their impact escalates.`);
    if (n("parked").length) run.notes.push(`${n("parked").length} parked by ruling, checked for new evidence: no occurrence after your ruling, so ${n("parked").length === 1 ? "it stays" : "they stay"} parked (${titles(n("parked"))}). A parked item resurfaces in New the first time a run sees an occurrence after you parked it.`);
    if (n("resurfaced").length) run.notes.push(`${n("resurfaced").length} resurfaced from Parked on new evidence: ${titles(n("resurfaced"))}.`);
    if (n("escalated").length) run.notes.push(`${n("escalated").length} dismissed item came back because its impact escalated: ${titles(n("escalated"))}.`);
    const settled = [...n("already_filed"), ...n("awaiting_ruling")];
    if (settled.length) run.notes.push(`${settled.length} already in your feed or filed, not re-investigated (no agent spend): ${titles(settled)}.`);
    return keep;
  }

  /** Writes cluster.md + evidence/*.txt. Evidence ids: S# = signal aggregates, T# = session timelines. */
  private async buildBundle(run: RunRecord, c: Cluster, cdir: string): Promise<Bundle> {
    mkdirSync(join(cdir, "evidence"), { recursive: true, mode: 0o700 });
    const salt = this.salt();
    const sigs = (run.signals ?? []).filter((s) => c.signalIds.includes(s.id));
    const ev: Bundle["evidence"] = new Map();
    const md: string[] = [
      `# Cluster: ${c.title}`,
      "",
      `Window: ${run.window.from} to ${run.window.to} (${run.lookbackHours} h). Source: PostHog (read-only). Team members' own activity and the project's test-account filters were excluded before counting.`,
      `Distinct users affected (deterministic count): ${c.usersAffected}. Occurrences: ${c.occurrences}. Trend vs the previous window: ${c.trend}.`,
      "",
      "## Evidence files",
    ];
    sigs.forEach((s, i) => {
      const id = `S${i + 1}`;
      const ex = s.excerpt as Record<string, unknown>;
      const text = redact(
        [`[${id}] ${s.title}`, `type: ${s.type}`, `occurrences: ${s.count}`, `distinct users: ${s.usersAffected ?? "unknown"}`, `first seen: ${s.firstSeen}`, `last seen: ${s.lastSeen}`, ...Object.entries(ex ?? {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? "\n  - " + v.join("\n  - ") : String(v)}`)].join("\n"),
      );
      writeFileSync(join(cdir, "evidence", `${id}.txt`), text + `\nlink: ${s.url}\n`);
      ev.set(id, { id, url: s.url, kind: s.type === "error_group" ? "error_group" : "event_series", text });
      md.push(`- evidence/${id}.txt: ${s.title} (aggregate over the window)`);
    });
    // Session timelines for the sample sessions behind the cluster.
    const sessions = [...new Set(sigs.flatMap((s) => (s.keys.sessions as string[]) ?? []))].slice(0, 5);
    const ph = this.d.plugins.find((p) => p.manifest.id === "posthog") as SourcePlugin | undefined;
    if (ph?.source.expand && sessions.length) {
      try {
        const exp = (await ph.source.expand(await this.ctxFor(ph), sessions.join(","))) as {
          sessions: { sessionId: string; distinctId: string; hasRecording: boolean; url: string; events: { t: string; event: string; path: string; el: string; err: string; action?: string }[] }[];
        };
        let n = 0;
        for (const s of exp.sessions) {
          if (!s.events.length) continue;
          n++;
          const id = `T${n}`;
          const user = hashUser(salt, s.distinctId);
          const focus = s.events.findIndex((e) => ["$rageclick", "$dead_click", "$dead_swipe", "$exception"].includes(e.event) && c.route && e.path && normalizeLike(e.path) === c.route);
          const start = Math.max(0, (focus < 0 ? 0 : focus) - 25);
          const slice = s.events.slice(start, start + 60);
          const lines = slice.map((e) => `${e.t.replace("T", " ").slice(0, 19)}  ${e.event.padEnd(14)} ${e.path}${e.action ? `  [${e.action}]` : ""}${e.el ? `  el="${e.el}"` : ""}${e.err ? `  error="${e.err}"` : ""}`);
          const text = redact(
            [`[${id}] Session timeline, user ${user}, ${s.events.length} events in session (showing ${slice.length})`, `recording: ${s.hasRecording ? "yes" : "no (link opens the person's event list)"}`, "", ...lines].join("\n"),
          );
          writeFileSync(join(cdir, "evidence", `${id}.txt`), text + `\nlink: ${s.url}\n`);
          ev.set(id, { id, url: s.url, kind: s.hasRecording ? "recording" : "event_series", text });
          md.push(`- evidence/${id}.txt: what user ${user} did around the problem (session timeline)`);
        }
      } catch (e) {
        md.push(`- (session timelines unavailable: ${(e as Error).message})`);
      }
    }
    md.push("", "Read every evidence file before answering.");
    writeFileSync(join(cdir, "cluster.md"), md.join("\n") + "\n");
    return { evidence: ev };
  }
}

interface Bundle {
  evidence: Map<string, { id: string; url: string; kind: Evidence["kind"]; text: string }>;
}

function normalizeLike(path: string): string {
  return path
    .split("/")
    .map((seg) => (/^[0-9a-f]{16,}$/i.test(seg) || /^[0-9a-f-]{32,36}$/i.test(seg) || /^\d{3,}$/.test(seg) || (seg.length > 24 && /\d/.test(seg)) ? ":id" : seg))
    .join("/") || "/";
}

export function correlate(signals: readonly Signal[]): Cluster[] {
  const groups = new Map<string, Signal[]>();
  for (const s of signals) {
    const key = s.type === "error_group" ? `fp:${String(s.keys.fingerprint)}` : `route:${String(s.keys.route ?? s.id)}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out: Cluster[] = [];
  for (const [key, sigs] of groups) {
    const users = new Set(sigs.flatMap((s) => (s.keys.users as string[]) ?? []));
    const occurrences = sigs.reduce((a, s) => a + s.count, 0);
    const prevUsers = sigs.reduce((a, s) => a + Number((s.excerpt as any)?.previousWindowUsers ?? 0), 0);
    const trend: Cluster["trend"] = prevUsers === 0 ? "new" : users.size > prevUsers * 1.5 ? "rising" : users.size < prevUsers * 0.5 ? "falling" : "steady";
    const route = sigs[0]!.keys.route as string | undefined;
    const kinds = [...new Set(sigs.map((s) => s.title.split(" on ")[0]!.replace(/ \(.*\)$/, "").toLowerCase()))];
    const joined = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : kinds[0];
    const title = route ? `${joined} on ${route}` : sigs[0]!.title;
    out.push({
      id: "c_" + createHash("sha1").update(key).digest("hex").slice(0, 8),
      key,
      title: title.charAt(0).toUpperCase() + title.slice(1),
      ...(route ? { route } : {}),
      usersAffected: users.size,
      occurrences,
      trend,
      score: users.size * (trend === "new" || trend === "rising" ? 1.5 : trend === "falling" ? 0.6 : 1),
      signalIds: sigs.map((s) => s.id),
      firstSeen: sigs.map((s) => s.firstSeen).sort()[0]!,
      lastSeen: sigs.map((s) => s.lastSeen).sort().at(-1)!,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.occurrences - a.occurrences);
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Repo checkout from config (radar.repo.path), with the commit it is at. Read-only: git rev-parse only. */
export function codeContext(cfg: Config): CodeContext | undefined {
  const p = cfg.radar.repo?.path;
  if (!p || !existsSync(p) || !statSync(p).isDirectory()) return undefined;
  const root = realpathSync(p);
  let commit: string | undefined;
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    /* not a git checkout: pointers still work, without a commit */
  }
  const repo = cfg.plugins.github?.credentials?.repo;
  return { path: root, ...(commit ? { commit } : {}), ...(typeof repo === "string" && repo ? { repo } : {}) };
}

/** Re-finds a code pointer in the checkout: path stays inside the repo, the quoted line is at (or within 2 lines of) the cited line. */
export function checkCodePointer(code: CodeContext, ptr: { path: string; line: number; text: string }): { ok: true; line: number } | { ok: false; reason: string } {
  const rel = isAbsolute(ptr.path) ? relative(code.path, ptr.path) : ptr.path;
  const abs = resolve(code.path, rel);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(abs)) return { ok: false, reason: `code pointer ${ptr.path} is not a file in the repo` };
  const real = realpathSync(abs);
  if (relative(code.path, real).startsWith("..") || !statSync(real).isFile()) return { ok: false, reason: `code pointer ${ptr.path} leaves the repo` };
  const lines = readFileSync(real, "utf8").split("\n");
  const want = squash(ptr.text);
  for (const delta of [0, -1, 1, -2, 2]) {
    const n = ptr.line + delta;
    if (n >= 1 && n <= lines.length && squash(lines[n - 1]!).includes(want)) return { ok: true, line: n };
  }
  return { ok: false, reason: `code pointer ${rel}:${ptr.line} not found verbatim: "${ptr.text.slice(0, 80)}"` };
}

export function deterministicGate(d: Draft, b: Bundle, c: Cluster, floor: number, code?: CodeContext): { ok: true; note: string } | { ok: false; reason: string } {
  if (!d.title || !d.symptom || !d.rootCause || !d.reproduction || !d.fingerprint || !d.severity || !d.confidence || !d.openQuestions)
    return { ok: false, reason: "a required field is empty (title, symptom, rootCause, reproduction, fingerprint, severity, confidence or openQuestions)" };
  const cited = new Set(d.rootCause.reasoning.flatMap((r) => r.evidenceIds));
  for (const id of cited) if (!b.evidence.has(id)) return { ok: false, reason: `cites evidence ${id}, which is not in the bundle` };
  if (cited.size < 2) return { ok: false, reason: `only ${cited.size} evidence item cited; at least 2 are required` };
  for (const id of cited) if (!b.evidence.get(id)!.url) return { ok: false, reason: `evidence ${id} has no URL` };
  let quotes = 0;
  for (const r of d.rootCause.reasoning) {
    for (const q of r.quotes) {
      const e = b.evidence.get(q.evidenceId);
      if (!e) return { ok: false, reason: `quote cites ${q.evidenceId}, which is not in the bundle` };
      if (!squash(e.text).includes(squash(q.text))) return { ok: false, reason: `quote not found verbatim in ${q.evidenceId}: "${q.text.slice(0, 80)}"` };
      quotes++;
    }
  }
  if (c.usersAffected < floor && d.severity !== "critical") return { ok: false, reason: `${c.usersAffected} users affected, below the ${floor}-user floor` };
  let ptrs = 0;
  if (d.codePointers?.length) {
    if (!code) return { ok: false, reason: "cites code pointers but no code is connected" };
    for (const ptr of d.codePointers) {
      const r = checkCodePointer(code, ptr);
      if (!r.ok) return { ok: false, reason: r.reason };
      ptr.line = r.line;
      if (isAbsolute(ptr.path)) ptr.path = relative(code.path, ptr.path);
      ptrs++;
    }
  }
  return { ok: true, note: `${cited.size} evidence items, ${quotes} quotes re-found verbatim${code ? `, ${ptrs} code pointer${ptrs === 1 ? "" : "s"} re-found in the repo` : ""}, ${c.usersAffected} users ≥ floor ${floor}` };
}

function assembleFinding(run: RunRecord, c: Cluster, d: Draft, review: Review, b: Bundle): Finding {
  const rw = review.verdict === "partly" ? review.rewrite ?? {} : {};
  const cited = [...new Set(d.rootCause!.reasoning.flatMap((r) => r.evidenceIds))].sort((a, z) => a.localeCompare(z, "en", { numeric: true }));
  const evidence: Evidence[] = cited.map((id) => {
    const e = b.evidence.get(id)!;
    const quote = d.rootCause!.reasoning.flatMap((r) => r.quotes).find((q) => q.evidenceId === id)?.text;
    const label = e.text.split("\n")[0]!.replace(/^\[\w+\]\s*/, "");
    return { id, sourcePluginId: "posthog", kind: e.kind, url: e.url, excerpt: redact(quote ?? label), observedAt: run.startedAt, label } as Evidence;
  });
  const fp = d.fingerprint!;
  const f: Finding & Record<string, unknown> = {
    id: "f_" + createHash("sha1").update(fp + run.id).digest("hex").slice(0, 10),
    runId: run.id,
    title: rw.title ?? d.title!,
    severity: rw.severity ?? d.severity!,
    confidence: rw.confidence ?? (review.verdict === "partly" ? "likely" : d.confidence!),
    symptom: d.symptom!,
    impact: { usersAffected: c.usersAffected, occurrences: c.occurrences, firstSeen: c.firstSeen, lastSeen: c.lastSeen, trend: c.trend },
    rootCause: {
      statement: rw.statement ?? d.rootCause!.statement,
      reasoning: d.rootCause!.reasoning.map((r) => ({ claim: r.claim, evidenceIds: r.evidenceIds })),
      ...(d.codePointers?.length
        ? {
            codePointers: d.codePointers.map((p) => ({
              path: p.path,
              line: p.line,
              text: p.text.trim(),
              why: p.why,
              ...(run.code?.commit ? { commit: run.code.commit } : {}),
              ...(run.code?.repo ? { url: `https://github.com/${run.code.repo}/blob/${run.code.commit ?? "HEAD"}/${p.path}#L${p.line}` } : {}),
            })),
          }
        : {}),
      ruledOut: d.rootCause!.ruledOut,
    },
    evidence,
    reproduction: d.reproduction!,
    ...(d.suggestedFix ? { suggestedFix: d.suggestedFix } : {}),
    openQuestions: [...(d.openQuestions ?? []), ...(rw.addOpenQuestions ?? [])],
    dedupe: { fingerprint: fp },
    status: "new",
    createdAt: new Date().toISOString(),
    route: c.route,
    clusterId: c.id,
    review: { verdict: review.verdict, reasons: review.reasons },
  };
  return f;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

function emptyReason(run: RunRecord, floor: number): string {
  const floorN = run.dropped.filter((x) => x.stage === "floor").length;
  const rc = run.dropped.filter((x) => x.stage !== "floor" && x.stage !== "rank");
  const src = run.sources.filter((s) => s.ok).map((s) => s.pluginId).join(", ") || "no source";
  const days = run.lookbackHours % 24 === 0 ? `${run.lookbackHours / 24} days` : `${run.lookbackHours} hours`;
  const by: Record<string, string> = { root_cause: "the root-cause agent", gate: "the evidence gate", adversarial: "the adversarial review", dedupe: "dedupe" };
  const parts = [`${run.signalsCollected} signals from ${src} over the last ${days}`];
  if (run.ruled?.length) parts.push(`${run.ruled.length} already settled by your rulings or waiting in your feed`);
  if (floorN) parts.push(`${floorN} ${floorN === 1 ? "pattern" : "patterns"} touched fewer than ${floor} people`);
  for (const [stage, who] of Object.entries(by)) {
    const n = rc.filter((x) => x.stage === stage).length;
    if (n) parts.push(`${n} investigated and dropped by ${who}`);
  }
  return `${parts.join("; ")}. Each drop and its reason is in the cockpit's Dropped tab.`;
}

export function publicRun(run: RunRecord): Omit<RunRecord, "signals"> {
  const { signals, ...rest } = run;
  return rest;
}
