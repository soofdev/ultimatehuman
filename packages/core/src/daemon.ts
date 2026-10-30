import { watch } from "node:fs";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Plugin } from "@ultimatehuman/sdk";
import type { Config } from "./config/schema";
import JSON5 from "json5";
import { configJsonSchema, MODEL_CHOICES, MODEL_STAGES, DEFAULT_MODEL } from "./config/schema";
import { loadConfig, loadRawConfig, writeConfig, defaultConfigPath, resolveSecretRefs, type SecretRefValue } from "./config/load";
import { ensureHome, controlKey } from "./home";
import { Store } from "./store/store";
import { WindowTracker } from "./governor/tracker";
import { Radar, publicRun } from "./radar/engine";
import { renderIssue } from "./radar/issue";
import { startServer, type RunningServer } from "./server/http";
import { buildCockpit, backfillFindingClusters } from "./cockpit";
import { Instructions, InstructionError, BRIEFS, RAILS, BRIEF_IDS, lineDiff, estimateTokens, validateBrief, type BriefId } from "./instructions/instructions";
import { ruleProposal } from "./instructions/proposals";
import { Notifier } from "./notify/notifier";
import { gradeSetup, gradeProbes } from "./setup/grade";

export interface DaemonHandle {
  server: RunningServer;
  radar: Radar;
  stop(): Promise<void>;
}

export interface DaemonOptions {
  plugins: readonly Plugin[];
  staticDir: string | null;
  version: string;
}

