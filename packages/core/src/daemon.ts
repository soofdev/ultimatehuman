import { watch } from "node:fs";
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import type { Finding, OutputContext, OutputPlugin, Plugin } from "@ultimatehuman/sdk";
import { readOnlyHttp, outboundHttp } from "./plugins/http";
import type { Config } from "./config/schema";
import JSON5 from "json5";
import { configJsonSchema, migrateConfig, MODEL_CHOICES, MODEL_STAGES, DEFAULT_MODEL, SecretRef } from "./config/schema";
import { loadConfig, loadRawConfig, writeConfig, defaultConfigPath, resolveSecretRefs, type SecretRefValue } from "./config/load";
import { ensureHome, controlKey } from "./home";
import { Store } from "./store/store";
import { WindowTracker } from "./governor/tracker";
import { PassExecutor, publicRun } from "./pass/executor";
import { renderIssue } from "./pass/issue";
import { startServer, type RunningServer } from "./server/http";
import { buildCockpit, backfillFindingClusters } from "./cockpit";
import { InstructionError, BRIEFS, RAILS, BRIEF_IDS, lineDiff, estimateTokens, validateBrief, migrateLegacyInstructions, type BriefId } from "./instructions/instructions";
import { PipelineRegistry, instantiate, blankPipeline, templateById } from "./pipelines/registry";
import { PipelineRuntime } from "./pipelines/runtime";
import { ticketWriter, ExternalTicketSchema, externalFinding } from "./pipelines/tickets";
import { LEGACY_PIPELINE_ID, pipelineOfRun, pipelineOfProposal, pipelineOfFinding } from "./pipelines/migrate";
import { EXTERNAL_PIPELINE_ID, PIPELINE_ID, SIGNAL_TYPE_SUGGESTIONS, REPOS_SOURCE } from "./pipelines/schema";
import { TEMPLATES } from "./pipelines/templates";
import { ruleProposal } from "./instructions/proposals";
import { Notifier } from "./notify/notifier";
import { gradeSetup, gradeProbes } from "./setup/grade";
import { setupStatusText } from "./setup/pending";
import { checkPending, currentGrade } from "./setup/concierge";
import { loadEngineEnv } from "./envfile";
import { Chat, mergePatch, FIRST_QUESTION, INIT_KEY } from "./chat/chat";
import { chatActions } from "./chat/actions";
import { ConnectionRequests, SOURCE_GUIDES, sortCredentials } from "./chat/connections";
import { validationGateFor } from "./pipelines/registry";
import { ChatTelegram } from "./chat/telegram";
import { allowedFile, fileType, saveToInbox, sentNote } from "./chat/files";
import { workspaceRoutes, pendingKey, pendingValues, discoveredHint, type ServiceControl } from "./setup/workspace";
import { claudeModelCatalog } from "./runner/models";
import { providerFor, agentModel, selectProvider, type AgentProvider } from "./runner/provider";
import { checkProvider } from "./setup/provider";

export interface DaemonHandle {
  server: RunningServer;
  runtime: PipelineRuntime;
  stop(): Promise<void>;
}

export interface DaemonOptions {
  plugins: readonly Plugin[];
  staticDir: string | null;
  version: string;
  service?: ServiceControl;
}

