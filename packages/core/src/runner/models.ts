import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { claudeBin, claudeEnv } from "./claude";
import { DEFAULT_MODEL } from "../config/schema";
import { readCodexModels } from "./codex";
import type { AgentProvider } from "./provider";

export interface ChatModel {
  id: string;
  label: string;
  description: string;
  aliases: string[];
  isDefault?: boolean;
}

/** Use the installed CLI's catalog, including its account-specific aliases. */
function normalizeModels(input: unknown): ChatModel[] {
  if (!Array.isArray(input)) return [];
  const models = new Map<string, ChatModel>();
  for (const entry of input) {
    const id = entry?.resolvedModel || entry?.value;
    if (typeof id !== "string" || !/^[A-Za-z0-9._\[\]-]+$/.test(id) || typeof entry.displayName !== "string") continue;
    const previous = models.get(id);
    const aliases = [...new Set([...(previous?.aliases ?? []), entry.value].filter((v): v is string => typeof v === "string"))];
    if (previous && entry.value === "default") { previous.aliases = aliases; continue; }
    models.set(id, { id, label: entry.displayName, description: typeof entry.description === "string" ? entry.description : "", aliases });
  }
  return [...models.values()].sort((a, b) => Number(b.id === DEFAULT_MODEL) - Number(a.id === DEFAULT_MODEL));
}

/** Initialization metadata only: no user prompt, model inference, or chat session is sent. */
export function readClaudeModels(cwd: string, env: Record<string, string>): Promise<ChatModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--setting-sources", "", "--tools", ""], { cwd, env: claudeEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    const requestId = randomUUID();
    let finished = false;
    let buffer = "";
    const finish = (error?: string, models?: ChatModel[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      child.stdin.end();
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
      kill.unref();
      child.once("close", () => clearTimeout(kill));
      if (error) reject(new Error(error)); else resolve(models!);
    };
    const timeout = setTimeout(() => finish("Claude Code did not return its models. Check the account connection and try again."), 12_000);
    child.on("error", () => finish("Could not open Claude Code to read its models."));
    child.stdin.on("error", () => finish("Claude Code closed the model connection. Try again."));
    // Never surface account metadata or raw CLI output (which may contain credentials).
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { finish("Claude Code returned an unreadable model list."); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== "control_response" || event.response?.request_id !== requestId) continue;
        const models = normalizeModels(event.response?.response?.models);
        if (event.response?.subtype !== "success" || !models.length) finish("This Claude Code installation did not provide a model list. Update Claude Code and retry.");
        else finish(undefined, models);
      }
    });
    child.on("close", () => finish("Claude Code closed before returning its models. Check the account connection and try again."));
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize", hooks: {} } }) + "\n");
  });
}

/** Coalesce concurrent browser requests and avoid starting a CLI for each poll. */
export function claudeModelCatalog(cwd: string, environment: () => Promise<Record<string, string>>, provider: AgentProvider = "claude") {
  let cached: { models: ChatModel[]; at: number } | undefined;
  let pending: Promise<ChatModel[]> | undefined;
  return (refresh = false): Promise<ChatModel[]> => {
    if (pending) return pending;
    if (!refresh && cached && Date.now() - cached.at < 5 * 60_000) return Promise.resolve(cached.models);
    cached = undefined;
    pending = environment().then((env) => provider === "codex" ? readCodexModels(cwd, env) : readClaudeModels(cwd, env)).then((models) => {
      cached = { models, at: Date.now() };
      return models;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
