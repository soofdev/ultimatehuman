import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvFile } from "../envfile";

/**
 * Autonomous passes get read-only tools. Interactive setup additionally uses
 * Claude's native shell/edit/web tools and forwards permission requests to the
 * shared chat. Stream-json carries the real rate limits the governor reads.
 */

export interface RateLimitReading {
  status: "allowed" | "allowed_warning" | "rejected" | string;
  rateLimitType?: string;
  resetsAt?: number;
  fiveHourPct?: number;
  fiveHourResetsAt?: number;
  sevenDayPct?: number;
  sevenDayResetsAt?: number;
  observedAt: string;
}

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  sessionId?: string;
  costUsd: number;
  durationMs: number;
  numTurns?: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  rateLimits: RateLimitReading[];
  limitHit: boolean;
  error?: string;
}

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  maxTurns: number;
  env: Record<string, string>;
  tools?: readonly string[];
  resumeSessionId?: string;
  signal?: AbortSignal;
  transcriptPath?: string;
  timeoutMs?: number;
  /** Extra read-only directories (the connected repo checkout). Tools stay Read/Grep/Glob. */
  addDirs?: readonly string[];
  /** Appended to Claude Code's system prompt (the setup chat's role and rules). */
  appendSystemPrompt?: string;
  /** Interactive setup uses Claude's native permission protocol; autonomous passes stay read-only. */
  interactive?: {
    permission: (tool: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;
    activity?: (tool: string) => void;
    /** The user's own session rights: no sandbox and no approval prompts (Codex); Claude's requests are granted by `permission`. */
    fullAccess?: boolean;
  };
}

export function claudeBin(): string {
  const local = join(homedir(), ".local", "bin", "claude");
  return process.env.ULTIMATEHUMAN_CLAUDE_BIN ?? (existsSync(local) ? local : "claude");
}

/** Use the same authentication environment for readiness checks and model calls. */
export function claudeEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const engineSecrets = new Set(readEnvFile().keys());
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "ANTHROPIC_API_KEY") continue;
    if (engineSecrets.has(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, overrides);
}

const DENIED = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "Skill"];

export function parseRateLimit(ev: any): RateLimitReading | null {
  const info = ev?.rate_limit_info;
  if (!info) return null;
  const w = info.unifiedWindows ?? {};
  const pct = (u: unknown) => (typeof u === "number" ? Math.round(u * 1000) / 10 : undefined);
  const r: RateLimitReading = { status: info.status, observedAt: new Date().toISOString() };
  if (info.rateLimitType) r.rateLimitType = info.rateLimitType;
  if (typeof info.resetsAt === "number") r.resetsAt = info.resetsAt;
  const f = pct(w.five_hour?.utilization ?? (info.rateLimitType === "five_hour" ? info.utilization : undefined));
  if (f !== undefined) r.fiveHourPct = f;
  if (w.five_hour?.resetsAt) r.fiveHourResetsAt = w.five_hour.resetsAt;
  const s = pct(w.seven_day?.utilization);
  if (s !== undefined) r.sevenDayPct = s;
  if (w.seven_day?.resetsAt) r.sevenDayResetsAt = w.seven_day.resetsAt;
  return r;
}