/**
 * Daemon entry: config, store (schema created at startup), governor, pipelines (registry + runtime),
 * local HTTP + WS server. Parked runs are re-armed from the store on boot.
 */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const home = ensureHome();
  // Secrets init saved to engine.env (an exported variable wins); re-read every minute by the pending check.
  loadEngineEnv();
  const configPath = defaultConfigPath();
  let config: Config = await loadConfig(configPath);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(config.server.host);
  if (!loopback && !config.server.allowRemote) throw new Error(`refusing to bind ${config.server.host}: set server.allowRemote or use an SSH tunnel`);

  const logFile = join(home, "logs", "daemon.log");
  const log = (m: string) => appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
  const store = new Store(home);
  const backfilled = backfillFindingClusters(store);
  if (backfilled) log(`linked ${backfilled} older finding${backfilled === 1 ? "" : "s"} to ${backfilled === 1 ? "its" : "their"} cluster`);
  // Pipelines: each one's instruction set (SPEC 7b) is provisioned by the engine on boot under instructions/<id>/.
  // A home from before pipelines moves its one set, history intact, to the pipeline the old radar block became.
  const registry = new PipelineRegistry(home, () => config);
  if (registry.get(LEGACY_PIPELINE_ID) && migrateLegacyInstructions(home, LEGACY_PIPELINE_ID)) log(`instructions moved to instructions/${LEGACY_PIPELINE_ID}/ (multi-pipeline migration)`);
  registry.ensureAll();
  const src = config.auth.sources[0]!;
  const tracker = new WindowTracker(store, src.id, src.kind === "anthropic_api_key" ? "api_key" : "subscription", config.governor.humanReservePct);

  const resolveCredentials = async (pluginId: string) => {
    const inst = config.plugins[pluginId];
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(inst?.credentials ?? {})) out[k] = await resolveSecretRefs(v as SecretRefValue, configPath);
    return out;
  };
  const runnerEnv = async (provider: AgentProvider = providerFor(config)): Promise<Record<string, string>> => {
    const src = config.auth.sources.find((s) => (s.kind === "codex_login") === (provider === "codex"));
    if (!src) return {};
    if (src.kind === "claude_oauth_token") return { CLAUDE_CODE_OAUTH_TOKEN: await resolveSecretRefs(src.token as SecretRefValue, configPath) };
    if (src.kind === "anthropic_api_key") return { ANTHROPIC_API_KEY: await resolveSecretRefs(src.apiKey as SecretRefValue, configPath) };
    return {};
  };
  const catalogs = { claude: claudeModelCatalog(home, () => runnerEnv("claude")), codex: claudeModelCatalog(home, () => runnerEnv("codex"), "codex") };
  const chatModels = (refresh = false) => catalogs[providerFor(config)](refresh);
  const authChanged = (next: { auth?: { sources?: unknown[] } }) => JSON.stringify(next.auth?.sources?.[0]) !== JSON.stringify(config.auth.sources[0]);
  const syncTracker = () => {
    const source = config.auth.sources[0]!;
    tracker.setSource(source.id, source.kind === "anthropic_api_key" ? "api_key" : "subscription");
    tracker.setReserve(config.governor.humanReservePct);
  };

  let server: RunningServer | null = null;
  const notifier = new Notifier({ plugins: opts.plugins, getConfig: () => config, configPath, log });
  // Set once the chat exists: a run the chat started reports back to it when it ends.
  let runEnded: ((run: Record<string, any>) => void) | null = null;
  const emit = (ev: unknown) => {
    server?.broadcast(ev);
    notifier.handle(ev as any);
    const event = ev as { type?: string; run?: Record<string, any> };
    if (event.type === "run.phase" && event.run && ["done", "failed"].includes(event.run.phase)) runEnded?.(event.run);
  };
  let runtime: PipelineRuntime | null = null;
  const executor = new PassExecutor({
    home,
    store,
    getConfig: () => config,
    plugins: opts.plugins,
    resolveCredentials,
    runnerEnv,
    tracker,
    registry,
    tickets: (pipelineId) => ticketWriter(store, emit, pipelineId),
    onSettled: () => runtime?.settled(),
    emit,
    log,
    ...(process.env.ULTIMATEHUMAN_MODEL ? { model: process.env.ULTIMATEHUMAN_MODEL } : {}),
  });
  runtime = new PipelineRuntime({ executor, registry, store, log, emit });
  const rt = runtime;
  const query = (req: { url?: string | undefined }, name: string) => new URL(req.url ?? "/", "http://x").searchParams.get(name);
  /** The pipeline a request is about (?pipeline= or body.pipelineId), defaulting to the first configured one. */
  const pipelineParam = (id: unknown) => {
    const want = typeof id === "string" && id ? id : registry.list()[0]?.id;
    return want ? registry.get(want) ?? null : null;
  };

  const output = () => opts.plugins.find((p): p is OutputPlugin => p.manifest.kind === "output" && !!config.plugins[p.manifest.id] && config.plugins[p.manifest.id]!.enabled !== false);
  /** Where an output plugin files: a GitHub repo, or a tracker project (e.g. a Jira project key). */
  const outputTarget = (o: OutputPlugin | undefined, f?: Finding): string => {
    const creds = (o ? config.plugins[o.manifest.id]?.credentials : undefined) ?? {};
    if (o && o.manifest.id !== "github") return String((creds as Record<string, unknown>).projectKey ?? (creds as Record<string, unknown>).repo ?? o.manifest.displayName);
    return (f && config.repos.find((r) => r.name === f.repo)?.issueRepo) ?? (o ? String((creds as Record<string, unknown>).repo ?? "") : "");
  };
  const issueFor = (id: string) => {
    const f = store.getFinding(id);
    if (!f) return null;
    const o = output();
    const labels = ((o && (config.plugins[o.manifest.id]?.options?.labels as string[])) ?? ["ultimatehuman"]) as string[];
    const repo = outputTarget(o, f);
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
    return { dryRun: o ? config.plugins[o.manifest.id]?.options?.dryRun !== false : true, repo: outputTarget(o) };
  };

  /** Dashboard edits: patch the file as written (not the defaulted config), validate, write, and use it at once. */
  let writes: Promise<unknown> = Promise.resolve();
  const patchConfig = (patch: (raw: Record<string, any>) => void): Promise<Config> => {
    const next = writes.then(async () => {
      const before = new Set(config.pipelines.map((p) => p.id));
      // Edits apply to the current shape: an old file (single `radar` block) is migrated first, so a pipelines patch lands on a list.
      const raw = migrateConfig(JSON5.parse(await loadRawConfig(configPath))) as Record<string, any>;
      patch(raw);
      if (authChanged(raw) && (chat.busy() || (rt.current() && !["done", "failed"].includes(rt.current()!.phase)))) throw new Error("Wait for the current chat and pipeline run to finish before switching AI accounts.");
      config = await writeConfig(raw, configPath, "// ultimatehuman config. Secrets are ${ENV_VAR} references only. Edited from the dashboard; every write validates first.");
      syncTracker();
      // Pipelines added get their instruction set now (copied from their template); deleted ones are archived and unqueued.
      for (const id of before) if (!registry.get(id)) (registry.archive(id), rt.forget(id), log(`pipeline ${id} deleted; its instructions archived`));
      registry.ensureAll();
      emit({ type: "config.updated" });
      emit({ type: "pipelines.updated" });
      return config;
    });
    writes = next.catch(() => {});
    return next;
  };

  const gradeDeps = { getConfig: () => config, readRawConfig: () => loadRawConfig(configPath), plugins: opts.plugins };
  const scopesByPlugin = Object.fromEntries(opts.plugins.map((p) => [p.manifest.id, p.manifest.requiredScopes]));
  const workspace = workspaceRoutes({ home, config: () => config, patch: patchConfig, plugins: opts.plugins, store, runtime: rt, credentials: resolveCredentials, runnerEnv, emit, ...(opts.service ? { service: opts.service } : {}) });
  const connections = new ConnectionRequests(store, emit);
  const connecting = new Set<string>();
  const operations = chatActions({ routes: workspace, config: () => config, configPath, registry, runtime: rt, plugins: opts.plugins, emit, connections, store });
  const chat = new Chat({
    home,
    store,
    getConfig: () => config,
    readRawConfig: () => loadRawConfig(configPath),
    applyPatch: async (p) => {
      await patchConfig((raw) => {
        mergePatch(raw, p);
        for (const plugin of opts.plugins) for (const field of plugin.manifest.credentials.filter((f) => f.secret)) {
          const value = (p.plugins as Record<string, any> | undefined)?.[plugin.manifest.id]?.credentials?.[field.key];
          if (value !== undefined && !SecretRef.safeParse(value).success) throw new Error(`Save ${field.label} with connect_source or the connection form; configuration only holds a secret reference.`);
        }
      });
    },
    runnerEnv,
    emit,
    log,
    setupStatus: async () => setupStatusText(config, await currentGrade(gradeDeps), scopesByPlugin),
    context: operations.context,
    executeAction: operations.execute,
  });
  runEnded = (run) => chat.runFinished({ ...run, pipelineName: config.pipelines.find((p) => p.id === pipelineOfRun(run as any))?.name ?? run.pipelineName });
  /** The only places chat files may be served or sent from: the install home and the configured repos. */
  const chatRoots = () => [home, ...config.repos.map((r) => r.path)];
  const chatTelegram = new ChatTelegram({ store, chat, home, chatRoots, getConfig: () => config, configPath, log, emit, patch: async (p) => { await patchConfig((raw) => mergePatch(raw, p)); } });

  server = await startServer({
    version: opts.version,
    host: config.server.host,
    port: config.server.port,
    staticDir: opts.staticDir,
    logDir: join(home, "logs"),
    controlKey: controlKey(),
    routes: {
      ...workspace,
      "GET /api/status": async () => ({
        json: {
          version: opts.version,
          window: tracker.status(),
          lastRun: rt.current() ? publicRun(rt.current()!) : store.listRuns(1)[0] ?? null,
          plugins: opts.plugins.map((p) => ({ id: p.manifest.id, displayName: p.manifest.displayName, kind: p.manifest.kind, configured: !!config.plugins[p.manifest.id] })),
          counts: { new: buildCockpit(store, rt.current(), dryRunOutput()).counts.new },
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
      "GET /api/runs": async (req) => {
        const pid = query(req, "pipeline");
        const names = new Map(config.pipelines.map((p) => [p.id, p.name]));
        const runs = store.listRuns(pid ? 300 : 30).filter((r) => !pid || pipelineOfRun(r) === pid).slice(0, 30);
        return { json: { runs: runs.map((r) => ({ ...r, pipelineId: pipelineOfRun(r), pipelineName: names.get(pipelineOfRun(r)) ?? r.pipelineName ?? pipelineOfRun(r) })), queued: rt.pending() } };
      },
      "GET /api/runs/:id": async (_r, _b, p) => {
        const run = rt.current()?.id === p.id ? publicRun(rt.current()!) : store.getRun(p.id!);
        return run ? { json: { run } } : { status: 404, json: { error: "no such run" } };
      },
      // Run now: { pipelineId } (default: the first pipeline). Serialized: while a pass runs, this one queues.
      "POST /api/runs": async (_r, body) => {
        const p = pipelineParam(body.pipelineId);
        if (!p) return { status: 404, json: { error: body.pipelineId ? `no pipeline "${body.pipelineId}"` : "no pipeline is configured" } };
        const out = rt.trigger(p.id, body.trigger === "onboarding" ? "onboarding" : "run_now", body.lookbackHours ? Number(body.lookbackHours) : undefined);
        return { json: { run: out.run ? publicRun(out.run) : null, queued: out.queued, position: out.position, pipelineId: p.id } };
      },
      "GET /api/pipelines": async () => ({
        json: {
          pipelines: rt.summaries(),
          config: config.pipelines,
          templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, suggestedByDefault: t.suggestedByDefault, pipeline: t.pipeline })),
          sources: [...opts.plugins.filter((p) => p.manifest.kind === "source").map((p) => ({ id: p.manifest.id, name: p.manifest.displayName, configured: !!config.plugins[p.manifest.id] })), { id: REPOS_SOURCE, name: "Watched repos (audit)", configured: config.repos.length > 0 }],
          signalTypes: SIGNAL_TYPE_SUGGESTIONS,
          running: rt.current() && rt.busy() ? { id: rt.current()!.id, pipelineId: pipelineOfRun(rt.current()!) } : null,
          queued: rt.pending(),
        },
      }),
      // Create: { template: "<id>", id?, name? } copies a template; { blank: true, id, name } starts empty (disabled, manual).
      "POST /api/pipelines": async (_r, body) => {
        const t = body.template ? templateById(String(body.template)) : undefined;
        if (body.template && !t) return { status: 400, json: { error: `no template "${body.template}"` } };
        if (!t && !body.blank) return { status: 400, json: { error: "send { template } or { blank: true, id, name }" } };
        const id = String(body.id ?? (t ? t.id : "")).trim();
        if (!PIPELINE_ID.test(id) || id === EXTERNAL_PIPELINE_ID) return { status: 400, json: { error: "id: lowercase letters, digits and dashes (and not \"external\")" } };
        if (registry.get(id)) return { status: 409, json: { error: `a pipeline "${id}" already exists` } };
        const name = String(body.name ?? (t ? t.name : id)).trim() || id;
        const entry = t ? instantiate(t, { id, name }) : blankPipeline(id, name);
        try {
          await patchConfig((raw) => (raw.pipelines = [...(Array.isArray(raw.pipelines) ? raw.pipelines : config.pipelines), entry]));
          log(`pipeline ${id} added${t ? ` from template ${t.id}` : " (blank)"}`);
          return { json: { ok: true, pipeline: registry.get(id) } };
        } catch (e) {
          return { status: 400, json: { error: (e as Error).message } };
        }
      },
      // Edit: any subset of the entry's fields (id excluded). null removes an optional field.
      "POST /api/pipelines/:id": async (_r, body, p) => {
        if (!registry.get(p.id!)) return { status: 404, json: { error: `no pipeline "${p.id}"` } };
        const { id: _ignore, ...fields } = (body ?? {}) as Record<string, unknown>;
        if (rt.busy() && rt.current()?.pipelineId === p.id && ["repos", "sources", "signalTypes"].some((k) => k in fields)) return { status: 409, json: { error: "Wait for this investigation to finish before changing its scope." } };
        if (!Object.keys(fields).length) return { status: 400, json: { error: "send the fields to change" } };
        try {
          await patchConfig((raw) => {
            const list = (Array.isArray(raw.pipelines) ? raw.pipelines : config.pipelines) as Record<string, unknown>[];
            raw.pipelines = list.map((x) => (x.id === p.id ? mergePatch(structuredClone(x), fields) : x));
          });
          log(`pipeline ${p.id} updated: ${Object.keys(fields).join(", ")}`);
          return { json: { ok: true, pipeline: registry.get(p.id!) } };
        } catch (e) {
          return { status: 400, json: { error: (e as Error).message } };
        }
      },
      "POST /api/pipelines/:id/delete": async (_r, _b, p) => {
        if (!registry.get(p.id!)) return { status: 404, json: { error: `no pipeline "${p.id}"` } };
        if (rt.busy() && pipelineOfRun(rt.current()!) === p.id) return { status: 409, json: { error: "a pass of this pipeline is running; delete it once the pass ends" } };
        try {
          await patchConfig((raw) => (raw.pipelines = ((Array.isArray(raw.pipelines) ? raw.pipelines : config.pipelines) as Record<string, unknown>[]).filter((x) => x.id !== p.id)));
          return { json: { ok: true } };
        } catch (e) {
          return { status: 400, json: { error: (e as Error).message } };
        }
      },
      "GET /api/findings": async (req) => {
        const pid = query(req, "pipeline");
        return { json: { findings: store.listFindings().filter((f) => !pid || pipelineOfFinding(f) === pid) } };
      },
      // The open ticket queue (docs/tickets-api.md): any tool enqueues a ticket with the control key (x-uh-control) or a dashboard session.
      "POST /api/findings": async (_r, body) => {
        const parsed = ExternalTicketSchema.safeParse(body ?? {});
        if (!parsed.success) return { status: 400, json: { error: "invalid ticket", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`) } };
        const pid = parsed.data.pipelineId ?? EXTERNAL_PIPELINE_ID;
        if (pid !== EXTERNAL_PIPELINE_ID && !registry.get(pid)) return { status: 400, json: { error: `no pipeline "${pid}": attribute it to a configured pipeline id or leave pipelineId out ("${EXTERNAL_PIPELINE_ID}")` } };
        if (parsed.data.repo && !config.repos.some((r) => r.name === parsed.data.repo)) return { status: 400, json: { error: `repo "${parsed.data.repo}" is not a configured repo (${config.repos.map((r) => r.name).join(", ") || "none"})` } };
        const f = externalFinding(parsed.data);
        const open = store.findingsByFingerprint(f.dedupe.fingerprint).find((x) => x.status === "new");
        if (open) return { status: 409, json: { error: "a ticket with this fingerprint is already open", finding: open } };
        if (validationGateFor(config, registry.get(pid))) (f as any).validation = { state: "pending", at: f.createdAt };
        const saved = ticketWriter(store, emit, pid).create(f);
        log(`ticket enqueued from outside (${parsed.data.source ?? "unnamed tool"}) on ${pid}: ${saved.title}`);
        return { status: 201, json: { ok: true, finding: saved } };
      },
      "GET /api/findings/:id": async (_r, _b, p) => {
        const x = issueFor(p.id!);
        return x ? { json: { finding: x.f, issuePreview: x.issue, repo: x.repo, dryRun: x.dryRun } } : { status: 404, json: { error: "no such finding" } };
      },
      "POST /api/findings/:id/decision": async (_r, body, p) => {
        const f = store.getFinding(p.id!) as (Finding & Record<string, any>) | undefined;
        if (!f || !f.clusterId) return { status: 404, json: { error: "Finding not found." } };
        const revision = store.rulingHistory(f.clusterId).at(-1)?.id ?? 0;
        if (body.expectedRuling !== undefined && body.expectedRuling !== revision) return { status: 409, json: { error: "This decision has changed. Refresh the case before deciding." } };
        const action = String(body.action);
        const reason = String(body.reason ?? "").trim();
        if (!["accept", "dismiss", "later", "reopen"].includes(action)) return { status: 400, json: { error: "Choose accept, dismiss, later, or reopen." } };
        if (reason.length > 500 || (action === "dismiss" && !reason)) return { status: 400, json: { error: "Give a dismissal reason between 1 and 500 characters." } };
        const ruling = rule(f.clusterId, action === "accept" ? "file" : action === "later" ? "park" : action === "reopen" ? "clear" : "dismiss", reason || null, action === "accept" ? { dryRun: true, note: "Accepted as a local finding. No issue was published." } : {});
        const messages: Record<string, string> = { accept: "Finding accepted and saved in Results. No issue was published.", dismiss: "Finding dismissed. Your reason will inform future investigations.", later: "Saved for later. New occurrences can bring this case back for review.", reopen: "Finding returned to the review queue." };
        return { json: { ok: true, ruling, message: messages[action] } };
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
        const id = o.manifest.id;
        const name = o.manifest.displayName;
        const credentials = await resolveCredentials(id).catch(() => ({ repo: x.repo }) as Record<string, string>);
        const signal = AbortSignal.timeout(60_000);
        const ctx: OutputContext = {
          credentials,
          options: config.plugins[id]?.options ?? {},
          http: readOnlyHttp(id, o.readOnlyPostAllowlist ?? [], log, signal),
          // A network write exists only for live filing, and only to the hosts the plugin derives from its own credentials.
          ...(!x.dryRun && o.sendHosts ? { send: outboundHttp(id, o.sendHosts(credentials), log, signal) } : {}),
          log: (_level, m) => log(`${id}: ${m}`),
          signal,
        };
        let filed: { ref: string; url: string };
        try {
          filed = await o.output.file(ctx, x.f);
        } catch (e) {
          const msg = (e as Error).message;
          log(`${id}: filing "${x.issue.title}" failed: ${msg}`);
          return { status: 502, json: { error: `${name} did not accept the issue: ${msg}`, dryRun: x.dryRun } };
        }
        const cid = (x.f as any).clusterId as string | undefined;
        if (x.dryRun) {
          (x.f as any).dryRunPreview = { at: new Date().toISOString(), repo: x.repo, ref: filed.ref, title: x.issue.title };
          store.saveFinding(x.f);
          log(`dry run: would create issue in ${x.repo}: ${x.issue.title}`);
          if (cid) rule(cid, "file", null, { dryRun: true, ref: filed.ref, repo: x.repo });
          else emit({ type: "finding.updated", finding: x.f });
          return { json: { dryRun: true, message: `dry run - would create issue in ${x.repo}`, issue: x.issue, repo: x.repo } };
        }
        x.f.filedIssue = { ref: filed.ref, url: filed.url, filedAt: new Date().toISOString(), filedBy: "human" };
        x.f.status = "filed";
        store.saveFinding(x.f);
        log(`${id}: filed ${filed.ref} (${filed.url}): ${x.issue.title}`);
        if (cid) rule(cid, "file", null, { dryRun: false, ref: filed.ref, url: filed.url, repo: x.repo });
        else emit({ type: "finding.updated", finding: x.f });
        return { json: { dryRun: false, message: `Filed as ${filed.ref} in ${name}.`, ref: filed.ref, url: filed.url, issue: x.issue, repo: x.repo } };
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
      "GET /api/cockpit": async () => ({
        json: {
          ...buildCockpit(store, rt.current(), dryRunOutput()),
          proposals: store.listProposals(30).map((p) => ({ ...p, pipelineId: pipelineOfProposal(p) })),
          instructionsVersion: registry.list()[0] ? registry.instructions(registry.list()[0]!.id).current().version.version : 0,
          instructionsVersions: Object.fromEntries(registry.list().map((p) => [p.id, registry.instructions(p.id).current().version.version])),
          pipelines: [...config.pipelines.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled })), { id: EXTERNAL_PIPELINE_ID, name: "External", enabled: true }],
        },
      }),
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
      "GET /api/instructions": async (req) => {
        const pipe = pipelineParam(query(req, "pipeline"));
        if (!pipe) return { status: 404, json: { error: "no such pipeline" } };
        const instructions = registry.instructions(pipe.id);
        const cur = instructions.current();
        const runs = store.listRuns(200).filter((r) => pipelineOfRun(r) === pipe.id).slice(0, 30);
        const usedBy = (v: number) => runs.filter((r) => (r.instructions?.version ?? 0) === v).map((r) => ({ id: r.id, startedAt: r.startedAt, trigger: r.trigger, lookbackHours: r.lookbackHours }));
        const vs = instructions.versions();
        return {
          json: {
            pipeline: { id: pipe.id, name: pipe.name, description: pipe.description },
            pipelines: config.pipelines.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, version: registry.instructions(p.id).current().version.version })),
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
        const pipe = pipelineParam(body.pipelineId);
        if (!pipe) return { status: 404, json: { error: "no such pipeline" } };
        if (!BRIEF_IDS.includes(id)) return { status: 400, json: { error: "unknown brief" } };
        const before = registry.instructions(pipe.id).current().version.briefs[id];
        const text = String(body.text ?? "");
        return { json: { diff: lineDiff(before, text), tokensBefore: estimateTokens(before), tokensAfter: estimateTokens(text), error: validateBrief(id, text) } };
      },
      "POST /api/instructions": async (_r, body) => {
        const pipe = pipelineParam(body.pipelineId);
        if (!pipe) return { status: 404, json: { error: "no such pipeline" } };
        if (body.expectedVersion !== undefined && body.expectedVersion !== registry.instructions(pipe.id).current().version.version) return { status: 409, json: { error: "Guidelines changed since you opened them. Reload the latest version before saving; your draft is preserved." } };
        try {
          const v = registry.instructions(pipe.id).save(String(body.brief) as BriefId, String(body.text ?? ""), String(body.note ?? ""));
          log(`instructions ${pipe.id} v${v.version} saved: ${v.note}`);
          emit({ type: "instructions.updated", pipelineId: pipe.id, version: v.version });
          return { json: { ok: true, version: v.version } };
        } catch (e) {
          return { status: e instanceof InstructionError ? e.status : 500, json: { error: (e as Error).message } };
        }
      },
      "POST /api/instructions/revert": async (_r, body) => {
        const pipe = pipelineParam(body.pipelineId);
        if (!pipe) return { status: 404, json: { error: "no such pipeline" } };
        if (body.expectedVersion !== undefined && body.expectedVersion !== registry.instructions(pipe.id).current().version.version) return { status: 409, json: { error: "Guidelines changed while you were viewing the history. Reload before restoring a version." } };
        try {
          const v = registry.instructions(pipe.id).revert(Number(body.version), body.note ? String(body.note) : undefined);
          log(`instructions ${pipe.id} v${v.version}: ${v.note}`);
          emit({ type: "instructions.updated", pipelineId: pipe.id, version: v.version });
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
          const proposal = store.getProposal(p.id!);
          if (ruling === "apply" && proposal && body.expectedVersion !== undefined && body.expectedVersion !== registry.instructions(pipelineOfProposal(proposal)).current().version.version) return { status: 409, json: { error: "Guidelines changed since this suggestion was prepared. Review the latest guidelines before applying changes." } };
          const out = ruleProposal(store, (x) => registry.instructions(pipelineOfProposal(x)), p.id!, ruling as "apply" | "reject" | "park", reason || null);
          log(`proposal ${p.id}: ${ruling}${out.version ? ` -> instructions v${out.version.version}` : ""}${reason ? ` (${reason})` : ""}`);
          emit({ type: "ruling", proposal: out.proposal });
          if (out.version) emit({ type: "instructions.updated", version: out.version.version });
          return { json: { ok: true, proposal: out.proposal, ...(out.version ? { version: out.version.version } : {}) } };
        } catch (e) {
          return { status: e instanceof InstructionError ? e.status : 500, json: { error: (e as Error).message } };
        }
      },
      "GET /api/models": async () => {
        if (providerFor(config) === "claude") return { json: { provider: "claude", stages: MODEL_STAGES, choices: MODEL_CHOICES, default: DEFAULT_MODEL, models: config.models, envOverride: process.env.ULTIMATEHUMAN_MODEL ?? null } };
        try {
          const models = await catalogs.codex();
          const fallback = models.find((m) => m.isDefault)?.id ?? models[0]!.id;
          return { json: { provider: "codex", stages: MODEL_STAGES, choices: models.map((m) => ({ ...m, note: m.id === fallback ? "CLI default" : "" })), default: fallback, models: Object.fromEntries(MODEL_STAGES.map((s) => [s.id, config.codexModels[s.id] ?? fallback])), envOverride: process.env.ULTIMATEHUMAN_MODEL ?? null } };
        } catch (e) { return { status: 503, json: { error: (e as Error).message } }; }
      },
      "POST /api/config/models": async (_r, body) => {
        const known = new Set<string>(MODEL_STAGES.map((st) => st.id));
        const entries = Object.entries(body ?? {}).filter(([k, v]) => known.has(k) && typeof v === "string");
        if (!entries.length) return { status: 400, json: { error: "send { <stage>: <model id> }" } };
        const provider = providerFor(config);
        try {
          if (provider === "codex") {
            const available = await catalogs.codex();
            if (entries.some(([, value]) => !available.some((m) => m.id === value))) throw new Error("Choose a model from Codex’s current model list.");
          }
          const field = provider === "codex" ? "codexModels" : "models";
          const c = await patchConfig((raw) => {
            if (providerFor(config) !== provider) throw new Error("The AI account changed. Refresh the model list.");
            raw[field] = { ...(raw[field] ?? {}), ...Object.fromEntries(entries) };
          });
          log(`models updated: ${entries.map(([k, v]) => `${k}=${v}`).join(", ")}`);
          return { json: { ok: true, models: c[field] } };
        } catch (e) {
          return { status: 400, json: { error: (e as Error).message } };
        }
      },
      "GET /api/setup-grade": async () => {
        const raw = JSON5.parse(await loadRawConfig(configPath)) as Record<string, any>;
        return { json: { ...gradeSetup(config, raw, gradeProbes(config, opts.plugins.filter((p) => p.manifest.kind === "source").map((p) => p.manifest.id))), pending: config.pending ?? [] } };
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
      "GET /api/chat/telegram": async () => ({ json: chatTelegram.status() }),
      "POST /api/chat/telegram/connect": async (_r, body) => {
        try { return { json: await chatTelegram.connect(typeof body.token === "string" ? body.token : undefined) }; }
        catch (e) { return { status: 400, json: { error: (e as Error).message } }; }
      },
      "GET /api/chat": async () => ({ json: {
        messages: chat.history(), busy: chat.busy(), activity: chat.progress(),
        model: agentModel(config, "chat"),
        provider: providerFor(config),
        // An open request whose keys failed says what is still needed, so its card can ask only for that.
        connections: connections.list().map((r) => r.status === "pending" && r.lastAttempt ? { ...r, missing: store.getKv<{ missing?: string[] }>(pendingKey(r.source))?.missing ?? [] } : r),
        permissions: chat.permissions(),
        // The run in progress, or one that finished in the last 15 minutes: the chat shows it live where it was started.
        run: (() => {
          const latest = rt.current() ? publicRun(rt.current()!) : store.listRuns(1)[0];
          if (!latest || (["done", "failed"].includes(latest.phase) && Date.now() - Date.parse(latest.finishedAt ?? latest.startedAt) > 15 * 60_000)) return null;
          const pipeline = config.pipelines.find((p) => p.id === pipelineOfRun(latest));
          return { ...latest, pipelineId: pipelineOfRun(latest), pipelineName: pipeline?.name ?? latest.pipelineName ?? pipelineOfRun(latest), pipelineSources: pipeline?.sources ?? [] };
        })(),
        accountKind: config.auth.sources[0]?.kind === "anthropic_api_key" ? "api" : "subscription",
        cliCommand: [process.execPath, process.argv[1]].filter(Boolean).map((s) => `'${s!.replace(/'/g, "'\\''")}'`).join(" "),
      } }),
      "GET /api/chat/providers": async () => ({ json: {
        current: providerFor(config),
        providers: await Promise.all((["claude", "codex"] as const).map(async (id) => ({ id, ...await checkProvider(id, () => runnerEnv(id)) }))),
      } }),
      "POST /api/chat/provider": async (_r, body) => {
        if (body.provider !== "claude" && body.provider !== "codex") return { status: 400, json: { error: "Choose Claude or Codex." } };
        if (chat.busy() || (rt.current() && !["done", "failed"].includes(rt.current()!.phase))) return { status: 409, json: { error: "Wait for the current chat and pipeline run to finish before switching AI accounts." } };
        try {
          const readiness = await checkProvider(body.provider, () => runnerEnv(body.provider));
          if (!readiness.authenticated) return { status: 400, json: { error: readiness.detail, command: readiness.command } };
          await patchConfig((raw) => selectProvider(raw, body.provider));
          emit({ type: "chat.provider", provider: providerFor(config) });
          emit({ type: "window.updated", window: tracker.status() });
          return { json: { ok: true, provider: providerFor(config), model: agentModel(config, "chat") } };
        } catch (e) { return { status: 409, json: { error: (e as Error).message } }; }
      },
      "GET /api/chat/models": async (req) => {
        const provider = providerFor(config);
        const current = agentModel(config, "chat");
        try {
          const models = await chatModels(query(req, "refresh") === "1");
          const fallback = provider === "claude" ? DEFAULT_MODEL : models.find((m) => m.isDefault)?.id ?? models[0]!.id;
          return { json: { provider, current: current || fallback, default: fallback, models } };
        } catch (e) { return { json: { provider, current, default: provider === "claude" ? DEFAULT_MODEL : "", models: [], error: (e as Error).message } }; }
      },
      "POST /api/chat/model": async (_r, body) => {
        if (typeof body?.model !== "string") return { status: 400, json: { error: "Choose a model from the selected CLI." } };
        const provider = providerFor(config);
        try {
          const models = await chatModels();
          if (!models.some((m) => m.id === body.model)) return { status: 400, json: { error: "That model is not in the selected CLI’s current list. Refresh and choose again." } };
          await patchConfig((raw) => {
            if (providerFor(config) !== provider) throw new Error("The AI account changed. Refresh the model list.");
            const field = provider === "codex" ? "codexModels" : "models";
            raw[field] = { ...(raw[field] ?? {}), chat: body.model };
          });
          emit({ type: "chat.model", model: agentModel(config, "chat") });
          return { json: { ok: true, model: agentModel(config, "chat") } };
        } catch (e) { return { status: 503, json: { error: (e as Error).message } }; }
      },
      "GET /api/chat/connections": async () => ({ json: { sources: opts.plugins.filter((p) => p.manifest.id in SOURCE_GUIDES).map((p) => {
        // What an earlier submission or a pasted key left saved, sorted into the right fields: the form only asks for the rest.
        const pending = sortCredentials(p.manifest.id, pendingValues(store, opts.plugins, p.manifest.id)).values;
        const saved = config.plugins[p.manifest.id]?.credentials ?? {};
        return {
        id: p.manifest.id, name: p.manifest.displayName,
        fields: p.manifest.credentials.map((f) => ({ ...f,
          value: f.secret ? "" : String(saved[f.key] ?? pending[f.key] ?? (discoveredHint(store, config, p.manifest.id, f.key) || f.default) ?? ""),
          ...(f.secret && (saved[f.key] || pending[f.key]) ? { saved: true } : {}) })),
        configured: config.plugins[p.manifest.id]?.enabled === true,
        savedOptions: config.plugins[p.manifest.id]?.options ?? {},
        scopes: p.manifest.requiredScopes,
        guide: SOURCE_GUIDES[p.manifest.id as keyof typeof SOURCE_GUIDES],
        };
      }) } }),
      "POST /api/chat/connections/request": async (_r, body) => {
        try { return { json: { request: connections.request(body.source, body.project) } }; }
        catch (e) { return { status: 400, json: { error: (e as Error).message } }; }
      },
      "POST /api/chat/connections/:id": async (req, body, params) => {
        const request = connections.list().find((r) => r.id === params.id);
        if (!request) return { status: 404, json: { error: "Connection request not found. Reopen the connection form." } };
        if (request.status === "connected") return { json: { ok: true, alreadyConnected: true } };
        if (connecting.has(request.id)) return { status: 409, json: { error: "This connection is already being checked." } };
        connecting.add(request.id);
        try {
          // The form always accepts: keys are saved, then the chat explains anything that failed.
          const result = await workspace["POST /api/workspace/connections/:id"]!(req, { ...body, acceptFailure: true }, { id: request.source });
          if ((result.status ?? 200) >= 400) {
            // Provider error bodies must never echo a credential back into the UI. Site and host are not secrets.
            const secretFields = new Set(opts.plugins.find((p) => p.manifest.id === request.source)?.manifest.credentials.filter((f) => f.secret).map((f) => f.key));
            let json = JSON.stringify(result.json);
            for (const [field, value] of Object.entries(body.credentials ?? {})) if (secretFields.has(field) && typeof value === "string" && value.length >= 8) json = json.split(value).join("[key hidden]");
            return { ...result, json: JSON.parse(json) };
          }
          const outcome = result.json as any;
          const name = request.source === "posthog" ? "PostHog" : "Datadog";
          if (outcome.ok) {
            connections.completeSource(request.source);
            const turn = chat.send(`${name} is connected${request.project ? ` for ${request.project}` : ""}.`, "dashboard", `The user submitted the in-chat key form. The engine verified read access${outcome.corrected ? ` after correcting the submission (${outcome.corrected})` : ""}: ${JSON.stringify(outcome.probe)}. In one short sentence say what is connected${outcome.corrected ? " and what was corrected" : ""}, then continue setting up the first pipeline the user asked for, preserving existing pipelines and original defaults. Never ask for the saved keys again.`);
            void turn.reply.catch(() => {});
          } else {
            connections.attempted(request.id);
            const turn = chat.send(`I entered my ${name} keys.`, "dashboard", `The user submitted the in-chat key form. The keys are saved outside the chat, but the read-access check FAILED. Engine result (authoritative): ${JSON.stringify(outcome)}. Follow rule 4: at most three short lines on what is still missing and the fastest way to get it, one link on the user's real site, nothing already explained earlier in this conversation. Values the engine kept are reused automatically: the user only provides what is missing, in the form card or pasted here. Never claim the connection works.`);
            void turn.reply.catch(() => {});
          }
          emit({ type: "workspace.updated" });
          return { json: { ok: outcome.ok === true, saved: true } };
        } finally { connecting.delete(request.id); }
      },
      "POST /api/chat/permissions/:id": async (_r, body, params) => {
        if (typeof body.allow !== "boolean") return { status: 400, json: { error: "Choose Allow or Decline." } };
        if (!chat.resolvePermission(params.id!, body.allow)) return { status: 409, json: { error: "This permission request has ended." } };
        return { json: { ok: true } };
      },
      "POST /api/chat/start": async (_r, body) => {
        if (chat.history(1).length || chat.busy()) return { json: { started: false } };
        if (body.directory) store.setKv(INIT_KEY, { directory: String(body.directory).slice(0, 2000) });
        if (!config.repos.length && !body.repository) {
          // The opening screen is one question; asking it needs no model call.
          const message = store.addChat({ role: "assistant", text: FIRST_QUESTION, source: "dashboard" });
          emit({ type: "chat.message", message });
          return { json: { started: true } };
        }
        const context = [body.repository ? `Use these repositories for the first project: ${String(body.repository).slice(0, 2000)}.` : config.repos.length ? "Continue from the existing repositories and pipelines. Do not repeat completed setup." : "Ask which project to start with and which repos belong to it. Keep the opening question to two short sentences.", body.directory ? `Installation directory (context only): ${String(body.directory).slice(0, 2000)}.` : ""].join(" ");
        const turn = chat.send(config.repos.length ? "Help me manage this workspace." : "Help me set up ultimatehuman.", body.source === "cli" ? "cli" : "dashboard", context);
        void turn.reply.catch(() => {});
        return { json: { started: true } };
      },
      "GET /api/chat/file": async (req) => {
        const path = allowedFile(new URL(req.url ?? "/", "http://x").searchParams.get("path") ?? "", chatRoots());
        if (!path) return { status: 403, json: { error: "only files inside the install home or a configured repo are served" } };
        const type = fileType(path);
        if (!type.startsWith("image/")) return { status: 415, json: { error: "only images are shown inline" } };
        return { file: { data: await readFile(path), type } };
      },
      "POST /api/chat": async (_r, body) => {
        let text = String(body.text ?? "").trim();
        const source = body.source === "cli" ? "cli" : "dashboard";
        const files = Array.isArray(body.files) ? (body.files as any[]) : [];
        if (!text && !files.length) return { status: 400, json: { error: "send { text } and/or { files: [{ name, data }] }" } };
        if (text.length > 8000) return { status: 400, json: { error: "keep a message under 8000 characters" } };
        if (files.length > 4) return { status: 400, json: { error: "attach at most 4 files" } };
        const decoded = files.map((f) => ({ name: String(f?.name ?? "image.png"), data: Buffer.from(String(f?.data ?? ""), "base64") }));
        const bad = decoded.find((f) => !f.data.length || f.data.length > 10 * 1024 * 1024 || !fileType(f.name).startsWith("image/"));
        if (bad) return { status: 400, json: { error: `${bad.name}: send an image (png, jpg, webp, gif, svg) under 10 MB` } };
        // Bridge convention: the file lands in the inbox and the prompt carries one line per file.
        for (const f of decoded) {
          const path = saveToInbox(home, f.name, f.data);
          text = text ? `${text}\n${sentNote("photo", path)}` : sentNote("photo", path);
        }
        const t = chat.send(text, source);
        // The CLI waits for the reply; the dashboard returns at once and polls.
        if (body.wait === true) return { json: { user: t.user, reply: await t.reply } };
        void t.reply.catch((e) => log(`chat turn crashed: ${(e as Error).message}`));
        return { status: 202, json: { user: t.user, busy: chat.busy() } };
      },
      "GET /api/config": async () => ({ json: { path: configPath, raw: await loadRawConfig(configPath), config, schema: configJsonSchema() } }),
    },
  });

  executor.rearm();
  chatTelegram.start();
  // Hot reload: a hand edit is validated; an invalid file keeps the last good config and logs why.
  // Watch the directory, not the file: writeConfig replaces the file by rename, which a file watch does not survive.
  let reload: NodeJS.Timeout | null = null;
  watch(dirname(configPath), (_ev, name) => {
    if (name !== basename(configPath)) return;
    if (reload) clearTimeout(reload);
    reload = setTimeout(async () => {
      try {
        // A config that now references a key saved with `ultimatehuman key` resolves at once, not on the next minute check.
        loadEngineEnv();
        const next = await loadConfig(configPath);
        if (authChanged(next) && (chat.busy() || (rt.current() && !["done", "failed"].includes(rt.current()!.phase)))) throw new Error("AI account change deferred: finish active work, then save the configuration again.");
        config = next;
        syncTracker();
        emit({ type: "config.updated" });
        registry.ensureAll();
        log("config reloaded");
      } catch (e) {
        log(`config invalid, keeping the last good one: ${(e as Error).message}`);
      }
    }, 100);
  });
  // Pending ledger: once a minute on the same tick (plus once at boot), clear what got done and say so.
  let checking = false;
  const pendingCheck = () => {
    if (checking) return;
    checking = true;
    void checkPending({
      store,
      plugins: opts.plugins,
      getConfig: () => config,
      readRawConfig: () => loadRawConfig(configPath),
      patchConfig,
      configPath,
      log,
      // Each enabled pipeline that never ran gets its first pass (a repo audit may already have run without a tracker).
      onSourceConnected: () => {
        const ran = new Set(store.listRuns(300).map(pipelineOfRun));
        for (const p of registry.list().filter((x) => x.enabled && !ran.has(x.id))) {
          const out = rt.trigger(p.id, "onboarding");
          log(`first ${p.id} pass ${out.queued ? "queued" : "started"} now that a source is connected${out.run ? `: ${out.run.id}` : ""}`);
        }
      },
      announce: async (text) => {
        const msg = store.addChat({ role: "assistant", text, source: "dashboard" });
        emit({ type: "chat.message", message: msg });
        emit({ type: "config.updated" });
        await chatTelegram.push(text).catch((e) => log(`chat telegram: upgrade note not sent: ${(e as Error).message}`));
      },
    })
      .catch((e) => log(`pending check failed: ${(e as Error).message}`))
      .finally(() => (checking = false));
  };
  setTimeout(pendingCheck, 3000);
  let ticks = 0;
  const tick = setInterval(() => {
    const d = new Date();
    rt.tick(d);
    if (++ticks % 2 === 0) pendingCheck();
  }, 30_000);
  writeFileSync(join(home, "engine.pid"), String(process.pid));
  log(`daemon up on ${config.server.host}:${config.server.port} (pid ${process.pid})`);

  return {
    server,
    runtime: rt,
    stop: async () => {
      clearInterval(tick);
      chatTelegram.stop();
      await server!.close();
    },
  };
}
