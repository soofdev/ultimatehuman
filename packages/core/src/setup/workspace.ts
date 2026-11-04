import { createHash } from "node:crypto";
import type { Config } from "../config/schema";
import type { Plugin, ProbeResult } from "@ultimatehuman/sdk";
import type { Route } from "../server/http";
import type { Store } from "../store/store";
import type { PipelineRuntime } from "../pipelines/runtime";
import {
  inspectRepository,
  connectRepository,
  type RepositoryDiscovery,
} from "./discovery";
import { instantiate, templateById } from "../pipelines/registry";
import { publicRun } from "../pass/executor";
import { readOnlyHttp } from "../plugins/http";
import { setEngineEnv } from "../envfile";
import { checkProvider, type ProviderReadiness } from "./provider";
import { providerFor, agentModel } from "../runner/provider";

export interface ServiceControl {
  installed(): boolean;
  install(): void;
}
interface Deps {
  home: string;
  config: () => Config;
  patch: (mutate: (raw: Record<string, any>) => void) => Promise<Config>;
  plugins: readonly Plugin[];
  store: Store;
  runtime: PipelineRuntime;
  credentials: (id: string) => Promise<Record<string, string>>;
  runnerEnv: () => Promise<Record<string, string>>;
  emit: (event: { type: string; [key: string]: unknown }) => void;
  service?: ServiceControl;
}
const stamp = () => new Date().toISOString();
const projectOf = (repo: { name: string; project?: string | undefined }) =>
  repo.project ?? repo.name;
const probeKey = (id: string) => `workspace.probe.${id}`;