export function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const tools = opts.tools ?? ["Read", "Grep", "Glob"];
  const args = [
    "-p",
    "--model", opts.model,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", String(opts.maxTurns),
    "--strict-mcp-config",
    "--setting-sources", "",
    // A tool the caller allows on purpose is not denied wholesale; a path-scoped Edit(...) rule also scopes Write.
    "--disallowedTools", ...DENIED.filter((t) => !(opts.interactive && ["Bash", "Write", "Edit", "WebFetch", "WebSearch"].includes(t)) && !tools.some((a) => { const n = a.split("(")[0]; return n === t || (n === "Edit" && t === "Write"); })),
  ];
  if (opts.interactive) args.push("--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--permission-mode", "default", "--tools", "Read,Grep,Glob,Bash,Write,Edit,WebSearch,WebFetch");
  if (tools.length) args.push("--allowedTools", ...tools);
  else args.push("--tools", "");
  if (opts.resumeSessionId) args.push(`--resume=${opts.resumeSessionId}`);
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);

  const env = claudeEnv(opts.env);

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(claudeBin(), args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const res: ClaudeRunResult = { ok: false, text: "", costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, rateLimits: [], limitHit: false };
    const transcript: string[] = [];
    let buf = "";
    let stderr = "";
    const permissionAbort = new AbortController();
    let finished = false;
    let timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 8 * 60_000);
    const controls = new Map<string, AbortController>();
    const write = (value: unknown) => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(value) + "\n"); };
    let prompted = false;
    const sendPrompt = () => {
      if (prompted) return;
      prompted = true;
      write({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: opts.prompt } });
    };
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        transcript.push(line);
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (opts.interactive && ev.type === "control_response" && ev.response?.request_id === "uh-initialize") {
          if (ev.response.subtype === "error") { res.error = "Claude could not initialize interactive setup."; child.stdin.end(); }
          else sendPrompt();
        } else if (opts.interactive && ev.type === "control_cancel_request") {
          controls.get(ev.request_id)?.abort();
        } else if (opts.interactive && ev.type === "control_request") {
          const controller = new AbortController();
          controls.set(ev.request_id, controller);
          const cancel = () => controller.abort();
          permissionAbort.signal.addEventListener("abort", cancel, { once: true });
          clearTimeout(timer);
          // Waiting never grants permission. Expiry aborts the running turn.
          timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
          void (async () => {
            const allowed = ev.request?.subtype === "can_use_tool" && await opts.interactive!.permission(ev.request.tool_name, ev.request.input ?? {}, controller.signal);
            if (!controller.signal.aborted) write({ type: "control_response", response: { subtype: "success", request_id: ev.request_id, response: allowed ? { behavior: "allow", updatedInput: ev.request.input } : { behavior: "deny", message: "The user did not approve this operation. Continue without it." } } });
          })().catch(() => write({ type: "control_response", response: { subtype: "error", request_id: ev.request_id, error: "The permission request could not be completed." } })).finally(() => {
            controls.delete(ev.request_id);
            permissionAbort.signal.removeEventListener("abort", cancel);
            clearTimeout(timer);
            if (!finished) timer = setTimeout(() => child.kill("SIGTERM"), controls.size ? 15 * 60_000 : opts.timeoutMs ?? 8 * 60_000);
          });
        } else if (ev.type === "assistant" && opts.interactive) {
          for (const block of ev.message?.content ?? []) if (block.type === "tool_use") opts.interactive.activity?.(block.name);
        } else if (ev.type === "rate_limit_event") {
          const r = parseRateLimit(ev);
          if (r) {
            res.rateLimits.push(r);
            if (r.status === "rejected") res.limitHit = true;
          }
        } else if (ev.type === "system" && ev.subtype === "init") {
          res.model = ev.model;
          res.sessionId = ev.session_id;
        } else if (ev.type === "result") {
          res.ok = !ev.is_error && ev.subtype === "success";
          res.text = typeof ev.result === "string" ? ev.result : "";
          res.costUsd = ev.total_cost_usd ?? 0;
          res.numTurns = ev.num_turns;
          res.sessionId = ev.session_id ?? res.sessionId;
          res.inputTokens = (ev.usage?.input_tokens ?? 0) + (ev.usage?.cache_read_input_tokens ?? 0) + (ev.usage?.cache_creation_input_tokens ?? 0);
          res.outputTokens = ev.usage?.output_tokens ?? 0;
          if (!res.ok) res.error = `${ev.subtype}${ev.result ? `: ${String(ev.result).slice(0, 300)}` : ""}`;
          if (/limit/i.test(res.error ?? "") && /reset|usage/i.test(res.error ?? "")) res.limitHit = true;
          if (opts.interactive) child.stdin.end();
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdin.on("error", () => {}); // A cancelled CLI may close the pipe during a pending approval.
    if (opts.interactive) write({ type: "control_request", request_id: "uh-initialize", request: { subtype: "initialize", hooks: {} } });
    else child.stdin.end(opts.prompt);
    child.on("close", async (code) => {
      finished = true;
      clearTimeout(timer);
      permissionAbort.abort();
      opts.signal?.removeEventListener("abort", onAbort);
      res.durationMs = Date.now() - started;
      if (!res.ok && !res.error) res.error = `claude exited ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`;
      if (opts.transcriptPath) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(opts.transcriptPath, transcript.join("\n") + "\n", { mode: 0o600 }).catch(() => {});
      }
      resolve(res);
    });
    child.on("error", (e) => {
      finished = true;
      clearTimeout(timer);
      permissionAbort.abort();
      res.error = e.message;
      res.durationMs = Date.now() - started;
      resolve(res);
    });
  });
}

/** Extract the last JSON object from an agent answer (fenced or bare). */
export function extractJson(text: string): unknown {
  const fence = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = fence.length ? fence.reverse() : [];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  throw new Error("no JSON object in the agent answer");
}
