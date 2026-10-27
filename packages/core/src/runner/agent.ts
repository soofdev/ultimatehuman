/**
 * Agent runner abstraction. v1 implementation shells out to the user's own
 * `claude -p` (Claude Code login or setup-token) with a read-only tool
 * allowlist; an Agent SDK implementation is a drop-in alternative.
 * Every task is checkpointable: the runner returns a resumable handle when a
 * usage limit interrupts it.
 */

export interface AgentTask {
  kind: "correlate" | "root_cause" | "dedupe" | "write_issue";
  prompt: string;
  /** Files the agent may read (signal bundle, repo checkout). No write tools are granted. */
  readPaths: readonly string[];
  maxTurns: number;
  /** JSON schema the final answer must satisfy; anything else is a failed step. */
  outputSchema: unknown;
}

export type AgentResult =
  | { status: "ok"; output: unknown; usage: { inputTokens: number; outputTokens: number; usd?: number } }
  | { status: "limit_hit"; checkpoint: string; resetsAt: string | null }
  | { status: "error"; message: string };

export interface AgentRunner {
  run(task: AgentTask, env: Record<string, string>, signal: AbortSignal): Promise<AgentResult>;
  /** Read real remaining usage for a subscription source, if the CLI exposes it. */
  readWindow?(env: Record<string, string>): Promise<{ usedPct: number | null; resetsAt: string | null }>;
}