/** Local project management. Reading discovery never starts an agent or an external action. */
export function workspaceRoutes(d: Deps): Record<string, Route> {
  const scanning = new Map<string, Promise<RepositoryDiscovery>>();
  const scan = (repo: Config["repos"][number], refresh = false) => {
    const key = `discovery.${repo.name}`;
    const cached = d.store.getKv<RepositoryDiscovery>(key);
    if (
      !refresh &&
      cached?.path === repo.path &&
      cached.project === projectOf(repo)
    )
      return Promise.resolve(cached);
    const pending = scanning.get(repo.name);
    if (pending) return pending;
    const task = inspectRepository(repo)
      .then((result) => {
        d.store.setKv(key, result);
        return result;
      })
      .finally(() => scanning.delete(repo.name));
    scanning.set(repo.name, task);
    return task;
  };
  let providerCheck: Promise<ProviderReadiness> | undefined;
  let providerCheckedAt = 0;
  let providerSource = "";
  const provider = (refresh = false, verify = false) => {
    const sourceKey = JSON.stringify(d.config().auth.sources[0]);
    if (refresh || providerSource !== sourceKey || Date.now() - providerCheckedAt > 10_000) providerCheck = undefined;
    if (!providerCheck) {
      providerSource = sourceKey;
      providerCheckedAt = Date.now();
      providerCheck = checkProvider(providerFor(d.config()), d.runnerEnv, verify ? d.home : undefined).then((result) => {
        const previous = d.store.getKv<{ sourceKey: string; result: ProviderReadiness }>("workspace.provider.diagnostic");
        if (verify || result.authenticated) d.store.setKv("workspace.provider.diagnostic", { sourceKey, result });
        if (!verify && !result.authenticated && previous?.sourceKey === sourceKey && previous.result.reason === "expired") return previous.result;
        return result;
      });
    }
    return providerCheck;
  };
  const sourceIds = new Set(["posthog", "datadog"]);
  const activation = async (project: string, template: string, requestedSources: unknown, verify = false) => {
    const repos = d.config().repos.filter((r) => projectOf(r) === project);
    if (!repos.length) throw new Error("Choose a connected project first.");
    const t = templateById(template);
    if (!t) throw new Error("Choose a supported investigation.");
    const existing = d.config().pipelines.find((p) => p.id === `${t.id}-${createHash("sha1").update(project).digest("hex").slice(0, 8)}`);
    const discoveries = await Promise.all(repos.map((r) => scan(r, true)));
    const ai = await provider(true, verify);
    const sources = existing?.sources ?? (t.id === "security-check" ? ["repos"] :
      Array.isArray(requestedSources) ? [...new Set(requestedSources.filter((id): id is string => typeof id === "string" && sourceIds.has(id)))] : []);
    type Check = { id: string; label: string; ready: boolean; required: boolean; detail: string; command?: string; sourceId?: string };
    const checks: Check[] = [
      { id: "repository", label: "Repository access", ready: discoveries.every((r) => r.available), required: true,
        detail: discoveries.map((r) => r.available ? `${r.name} · ${r.branch || "detached checkout"} · ${r.commit?.slice(0, 7) ?? "no commit"}` : `${r.name}: ${r.error}`).join("; ") },
      { id: "ai", label: "AI account", ready: ai.authenticated, required: true, detail: ai.detail, ...(ai.command ? { command: ai.command } : {}) },
    ];
    const detected = [...new Set(discoveries.flatMap((r) => r.trackers.map((x) => x.provider)))];
    const selected = t.id === "security-check" ? detected.filter((id) => sourceIds.has(id)) : sources;
    for (const id of selected) {
      const ready = !!d.config().plugins[id] && d.config().plugins[id]?.enabled !== false && !!d.store.getKv<ProbeResult>(probeKey(id))?.ok;
      checks.push({ id, label: d.plugins.find((p) => p.manifest.id === id)?.manifest.displayName ?? id, ready,
        required: t.id !== "security-check", sourceId: id,
        detail: ready ? "Read access verified. Available for signal investigations." :
          t.id === "security-check" ? "SDK detected. Connect read access to investigate real user signals later; this code review can run without it." :
            "Connect a read-only key to investigate real user signals. An installed SDK or public ingestion key does not grant read access." });
    }
    if (t.id !== "security-check" && !sources.length)
      checks.push({ id: "signals", label: "Signal source", ready: false, required: true, detail: "Choose and connect PostHog or Datadog for this investigation." });
    const maxFindings = existing?.maxFindingsPerPass ?? t.pipeline.maxFindingsPerPass;
    checks.push({ id: "boundaries", label: "Investigation boundaries", ready: true, required: true,
      detail: `Read-only code access · up to ${maxFindings} findings per pass · ${d.config().governor.humanReservePct}% account capacity reserved for you. ${existing ? `Saved schedule: ${existing.schedule}; ${existing.enabled ? "enabled" : "paused"}.` : `Template schedule: ${t.pipeline.schedule}; ${t.pipeline.enabled ? "enabled" : "paused"}.`} Existing pipeline settings are preserved.` });
    return { project, template, name: t.name, sources, model: agentModel(d.config(), "radar", existing) || "Codex default", checkedAt: stamp(), checks, ready: checks.every((c) => !c.required || c.ready) };
  };
  const routes: Record<string, Route> = {
    "POST /api/workspace/provider/check": async () => ({ json: { provider: await provider(true, true) } }),
    "POST /api/workspace/activation": async (_req, body) => ({ json: await activation(String(body.project ?? ""), String(body.template ?? "security-check"), body.sources, body.verifyProvider === true) }),
    "GET /api/workspace": async () => {
      const cfg = d.config();
      const discoveries = await Promise.all(cfg.repos.map((r) => scan(r)));
      const projects = [...new Set(cfg.repos.map(projectOf))].map((id) => {
        const repos = discoveries.filter((r) => r.project === id);
        const names = repos.map((r) => r.name);
        const pipelines = cfg.pipelines.filter((p) =>
          !p.repos || p.repos.some((r) => names.includes(r)),
        );
        const runs = d.store
          .listRuns(100)
          .filter((run) => pipelines.some((p) => p.id === run.pipelineId));
        const active = d.runtime.current();
        const lastRun =
          active && pipelines.some((p) => p.id === active.pipelineId)
            ? publicRun(active)
            : (runs[0] ?? null);
        return {
          id,
          name: id,
          repos: repos.map((r) => ({
            ...r,
            testUrl: cfg.repos.find((x) => x.name === r.name)?.testUrl ?? "",
            notes: cfg.repos.find((x) => x.name === r.name)?.notes ?? "",
          })),
          lastRun,
          pipelineIds: pipelines.map((p) => p.id),
        };
      });
      const connections = d.plugins
        .filter((p) => p.manifest.kind === "source")
        .map((p) => {
          const inst = cfg.plugins[p.manifest.id];
          const probe = d.store.getKv<ProbeResult & { at: string }>(
            probeKey(p.manifest.id),
          );
          return {
            id: p.manifest.id,
            name: p.manifest.displayName,
            supported: sourceIds.has(p.manifest.id),
            configured: !!inst && inst.enabled !== false,
            probe: probe ?? null,
            detectedIn: discoveries
              .filter((r) =>
                r.trackers.some((t) => t.provider === p.manifest.id),
              )
              .map((r) => r.name),
            fields: p.manifest.credentials.map((f) => ({
              ...f,
              value: f.secret
                ? ""
                : String(inst?.credentials[f.key] ?? f.default ?? ""),
            })),
            options: p.manifest.options ?? {},
            savedOptions: inst?.options ?? {},
            scopes: p.manifest.requiredScopes,
          };
        });
      return {
        json: {
          projects,
          connections,
          provider: await provider(),
          service: {
            available: !!d.service,
            installed: d.service?.installed() ?? false,
          },
          reserve: cfg.governor.humanReservePct,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          completedDecisions: d.store
            .allRulings()
            .filter(
              (r) => r.by === "you" && ["file", "dismiss"].includes(r.ruling),
            ).length,
        },
      };
    },
    "POST /api/workspace/projects": async (_req, body) => {
      const repo = await connectRepository(
        String(body.repository ?? ""),
        d.home,
        d.config().repos,
      );
      const project = String(body.project ?? "").trim();
      if (project) repo.project = project;
      await d.patch((raw) => {
        const repos = raw.repos ?? [];
        raw.repos = repos.some((r: any) => r.path === repo.path)
          ? repos.map((r: any) => (r.path === repo.path ? repo : r))
          : [...repos, repo];
      });
      const discovery = await scan(repo, true);
      return { status: 201, json: { project: projectOf(repo), discovery } };
    },
    "POST /api/workspace/projects/:id/rescan": async (_req, _body, params) => {
      const repos = d.config().repos.filter((r) => projectOf(r) === params.id);
      if (!repos.length)
        return { status: 404, json: { error: "Project not found." } };
      const discoveries = await Promise.all(repos.map((r) => scan(r, true)));
      providerCheck = undefined;
      return { json: { discoveries } };
    },
    "POST /api/workspace/repos/:id": async (_req, body, params) => {
      if (!d.config().repos.some((r) => r.name === params.id))
        return { status: 404, json: { error: "Repository not found." } };
      await d.patch((raw) => {
        raw.repos = raw.repos.map((r: any) =>
          r.name !== params.id
            ? r
            : {
                ...r,
                ...(body.notes !== undefined
                  ? { notes: String(body.notes).slice(0, 4000) }
                  : {}),
                ...(body.testUrl !== undefined
                  ? { testUrl: body.testUrl || undefined }
                  : {}),
              },
        );
      });
      return { json: { ok: true } };
    },
    "POST /api/workspace/investigate": async (_req, body) => {
      const repos = d
        .config()
        .repos.filter((r) => projectOf(r) === body.project);
      if (!repos.length)
        return {
          status: 400,
          json: { error: "Choose a connected project first." },
        };
      const t = templateById(String(body.template));
      if (!t)
        return {
          status: 400,
          json: { error: "Choose a supported investigation." },
        };
      const setup = await activation(String(body.project), t.id, body.sources);
      if (!setup.ready)
        return { status: 400, json: { error: setup.checks.find((c) => c.required && !c.ready)!.detail, activation: setup } };
      const sources = setup.sources;
      const id = `${t.id}-${createHash("sha1").update(String(body.project)).digest("hex").slice(0, 8)}`;
      await d.patch((raw) => {
        const existing = (raw.pipelines ?? []).find((p: any) => p.id === id);
        if (!existing)
          raw.pipelines = [
            ...(raw.pipelines ?? []),
            instantiate(t, {
              id,
              name: `${t.name} · ${body.project}`.slice(0, 60),
              repos: repos.map((r) => r.name),
              sources,
            }),
          ];
      });
      const out = d.runtime.trigger(id, "onboarding");
      d.store.setKv(`workspace.started.${body.project}`, {
        pipelineId: id,
        at: stamp(),
      });
      return {
        json: {
          ...out,
          run: out.run ? publicRun(out.run) : null,
          pipelineId: id,
        },
      };
    },
    "POST /api/workspace/connections/:id": async (_req, body, params) => {
      const p = d.plugins.find(
        (p) => p.manifest.id === params.id && p.manifest.kind === "source",
      );
      if (!p || !sourceIds.has(p.manifest.id))
        return {
          status: 400,
          json: { error: "This connector is not available in this version." },
        };
      const current = d.config().plugins[p.manifest.id];
      const previous = await d
        .credentials(p.manifest.id)
        .catch(() => ({}) as Record<string, string>);
      const credentials: Record<string, string> = {};
      const refs: Record<string, string> = {};
      const secrets: Record<string, string> = {};
      for (const field of p.manifest.credentials) {
        const supplied = String(body.credentials?.[field.key] ?? "").trim();
        if (/[\r\n\0]/.test(supplied))
          throw new Error(`Invalid ${field.label}.`);
        const value = supplied || previous[field.key] || field.default || "";
        if (!value && !field.optional)
          throw new Error(`${field.label} is required.`);
        if (!value) continue;
        if (field.pattern && !new RegExp(field.pattern).test(value))
          throw new Error(`Check the format of ${field.label}.`);
        credentials[field.key] = value;
        if (field.secret) {
          const key = `UH_WORKSPACE_${p.manifest.id.toUpperCase()}_${field.key.toUpperCase()}`;
          secrets[key] = value;
          refs[field.key] = `\${${key}}`;
        } else refs[field.key] = value;
      }
      const options = { ...(current?.options ?? {}), ...(body.options ?? {}) };
      const signal = AbortSignal.timeout(30_000);
      const result = await p.probe({
        credentials,
        options,
        http: readOnlyHttp(
          p.manifest.id,
          p.readOnlyPostAllowlist ?? [],
          () => {},
          signal,
        ),
        signal,
        log: () => {},
      } as any);
      if (!result.ok)
        return {
          status: 400,
          json: { error: `${result.summary}. ${result.fix ?? ""}`.trim() },
        };
      const projects = result.detected?.projects as
        | { id: number; name: string }[]
        | undefined;
      if (
        p.manifest.id === "posthog" &&
        projects &&
        projects.length > 1 &&
        !options.projectId
      )
        return {
          status: 409,
          json: {
            error:
              "Choose the PostHog project to connect by entering its project ID.",
            projects,
          },
        };
      if (
        p.manifest.id === "posthog" &&
        projects &&
        options.projectId &&
        !projects.some((x) => String(x.id) === String(options.projectId))
      )
        throw new Error("This key cannot access the selected PostHog project.");
      if (result.detected?.projectId)
        options.projectId = result.detected.projectId;
      // Credentials are persisted only after the live read-only probe succeeds.
      setEngineEnv(secrets);
      for (const [key, value] of Object.entries(secrets))
        process.env[key] = value;
      await d.patch((raw) => {
        raw.plugins = {
          ...(raw.plugins ?? {}),
          [p.manifest.id]: { enabled: true, credentials: refs, options },
        };
      });
      d.store.setKv(probeKey(p.manifest.id), { ...result, at: stamp() });
      return { json: { ok: true, probe: result } };
    },
    "POST /api/workspace/preferences": async (_req, body) => {
      const reserve = Number(body.reserve);
      if (!Number.isFinite(reserve) || reserve < 0 || reserve > 90)
        throw new Error("Choose a reserve between 0 and 90 percent.");
      await d.patch((raw) => {
        raw.governor = { ...raw.governor, humanReservePct: reserve };
      });
      return { json: { ok: true } };
    },
    "POST /api/workspace/service": async () => {
      if (!d.service)
        return {
          status: 400,
          json: {
            error: "Run ultimatehuman service install from your terminal.",
          },
        };
      if (!d.service.installed()) d.service.install();
      return {
        status: 202,
        json: {
          message:
            "Background service installation requested. The engine will reconnect.",
        },
      };
    },
  };
  return Object.fromEntries(
    Object.entries(routes).map(([key, route]) => [
      key,
      async (...args: Parameters<Route>) => {
        try {
          return await route(...args);
        } catch (error) {
          return { status: 400, json: { error: (error as Error).message } };
        }
      },
    ]),
  );
}
