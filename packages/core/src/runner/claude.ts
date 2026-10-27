import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `claude -p` subprocess runner. Each step gets a read-only tool allowlist
 * (Read, Grep, Glob), no MCP servers, no user settings, --max-turns, and a cwd
 * that holds only the run's signal bundle. The stream-json output carries the
 * real `rate_limit_event`s the governor reads.
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
}

export function claudeBin(): string {
  const local = join(homedir(), ".local", "bin", "claude");
  return process.env.ULTIMATEHUMAN_CLAUDE_BIN ?? (existsSync(local) ? local : "claude");
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
    "--disallowedTools", ...DENIED,
  ];
  if (tools.length) args.push("--allowedTools", ...tools);
  else args.push("--tools", "");
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "ANTHROPIC_API_KEY") continue;
    env[k] = v;
  }
  Object.assign(env, opts.env);

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(claudeBin(), args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const res: ClaudeRunResult = { ok: false, text: "", costUsd: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, rateLimits: [], limitHit: false };
    const transcript: string[] = [];
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 8 * 60_000);
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
        if (ev.type === "rate_limit_event") {
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
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdin.end(opts.prompt);
    child.on("close", async (code) => {
      clearTimeout(timer);
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
      clearTimeout(timer);
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
