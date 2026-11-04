import { spawn, execFileSync } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import {
  ensureHome,
  loadConfig,
  writeConfig,
  defaultConfigPath,
  controlKey,
  homeId,
  claudeBin,
  claudeEnv,
  codexBin, codexEnv, checkProvider, providerFor,
  setEngineEnv,
} from "@ultimatehuman/core";
import type { GlobalFlags } from "../flags";
import { banner, line, spin, c } from "../ui";
import { VERSION } from "./start";


async function freePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Reuse Claude, start the local engine, then continue setup in the shared conversation. */
export async function welcome(flags: GlobalFlags): Promise<number> {
  const home = ensureHome();
  const path = defaultConfigPath();
  const fresh = !existsSync(path);
  banner(VERSION);
  if (fresh) {
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const candidates = flags.provider ? [flags.provider] : ["claude", "codex"] as const;
    const detected = await Promise.all(candidates.map(async (provider) => ({ provider, readiness: await checkProvider(provider, async () => provider === "claude" && oauth ? { CLAUDE_CODE_OAUTH_TOKEN: oauth } : {}) })));
    const selected = detected.find((d) => d.readiness.authenticated) ?? detected.find((d) => d.readiness.available);
    if (!selected) { line.err("AI account", "Install Claude Code or Codex CLI and sign in, then run ultimatehuman again."); return 1; }
    const useCodex = selected.provider === "codex";
    if (!useCodex && oauth) setEngineEnv({ CLAUDE_CODE_OAUTH_TOKEN: oauth });
    await writeConfig({
      auth: { sources: [useCodex ? { id: "local-codex", kind: "codex_login" } : oauth ? { id: "local", kind: "claude_oauth_token", token: "${CLAUDE_CODE_OAUTH_TOKEN}" } : { id: "local", kind: "claude_login" }] },
      server: { port: flags.port || 4747 }, repos: [], pipelines: [], plugins: {},
    }, path);
  }
  let cfg = await loadConfig(path);
  let port = cfg.server.port;
  const health = (): Promise<{ home?: string } | null> =>
    fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    })
      .then(async (r) =>
        r.ok ? ((await r.json()) as { home?: string }) : null,
      )
      .catch(() => null);
  const running = (await health())?.home === homeId();
  if (!running) {
    for (let attempt = 0; !(await freePort(port)); attempt++) {
      if (attempt > 30)
        throw new Error(
          "No local port is available. Pass --port with an available port.",
        );
      port++;
    }
    if (port !== cfg.server.port)
      cfg = await writeConfig(
        { ...cfg, server: { ...cfg.server, port } },
        path,
      );
    const fd = openSync(join(home, "logs", "engine.out"), "a");
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        fileURLToPath(import.meta.url),
        "start",
      ],
      { detached: true, stdio: ["ignore", fd, fd], env: process.env },
    );
    child.unref();
    closeSync(fd);
    await spin("Workspace", "starting your local workspace", async () => {
      for (let i = 0; i < 100; i++) {
        if ((await health())?.home === homeId()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `The engine did not start. See ${join(home, "logs", "engine.out")}.`,
      );
    });
  }
  // Use the running engine's configured identity, exactly as the dashboard does.
  // The original installer verified access with a tiny model call; keep that
  // check in the repository-first entry point before handing off to the browser.
  const checkAccount = async () => {
    const result = await fetch(`http://127.0.0.1:${port}/api/workspace/provider/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-uh-control": controlKey() },
      body: "{}",
    });
    if (result.status === 404) return { available: false, authenticated: false, detail: "The running engine predates account checks. Restart it after current work finishes to verify the saved account.", command: undefined, reason: undefined };
    if (!result.ok) throw new Error("Could not verify the engine’s configured AI account.");
    return ((await result.json()) as { provider: { available: boolean; authenticated: boolean; detail: string; command?: string; reason?: string } }).provider;
  };
  if (flags.provider && providerFor(cfg) !== flags.provider) {
    const switched = await fetch(`http://127.0.0.1:${port}/api/chat/provider`, { method: "POST", headers: { "content-type": "application/json", "x-uh-control": controlKey() }, body: JSON.stringify({ provider: flags.provider }) });
    if (!switched.ok) { const result = await switched.json() as { error: string }; line.err("AI account", result.error); return 1; }
    cfg = await loadConfig(path);
  }
  const chosen = providerFor(cfg);
  const name = chosen === "codex" ? "Codex" : "Claude";
  let account = await spin("AI account", `checking your existing ${name} connection`, checkAccount);
  if (!account.authenticated && account.available && ["claude_login", "codex_login"].includes(cfg.auth.sources[0]!.kind) && !flags.nonInteractive && process.stdin.isTTY) {
    line.warn("AI account", account.detail);
    line.sub(`Opening ${name} sign-in. Complete it in your browser to continue.`);
    const code = await new Promise<number>((resolve) => {
      const login = spawn(chosen === "codex" ? codexBin() : claudeBin(), chosen === "codex" ? ["login"] : ["auth", "login"], { stdio: "inherit", env: chosen === "codex" ? codexEnv() : claudeEnv({}) });
      login.on("error", () => resolve(1));
      login.on("close", (status) => resolve(status ?? 1));
    });
    if (code === 0) account = await checkAccount();
  }
  if (account.authenticated) line.ok("AI account", `Reusing your existing ${name} account · access verified`);
  else {
    line.warn("AI account", account.detail);
    if (account.command) line.sub(`Reconnect with: ${account.command}. Your project and pipeline settings are saved.`);
  }
  let cwd = process.cwd();
  try { cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { /* The conversation asks for the repository. */ }
  if (account.authenticated) {
    const headers = { "content-type": "application/json", "x-uh-control": controlKey() };
    const history = await fetch(`http://127.0.0.1:${port}/api/chat`, { headers }).then((r) => r.json()) as { messages: unknown[] };
    const endpoint = history.messages.length && flags.repos ? "/api/chat" : "/api/chat/start";
    const body = endpoint === "/api/chat" ? { source: "cli", text: `Connect and inspect these repositories: ${flags.repos}. Keep existing pipelines and their settings.` } : { source: "cli", directory: cwd, ...(flags.repos ? { repository: flags.repos } : {}) };
    const started = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!started.ok && started.status !== 404) throw new Error("Could not start the setup conversation.");
    if (started.status === 404) line.warn("Chat", "Restart the engine after its active work finishes to load chat setup.");
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/link`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-uh-control": controlKey(),
    },
    body: "{}",
  });
  if (!response.ok) throw new Error("Could not create a local login link.");
  const { url } = (await response.json()) as { url: string };
  console.log(`\n  ${c.accent("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`);
  const terminalChat = flags.noOpen && !flags.nonInteractive && process.stdin.isTTY;
  console.log(`  ${c.bold(terminalChat ? "CONTINUE IN CHAT" : "CONTINUE IN YOUR BROWSER → CHAT")}`);
  console.log(`  ${c.accent("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`);
  console.log(`\n  ${terminalChat ? "Your setup chat starts below." : fresh ? "Setup continues in your browser chat." : "Your workspace is ready in the browser."}`);
  console.log(`  ${cfg.auth.sources[0]?.kind === "anthropic_api_key" ? "Chat uses your configured Claude API account." : chosen === "codex" ? "Chat uses your existing Codex ChatGPT subscription and its usage limits." : "Chat uses your existing Claude Code subscription and its usage limits."}`);
  console.log(`\n  Next: tell ${name} which project you want to start with`);
  console.log("  and which repositories belong to it (frontend, backend, etc.).");
  console.log(`  ${name} will connect your tracking tools and set up the first pipeline.`);
  if (!terminalChat) console.log(`\n  ${c.bold("You can leave this terminal. Continue setup in the browser.")}`);
  console.log(`\n  ${c.muted(terminalChat ? "Open the same conversation in your browser:" : "Browser did not open? Ctrl-click this single-use login link:")}`);
  console.log(`  ${url}\n`);
  if (!flags.noOpen && !flags.nonInteractive) {
    const opener =
      process.env.BROWSER ||
      (process.platform === "darwin" ? "open" : "xdg-open");
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.on("error", () =>
      line.sub("Open the login link above in your browser."),
    );
    child.unref();
  }
  if (terminalChat) {
    const { chat } = await import("./chat");
    return chat([]);
  }
  return 0;
}
