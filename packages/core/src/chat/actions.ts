import type { IncomingMessage } from "node:http";
import type { Config } from "../config/schema";
import { configJsonSchema, SecretRef } from "../config/schema";
import { resolveSecretRefs, type SecretRefValue } from "../config/load";
import type { OutputPlugin, Plugin } from "@ultimatehuman/sdk";
import { readOnlyHttp } from "../plugins/http";
import type { Route } from "../server/http";
import type { PipelineRegistry } from "../pipelines/registry";
import type { PipelineRuntime } from "../pipelines/runtime";
import { TEMPLATES } from "../pipelines/templates";
import { BRIEF_IDS, type BriefId } from "../instructions/instructions";
import { loadEngineEnv } from "../envfile";
import { publicRun } from "../pass/executor";
import { SOURCE_GUIDES, type ConnectionRequests } from "./connections";
import { pendingKey } from "../setup/workspace";
import type { Store } from "../store/store";

export function chatActions(d: {
  routes: Record<string, Route>; config: () => Config; configPath: string;
  registry: PipelineRegistry; runtime: PipelineRuntime; plugins: readonly Plugin[];
  emit: (event: unknown) => void;
  connections: ConnectionRequests;
  store: Store;
}) {
  const call = async (route: string, body: unknown = {}, params: Record<string, string> = {}) => {
    const handler = d.routes[route];
    if (!handler) throw new Error("This workspace operation is unavailable.");
    const response = await handler({} as IncomingMessage, body, params);
    if ((response.status ?? 200) >= 400) throw new Error((response.json as any)?.error || "Operation refused.");
    return response.json as any;
  };
  const status = () => call("GET /api/workspace");
  /** The configured issue tracker that supports read-only lookup (Jira), with a read-only context. Credentials never leave the engine. */
  const tracker = async () => {
    const cfg = d.config();
    const plugin = d.plugins.find((p): p is OutputPlugin => p.manifest.kind === "output" && !!cfg.plugins[p.manifest.id] && cfg.plugins[p.manifest.id]!.enabled !== false && !!(p as OutputPlugin).output.search);
    if (!plugin) throw new Error("No issue tracker with lookup is configured. Jira is set up in plugins.jira (see docs/jira.md).");
    loadEngineEnv();
    const inst = cfg.plugins[plugin.manifest.id]!;
    const credentials: Record<string, string> = {};
    for (const [k, v] of Object.entries(inst.credentials ?? {})) credentials[k] = await resolveSecretRefs(v as SecretRefValue, d.configPath).catch(() => "");
    const signal = AbortSignal.timeout(30_000);
    const ctx = { credentials, options: inst.options ?? {}, http: readOnlyHttp(plugin.manifest.id, plugin.readOnlyPostAllowlist ?? [], () => {}, signal), log: () => {}, signal };
    return { plugin, ctx };
  };
  return {
    context: async () => ({
      workspace: await status(),
      templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, defaults: t.pipeline })),
      connectors: d.plugins.map((p) => ({ ...p.manifest, collectionAvailable: ["posthog", "datadog"].includes(p.manifest.id), guide: SOURCE_GUIDES[p.manifest.id as keyof typeof SOURCE_GUIDES] })),
      connectionRequests: d.connections.list(),
      // Read-only ticket lookup (search_tickets / get_ticket): which tracker and project, never its credentials.
      ticketTracker: (() => {
        const cfg = d.config();
        const p = d.plugins.find((x) => x.manifest.kind === "output" && !!cfg.plugins[x.manifest.id] && cfg.plugins[x.manifest.id]!.enabled !== false && !!(x as OutputPlugin).output.search);
        return p ? { tracker: p.manifest.displayName, project: String(cfg.plugins[p.manifest.id]!.credentials?.projectKey ?? ""), lookup: true } : null;
      })(),
      // Keys the user submitted whose access check failed: references and the diagnosis, never values.
      failedConnections: Object.fromEntries(["posthog", "datadog"].map((id) => [id, d.store.getKv(pendingKey(id))]).filter(([, v]) => v)),
      schema: configJsonSchema(),
    }),
    execute: async (a: Record<string, unknown>): Promise<unknown> => {
      switch (a.action) {
        case "status": return status();
        case "inspect_project": return call("POST /api/workspace/projects", { repository: a.repository, project: a.project });
        case "check_account": return call("POST /api/workspace/provider/check");
        case "activation": return call("POST /api/workspace/activation", a);
        case "investigate": return call("POST /api/workspace/investigate", a);
        case "install_service": return call("POST /api/workspace/service");
        case "request_connection": return { request: d.connections.request(a.source, a.project), awaitingUser: true, message: "The key form is open in chat. Wait for the user to submit it." };
        case "connect_source": {
          const source = String(a.source ?? "");
          const plugin = d.plugins.find((p) => p.manifest.id === source && p.manifest.kind === "source");
          if (!plugin || !["posthog", "datadog"].includes(source)) throw new Error("This source does not have a working collector.");
          loadEngineEnv();
          const values = (a.credentials || {}) as Record<string, unknown>;
          const credentials: Record<string, string> = {};
          const pasted: string[] = [];
          for (const field of plugin.manifest.credentials) {
            const value = values[field.key];
            if (value === undefined || value === null || value === "") continue;
            if (SecretRef.safeParse(value).success) credentials[field.key] = await resolveSecretRefs(value as SecretRefValue, d.configPath);
            else {
              // A key the user pasted into the conversation: the engine stores it outside the chat.
              credentials[field.key] = String(value);
              if (field.secret) pasted.push(String(value));
            }
          }
          const handler = d.routes["POST /api/workspace/connections/:id"]!;
          const response = await handler({} as IncomingMessage, { credentials, options: a.options, acceptFailure: true }, { id: source });
          if (pasted.length) d.store.scrubChat(pasted, `[${plugin.manifest.displayName} key saved outside the chat]`);
          const result = response.json as any;
          if ((response.status ?? 200) >= 400 && !result?.projects) throw new Error(result?.error || "Operation refused.");
          if (result?.ok) d.connections.completeSource(source);
          return result;
        }
        case "search_tickets": {
          const { plugin, ctx } = await tracker();
          const result = await plugin.output.search!(ctx, { query: typeof a.jql === "string" ? a.jql : "", max: Number(a.max) || 25, includeDescription: a.includeDescription === true });
          return { tracker: plugin.manifest.displayName, ...result, count: result.issues.length };
        }
        case "get_ticket": {
          const { plugin, ctx } = await tracker();
          if (!plugin.output.get) throw new Error(`${plugin.manifest.displayName} lookup cannot open single issues.`);
          return { tracker: plugin.manifest.displayName, issue: await plugin.output.get(ctx, String(a.key ?? "")) };
        }
        case "run_pipeline": {
          const id = String(a.pipelineId ?? "");
          if (!d.registry.get(id)) throw new Error("Pipeline not found.");
          const result = d.runtime.trigger(id, "run_now");
          return { ...result, run: result.run ? publicRun(result.run) : null, url: "/pipeline-live" };
        }
        case "get_guidelines":
        case "update_guidelines":
        case "restore_guidelines": {
          const id = String(a.pipelineId ?? "");
          if (!d.registry.get(id)) throw new Error("Pipeline not found.");
          const instructions = d.registry.instructions(id);
          const current = instructions.current().version;
          if (a.action === "get_guidelines") return { pipelineId: id, version: current.version, briefs: current.briefs, history: instructions.versions().map((v) => ({ version: v.version, note: v.note, at: v.at })) };
          if (a.expectedVersion !== current.version) throw new Error("Guidelines changed. Read the current version before editing.");
          if (a.action === "update_guidelines" && !BRIEF_IDS.includes(a.brief as BriefId)) throw new Error("Unknown guideline brief.");
          const saved = a.action === "restore_guidelines" ? instructions.revert(Number(a.version), String(a.note || "Restored through chat")) : instructions.save(a.brief as BriefId, String(a.text ?? ""), String(a.note ?? ""));
          d.emit({ type: "instructions.updated", pipelineId: id, version: saved.version });
          return { pipelineId: id, version: saved.version, note: saved.note };
        }
        default: throw new Error("Unknown workspace operation.");
      }
    },
  };
}