/**
 * Daemon entry: config, store (schema created at startup), governor, radar,
 * local HTTP + WS server. Parked runs are re-armed from the store on boot.
 */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const home = ensureHome();
  const configPath = defaultConfigPath();
  let config: Config = await loadConfig(configPath);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(config.server.host);
  if (!loopback && !config.server.allowRemote) throw new Error(`refusing to bind ${config.server.host}: set server.allowRemote or use an SSH tunnel`);

  const logFile = join(home, "logs", "daemon.log");
  const log = (m: string) => appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
  const store = new Store(home);
  const backfilled = backfillFindingClusters(store);
  if (backfilled) log(`linked ${backfilled} older finding${backfilled === 1 ? "" : "s"} to ${backfilled === 1 ? "its" : "their"} cluster`);
  // Instruction briefs (SPEC 7b): provisioned by the engine on boot; radar.minUsersAffected only seeds the first version.
  const instructions = new Instructions(home, () => ({ minUsersAffected: config.radar.minUsersAffected }));
  instructions.ensure();
  const src = config.auth.sources[0]!;
  const tracker = new WindowTracker(store, src.id, src.kind === "anthropic_api_key" ? "api_key" : "subscription", config.governor.humanReservePct);

  const resolveCredentials = async (pluginId: string) => {
    const inst = config.plugins[pluginId];
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(inst?.credentials ?? {})) out[k] = await resolveSecretRefs(v as SecretRefValue, configPath);
    return out;
  };
  const runnerEnv = async (): Promise<Record<string, string>> => {
    if (src.kind === "claude_oauth_token") return { CLAUDE_CODE_OAUTH_TOKEN: await resolveSecretRefs(src.token as SecretRefValue, configPath) };
    if (src.kind === "anthropic_api_key") return { ANTHROPIC_API_KEY: await resolveSecretRefs(src.apiKey as SecretRefValue, configPath) };
    return {};
  };

  let server: RunningServer | null = null;
  const notifier = new Notifier({ plugins: opts.plugins, getConfig: () => config, configPath, log });
  const emit = (ev: unknown) => {
    server?.broadcast(ev);
    notifier.handle(ev as any);
  };
  const radar = new Radar({
    home,
    store,
    getConfig: () => config,
    plugins: opts.plugins,
    resolveCredentials,
    runnerEnv,
    tracker,
    instructions,
    emit,
    log,
    ...(process.env.ULTIMATEHUMAN_MODEL ? { model: process.env.ULTIMATEHUMAN_MODEL } : {}),
  });

  const output = () => opts.plugins.find((p) => p.manifest.kind === "output" && config.plugins[p.manifest.id]);
  const issueFor = (id: string) => {
    const f = store.getFinding(id);
    if (!f) return null;
    const o = output();
    const labels = ((o && (config.plugins[o.manifest.id]?.options?.labels as string[])) ?? ["ultimatehuman"]) as string[];
    const repo = o ? String(config.plugins[o.manifest.id]?.credentials?.repo ?? "") : "";
    return { f, issue: renderIssue(f, labels), repo, dryRun: o ? config.plugins[o.manifest.id]?.options?.dryRun !== false : true };
  };

  /** Records a ruling on a cluster (finding or dropped draft) and keeps the finding and the fingerprint rule in step. */
  const rule = (clusterId: string, ruling: "file" | "dismiss" | "park" | "clear", reason: string | null, extra: Record<string, unknown> = {}) => {
    const f = store.listFindings().find((x: any) => x.clusterId === clusterId) as (Finding & Record<string, any>) | undefined;
    let users: number | undefined = f?.impact.usersAffected;
    let title = f?.title;
    if (!f) {
      for (const run of store.listRuns(30)) {
        const d = run.dropped?.find((x) => x.clusterId === clusterId);
        if (d) {
          users = d.usersAffected ?? run.clusters.find((c) => c.id === clusterId)?.usersAffected ?? Number(/^(\d+) user/.exec(d.reason)?.[1] ?? 0);
          title = d.title ?? d.clusterTitle;
          break;
        }
      }
    }
    const prev = store.currentRuling(clusterId);
    const r = store.addRuling({
      clusterId,
      ruling,
      reason,
      by: "you",
      ...(f ? { findingId: f.id, fingerprint: f.dedupe.fingerprint, lastSeenAtRuling: f.impact.lastSeen } : {}),
      ...(users !== undefined ? { usersAtRuling: users } : {}),
      ...(title ? { title } : {}),
      ...extra,
    });
    if (f) {
      if (ruling === "dismiss") {
        f.status = "dismissed";
        f.dismissReason = reason;
        store.addDismissRule(f.dedupe.fingerprint, reason!);
      } else if (f.status === "dismissed" || f.status === "filed") {
        f.status = ruling === "file" && !extra.dryRun ? "filed" : "new";
        if (prev?.ruling === "dismiss") store.removeDismissRule(f.dedupe.fingerprint);
      }
      store.saveFinding(f);
      emit({ type: "finding.updated", finding: f });
    }
    emit({ type: "ruling", ruling: r });
    log(`ruling: ${ruling} on ${clusterId}${reason ? ` (${reason})` : ""}`);
    return r;
  };
  const dryRunOutput = () => {
    const o = output();
    return { dryRun: o ? config.plugins[o.manifest.id]?.options?.dryRun !== false : true, repo: o ? String(config.plugins[o.manifest.id]?.credentials?.repo ?? "") : "" };
  };

  /** Dashboard edits: patch the file as written (not the defaulted config), validate, write, and use it at once. */
  const patchConfig = async (patch: (raw: Record<string, any>) => void) => {
    const raw = JSON5.parse(await loadRawConfig(configPath)) as Record<string, any>;
    patch(raw);
    config = await writeConfig(raw, configPath, "// ultimatehuman config. Secrets are ${ENV_VAR} references only. Edited from the dashboard; every write validates first.");
    emit({ type: "config.updated" });
    return config;
  };

  server = await startServer({
    host: config.server.host,
    port: config.server.port,
    staticDir: opts.staticDir,
    logDir: join(home, "logs"),
    controlKey: controlKey(),
    routes: {
      "GET /api/status": async () => ({
        json: {
          version: opts.version,
          window: tracker.status(),
          lastRun: radar.current() ? publicRun(radar.current()!) : store.listRuns(1)[0] ?? null,
          plugins: opts.plugins.map((p) => ({ id: p.manifest.id, displayName: p.manifest.displayName, kind: p.manifest.kind, configured: !!config.plugins[p.manifest.id] })),
          counts: { new: buildCockpit(store, radar.current(), dryRunOutput()).counts.new },
        },
      }),
      "GET /api/onboarding": async () => ({ json: store.getKv("onboarding") ?? null }),
      "POST /api/onboarding": async (_req, body) => {
        store.setKv("onboarding", body);
        if (body.window && typeof body.window === "object" && !tracker.reading()) {
          tracker.ingest(body.window);
          emit({ type: "window.updated", window: tracker.status() });
        }
        emit({ type: "onboarding.updated", onboarding: body });
        return { json: { ok: true } };
      },
      "GET /api/runs": async () => ({ json: { runs: store.listRuns(30) } }),
      "GET /api/runs/:id": async (_r, _b, p) => {
        const run = radar.current()?.id === p.id ? publicRun(radar.current()!) : store.getRun(p.id!);
        return run ? { json: { run } } : { status: 404, json: { error: "no such run" } };
      },
      "POST /api/runs": async (_r, body) => {
        const run = radar.trigger(body.trigger === "onboarding" ? "onboarding" : "run_now", body.lookbackHours ? Number(body.lookbackHours) : undefined);
        return { json: { run: publicRun(run) } };
      },
      "GET /api/findings": async () => ({ json: { findings: store.listFindings() } }),
      "GET /api/findings/:id": async (_r, _b, p) => {
        const x = issueFor(p.id!);
        return x ? { json: { finding: x.f, issuePreview: x.issue, repo: x.repo, dryRun: x.dryRun } } : { status: 404, json: { error: "no such finding" } };
      },
      "POST /api/findings/:id/file": async (_r, _b, p) => {
        const x = issueFor(p.id!);
        if (!x) return { status: 404, json: { error: "no such finding" } };
        const o = output();
        if (!o) {
          // No issue tracker configured: the pipeline owns its tickets, so "file" just accepts the ticket here.
          const cid = (x.f as any).clusterId as string | undefined;
          if (cid) rule(cid, "file", null, { dryRun: true, repo: "" });
          log(`accepted (no issue tracker configured): ${x.issue.title}`);
          return { json: { dryRun: true, message: "accepted - no issue tracker is configured", issue: x.issue, repo: "" } };
        }
        const ctx = { credentials: await resolveCredentials(o.manifest.id).catch(() => ({ repo: x.repo })), options: config.plugins[o.manifest.id]?.options ?? {}, http: null as any, log: () => {}, signal: new AbortController().signal };
        const filed = await (o as any).output.file(ctx, x.f);
        const rec = { at: new Date().toISOString(), repo: x.repo, ref: filed.ref, title: x.issue.title };
        (x.f as any).dryRunPreview = rec;
        store.saveFinding(x.f);
        log(`dry run: would create issue in ${x.repo}: ${x.issue.title}`);
        const cid = (x.f as any).clusterId as string | undefined;
        if (cid) rule(cid, "file", null, { dryRun: x.dryRun, ref: filed.ref, repo: x.repo });
        else emit({ type: "finding.updated", finding: x.f });
        return { json: { dryRun: true, message: `dry run - would create issue in ${x.repo}`, issue: x.issue, repo: x.repo } };
      },
      "POST /api/findings/:id/dismiss": async (_r, body, p) => {
        const f = store.getFinding(p.id!);
        const reason = String(body.reason ?? "").trim();
        if (!f) return { status: 404, json: { error: "no such finding" } };
        if (!reason) return { status: 400, json: { error: "a one-line reason is required" } };
        const cid = (f as any).clusterId as string | undefined;
        if (cid) rule(cid, "dismiss", reason);
        else {
          f.status = "dismissed";
          (f as any).dismissReason = reason;
          store.saveFinding(f);
          store.addDismissRule(f.dedupe.fingerprint, reason);
          emit({ type: "finding.updated", finding: f });
        }
        return { json: { ok: true } };
      },
      // features.validationGate: promote (validate), hold (later) or dismiss a finding waiting for validation.
      "POST /api/findings/:id/validate": async (_r, body, p) => {
        const f = store.getFinding(p.id!) as (Finding & Record<string, any>) | undefined;
        if (!f) return { status: 404, json: { error: "no such finding" } };
        const action = String(body.action ?? "");
        if (!["validate", "later", "dismiss"].includes(action)) return { status: 400, json: { error: "action must be validate, later or dismiss" } };
        const at = new Date().toISOString();
        if (action === "dismiss") {
          const reason = String(body.note ?? "").trim() || "dismissed at validation";
          f.validation = { state: "dismissed", at };
          store.saveFinding(f);
          if (f.clusterId) rule(f.clusterId, "dismiss", reason);
        } else {
          f.validation = { state: action === "validate" ? "validated" : "later", at };
          store.saveFinding(f);
          emit({ type: "finding.updated", finding: f });
        }
        log(`validation: ${action} on ${f.id}`);
        return { json: { ok: true, finding: store.getFinding(f.id) } };
      },
      "GET /api/cockpit": async () => ({ json: { ...buildCockpit(store, radar.current(), dryRunOutput()), proposals: store.listProposals(30), instructionsVersion: instructions.current().version.version } }),
      "POST /api/rulings": async (_r, body) => {
        const clusterId = String(body.clusterId ?? "");
        const ruling = String(body.ruling ?? "");
        const reason = String(body.reason ?? "").trim();
        if (!/^c_[0-9a-f]{8}$/.test(clusterId)) return { status: 400, json: { error: "unknown item" } };
        if (!["dismiss", "park", "clear"].includes(ruling)) return { status: 400, json: { error: "ruling must be dismiss, park or clear (file goes through File to GitHub)" } };
        if (ruling === "dismiss" && !reason) return { status: 400, json: { error: "a one-line reason is required" } };
        if (reason.length > 500) return { status: 400, json: { error: "keep the reason under 500 characters" } };
        const r = rule(clusterId, ruling as "dismiss" | "park" | "clear", reason || null);
        return { json: { ok: true, ruling: r } };
      },
      "GET /api/usage": async () => ({
        json: {
          window: tracker.status(),
          readings: store.listUsage("rate_limit", 300).map((u) => ({ at: u.at, ...u.data })),
          steps: store.listUsage("step", 300).map((u) => ({ at: u.at, runId: u.runId, ...u.data })),
        },
      }),
      "GET /api/instructions": async () => {
        const cur = instructions.current();
        const runs = store.listRuns(30);
        const usedBy = (v: number) => runs.filter((r) => (r.instructions?.version ?? 0) === v).map((r) => ({ id: r.id, startedAt: r.startedAt, trigger: r.trigger, lookbackHours: r.lookbackHours }));
        const vs = instructions.versions();
        return {
          json: {
            version: cur.version.version,
            ...(cur.warning ? { warning: cur.warning } : {}),
            dir: instructions.dir,
            briefs: BRIEFS.map((b) => ({ ...b, text: cur.version.briefs[b.id], tokens: estimateTokens(cur.version.briefs[b.id]) })),
            rails: RAILS,
            versions: vs.map((v, i) => {
              const prev = vs[i + 1];
              return {
                version: v.version,
                at: v.at,
                by: v.by,
                note: v.note,
                changed: v.changed,
                ...(v.revertOf ? { revertOf: v.revertOf } : {}),
                ...(v.proposalId ? { proposalId: v.proposalId } : {}),
                tokens: BRIEF_IDS.reduce((a, id) => a + estimateTokens(v.briefs[id]), 0),
                diffs: prev ? v.changed.map((id) => ({ brief: id, diff: lineDiff(prev.briefs[id], v.briefs[id]).filter((l) => l.op !== "=") })) : [],
                usedBy: usedBy(v.version),
              };
            }),
          },
        };
      },
      "POST /api/instructions/diff": async (_r, body) => {
        const id = String(body.brief) as BriefId;
        if (!BRIEF_IDS.includes(id)) return { status: 400, json: { error: "unknown brief" } };
        const before = instructions.current().version.briefs[id];
        const text = String(body.text ?? "");
        return { json: { diff: lineDiff(before, text), tokensBefore: estimateTokens(before), tokensAfter: estimateTokens(text), error: validateBrief(id, text) } };
      },
      "POST /api/instructions": async (_r, body) => {
        try {
          const v = instructions.save(String(body.brief) as BriefId, String(body.text ?? ""), String(body.note ?? ""));
          log(`instructions v${v.version} saved: ${v.note}`);
          emit({ type: "instructions.updated", version: v.version });
          return { json: { ok: true, version: v.version } };
        } catch (e) {
          return { status: e instanceof InstructionError ? e.status : 500, json: { error: (e as Error).message } };
        }
      },
      "POST /api/instructions/revert": async (_r, body) => {
        try {
          const v = instructions.revert(Number(body.version), body.note ? String(body.note) : undefined);
          log(`instructions v${v.version}: ${v.note}`);
          emit({ type: "instructions.updated", version: v.version });
          return { json: { ok: true, version: v.version } };
        } catch (e) {
          return { status: e instanceof InstructionError ? e.status : 500, json: { error: (e as Error).message } };
        }
      },
      "GET /api/proposals": async () => ({ json: { proposals: store.listProposals(50) } }),
      "POST /api/proposals/:id/rule": async (_r, body, p) => {
        const ruling = String(body.ruling ?? "");
        const reason = String(body.reason ?? "").trim();
        if (!["apply", "reject", "park"].includes(ruling)) return { status: 400, json: { error: "ruling must be apply, reject or park" } };
        if (reason.length > 500) return { status: 400, json: { error: "keep the reason under 500 characters" } };
        try {
          const out = ruleProposal(store, instructions, p.id!, ruling as "apply" | "reject" | "park", reason || null);
          log(`proposal ${p.id}: ${ruling}${out.version ? ` -> instructions v${out.version.version}` : ""}${reason ? ` (${reason})` : ""}`);
          emit({ type: "ruling", proposal: out.proposal });
          if (out.version) emit({ type: "instructions.updated", version: out.version.version });
          return { json: { ok: true, proposal: out.proposal, ...(out.version ? { version: out.version.version } : {}) } };
        } catch (e) {
          return { status: e instanceof InstructionError ? e.status : 500, json: { error: (e as Error).message } };
        }
      },
      "GET /api/models": async () => ({ json: { stages: MODEL_STAGES, choices: MODEL_CHOICES, default: DEFAULT_MODEL, models: config.models, envOverride: process.env.ULTIMATEHUMAN_MODEL ?? null } }),
      "POST /api/config/models": async (_r, body) => {
        const known = new Set<string>(MODEL_STAGES.map((st) => st.id));
        const entries = Object.entries(body ?? {}).filter(([k, v]) => known.has(k) && typeof v === "string");
        if (!entries.length) return { status: 400, json: { error: "send { <stage>: <model id> }" } };
        try {
          const c = await patchConfig((raw) => (raw.models = { ...(raw.models ?? {}), ...Object.fromEntries(entries) }));
          log(`models updated: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`);
          return { json: { ok: true, models: c.models } };
        } catch (e) {
          return { status: 400, json: { error: (e as Error).message } };
        }
      },
      "GET /api/setup-grade": async () => {
        const raw = JSON5.parse(await loadRawConfig(configPath)) as Record<string, any>;
        return { json: gradeSetup(config, raw, gradeProbes(config)) };
      },
      "GET /api/features": async () => {
        const props = ((configJsonSchema() as any).properties?.features?.properties ?? {}) as Record<string, { description?: string }>;
        return { json: { features: Object.entries(config.features).map(([id, on]) => ({ id, on, description: props[id]?.description ?? "", reserved: /^Reserved/.test(props[id]?.description ?? "") })) } };
      },
      "POST /api/config/features": async (_r, body) => {
        const known = new Set(Object.keys(config.features));
        const entries = Object.entries(body ?? {}).filter(([k, v]) => known.has(k) && typeof v === "boolean");
        if (!entries.length) return { status: 400, json: { error: "send { <feature>: true|false }" } };
        try {
          const c = await patchConfig((raw) => (raw.features = { ...(raw.features ?? {}), ...Object.fromEntries(entries) }));
          log(`features updated: ${entries.map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(", ")}`);
          return { json: { ok: true, features: c.features } };
        } catch (e) {
          return { status: 400, json: { error: (e as Error).message } };
        }
      },
      "GET /api/config": async () => ({ json: { path: configPath, raw: await loadRawConfig(configPath), config, schema: configJsonSchema() } }),
    },
  });

  radar.rearm();
  // Hot reload: a hand edit is validated; an invalid file keeps the last good config and logs why.
  watch(configPath, async () => {
    try {
      config = await loadConfig(configPath);
      log("config reloaded");
    } catch (e) {
      log(`config invalid, keeping the last good one: ${(e as Error).message}`);
    }
  });
  // Minimal daily cron ("M H * * *").
  const cron = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(config.radar.schedule);
  const tick = setInterval(() => {
    const d = new Date();
    if (cron && d.getMinutes() === Number(cron[1]) && d.getHours() === Number(cron[2]) && d.getSeconds() < 30) radar.trigger("schedule");
  }, 30_000);
  writeFileSync(join(home, "engine.pid"), String(process.pid));
  log(`daemon up on ${config.server.host}:${config.server.port} (pid ${process.pid})`);

  return {
    server,
    radar,
    stop: async () => {
      clearInterval(tick);
      await new Promise<void>((r) => server!.server.close(() => r()));
    },
  };
}
