import type { IncomingMessage } from "node:http";
import type { Config } from "../config/schema";
import { configJsonSchema, SecretRef } from "../config/schema";
import { resolveSecretRefs, type SecretRefValue } from "../config/load";
import type { Plugin } from "@ultimatehuman/sdk";
import type { Route } from "../server/http";
import type { PipelineRegistry } from "../pipelines/registry";
import type { PipelineRuntime } from "../pipelines/runtime";
import { TEMPLATES } from "../pipelines/templates";
import { BRIEF_IDS, type BriefId } from "../instructions/instructions";
import { loadEngineEnv } from "../envfile";
import { publicRun } from "../pass/executor";
import { SOURCE_GUIDES, type ConnectionRequests } from "./connections";

export function chatActions(d: {
  routes: Record<string, Route>; config: () => Config; configPath: string;
  registry: PipelineRegistry; runtime: PipelineRuntime; plugins: readonly Plugin[];
  emit: (event: unknown) => void;
  connections: ConnectionRequests;
}) {
  const call = async (route: string, body: unknown = {}, params: Record<string, string> = {}) => {
    const handler = d.routes[route];
    if (!handler) throw new Error("This workspace operation is unavailable.");
    const response = await handler({} as IncomingMessage, body, params);
    if ((response.status ?? 200) >= 400) throw new Error((response.json as any)?.error || "Operation refused.");
    return response.json as any;
  };
  const status = () => call("GET /api/workspace");
  return {
    context: async () => ({
      workspace: await status(),
      templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, defaults: t.pipeline })),
      connectors: d.plugins.map((p) => ({ ...p.manifest, collectionAvailable: ["posthog", "datadog"].includes(p.manifest.id), guide: SOURCE_GUIDES[p.manifest.id as keyof typeof SOURCE_GUIDES] })),
      connectionRequests: d.connections.list(),
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
        case "request_connection": return { request: d.connections.request(a.source, a.project), awaitingUser: true, message: "The connection form is available in chat. Wait for the user to submit it; do not ask for a terminal command or a key in a message." };
        case "connect_source": {
          const source = String(a.source ?? "");
          const plugin = d.plugins.find((p) => p.manifest.id === source && p.manifest.kind === "source");
          if (!plugin || !["posthog", "datadog"].includes(source)) throw new Error("This source does not have a working collector.");
          loadEngineEnv();
          const values = (a.credentials || {}) as Record<string, unknown>;
          const credentials: Record<string, string> = {};
          for (const field of plugin.manifest.credentials) {
            const value = values[field.key];
            if (value === undefined) continue;
            if (field.secret) {
              if (!SecretRef.safeParse(value).success) throw new Error(`Use request_connection to collect ${field.label} in the connection form; chat only accepts secret references.`);
              credentials[field.key] = await resolveSecretRefs(value as SecretRefValue, d.configPath);
            } else credentials[field.key] = String(value);
          }
          return call("POST /api/workspace/connections/:id", { credentials, options: a.options }, { id: source });
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
