import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeBin, claudeEnv, runClaude } from "../runner/claude";
import { codexBin, codexEnv, withCodex, runCodex } from "../runner/codex";
import type { AgentProvider } from "../runner/provider";
import { homedir } from "node:os";

const exec = promisify(execFile);
export interface ProviderReadiness {
  available: boolean;
  authenticated: boolean;
  label: string;
  detail: string;
  command?: string;
  reason?: "expired" | "login" | "unavailable" | "unverified";
  verifiedAt?: string;
  cliVersion?: string;
  cliPath?: string;
  configDirectory?: string;
  authMethod?: string;
}

export const checkProvider = (provider: AgentProvider, env: () => Promise<Record<string, string>>, verifyIn?: string) =>
  provider === "codex" ? checkCodexProvider(env, verifyIn) : checkClaudeProvider(env, verifyIn);

export async function checkCodexProvider(runnerEnv: () => Promise<Record<string, string>>, verifyIn?: string): Promise<ProviderReadiness> {
  const base = { label: "Codex", cliPath: codexBin(), command: "codex login", authMethod: "Local Codex ChatGPT login" };
  let cliVersion: string;
  try { cliVersion = (await exec(codexBin(), ["--version"], { timeout: 5000, env: codexEnv() })).stdout.trim(); }
  catch { return { ...base, available: false, authenticated: false, reason: "unavailable", detail: "Install Codex CLI on this machine, then sign in with ChatGPT." }; }
  try {
    const env = await runnerEnv();
    const account = await withCodex(verifyIn ?? homedir(), env, (client) => client.request("account/read", { refreshToken: false }));
    if (account.account?.type !== "chatgpt") return { ...base, cliVersion, available: true, authenticated: false, reason: "login", detail: "Sign in to Codex with ChatGPT to use your subscription. An API-key login is not used by this connection." };
    if (verifyIn) {
      const probe = await runCodex({ prompt: "Reply with the single word ok. Do not use tools.", cwd: verifyIn, model: "", maxTurns: 1, tools: [], env, timeoutMs: 45_000 });
      if (!probe.ok && !probe.limitHit) return { ...base, cliVersion, available: true, authenticated: false, reason: "unverified", detail: "Codex is signed in but could not complete the connection check. Check its model access or retry." };
      return { ...base, cliVersion, available: true, authenticated: true, verifiedAt: new Date().toISOString(), detail: probe.limitHit ? "Codex account detected. Its usage limit is currently reached." : "Your existing Codex account responded successfully. This workspace reuses that account." };
    }
    return { ...base, cliVersion, available: true, authenticated: true, detail: "Your existing Codex ChatGPT login is connected." };
  } catch { return { ...base, cliVersion, available: true, authenticated: false, reason: "unverified", detail: "Could not check the Codex account. Open Codex on this machine, then retry." }; }
}

/** Checks the runner's account; an explicit verifyIn requests one tiny live AI call. */
export async function checkClaudeProvider(runnerEnv: () => Promise<Record<string, string>>, verifyIn?: string): Promise<ProviderReadiness> {
  let identity: Pick<ProviderReadiness, "cliVersion" | "cliPath" | "configDirectory" | "authMethod"> = { cliPath: claudeBin() };
  try {
    const version = await exec(claudeBin(), ["--version"], { timeout: 5000 });
    identity.cliVersion = version.stdout.trim();
  } catch {
    return { available: false, authenticated: false, label: "Claude Code", detail: "Install Claude Code on this machine, then sign in.", command: "claude auth login" };
  }
  try {
    const overrides = await runnerEnv();
    const env = claudeEnv(overrides);
    // A signed-out CLI exits 1 but still supplies JSON on stdout.
    const result = await exec(claudeBin(), ["--setting-sources", "", "auth", "status"], { env, timeout: 5000 })
      .catch((error: any) => ({ stdout: String(error.stdout ?? "") }));
    let status: any = {};
    try { status = JSON.parse(result.stdout); } catch { /* Older CLIs may not expose auth status; keep the original live verification. */ }
    identity = { ...identity, ...(status.configDirectory ? { configDirectory: status.configDirectory } : {}),
      authMethod: overrides.CLAUDE_CODE_OAUTH_TOKEN ? "Configured OAuth token" : overrides.ANTHROPIC_API_KEY ? "Configured API key" : "Local Claude login" };
    if (verifyIn) {
      const probe = await runClaude({ prompt: "Reply with the single word ok.", cwd: verifyIn, model: "haiku", maxTurns: 1, tools: [], env: overrides, timeoutMs: 30_000 });
      const verifiedAt = new Date().toISOString();
      if (probe.ok)
        return { ...identity, available: true, authenticated: true, label: "Claude Code", detail: "Your existing Claude account responded successfully. This workspace reuses that account.", verifiedAt };
      if (/oauth.*expired|session expired|token.*expired/i.test(`${probe.text} ${probe.error}`))
        return { ...identity, available: true, authenticated: false, label: "Claude Code", reason: "expired", detail: "Your existing Claude login has expired and could not refresh automatically. Reconnect the account to resume investigations; your workspace setup is preserved.", command: "claude auth login", verifiedAt };
      if (probe.limitHit && status.loggedIn === true)
        return { ...identity, available: true, authenticated: true, label: "Claude Code", detail: "Claude account detected. The account is currently at its usage limit.", verifiedAt };
      return { ...identity, available: true, authenticated: false, label: "Claude Code", reason: "unverified", detail: "The configured Claude account could not complete the connection check. Check its login and model access, then retry.", command: "claude auth status", verifiedAt };
    }
    if (status.loggedIn === true)
      return { ...identity, available: true, authenticated: true, label: "Claude Code", detail: "Sign-in detected for the engine’s configured account. Model access is checked when the investigation starts." };
    return { ...identity, available: true, authenticated: false, label: "Claude Code", reason: "login", detail: "The engine could not verify an active Claude session. Check the existing account connection to continue.", command: "claude auth login" };
  } catch {
    return { ...identity, available: true, authenticated: false, label: "Claude Code", detail: "The engine could not verify its configured AI credentials. Check the account and try again.", command: "claude auth status" };
  }
}
