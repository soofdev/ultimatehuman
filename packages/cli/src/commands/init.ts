import { spawn, execFileSync } from "node:child_process";
import { openSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { ensureHome, controlKey, homeId, writeConfig, defaultConfigPath, runClaude, claudeBin, readOnlyHttp, type RateLimitReading } from "@ultimatehuman/core";
import type { Plugin, ProbeResult } from "@ultimatehuman/sdk";
import { bundledPlugins } from "../plugins";
import type { GlobalFlags } from "../flags";
import { banner, section, line, spin, ask, choose, closePrompts, c } from "../ui";
import { VERSION } from "./start";

interface Check {
  id: string;
  label: string;
  status: "ok" | "warn" | "missing" | "fail";
  summary: string;
  detail?: string;
  helpUrl?: string;
  at: string;
}

const tilde = (p: string) => p.replace(homedir(), "~");
const hhmm = (epoch?: number) => (epoch ? new Date(epoch * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "?");

function findEnv(names: readonly string[]): { name: string; value: string } | null {
  for (const n of names) if (process.env[n]) return { name: n, value: process.env[n]! };
  return null;
}

function gitTopLevel(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

function gitRemoteRepo(): string | undefined {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1];
  } catch {
    return undefined;
  }
}

let port = 4747;

/** What answers on a port: our own engine, another install's engine, or nothing. */
async function whoIsOn(p: number): Promise<"mine" | "other" | "free"> {
  const h = await fetch(`http://127.0.0.1:${p}/api/health`).then((r) => (r.ok ? r.json() : null)).catch(() => undefined);
  if (h === undefined) return "free";
  return h && (h as { home?: string }).home === homeId() ? "mine" : "other";
}

async function api(path: string, body?: unknown): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-uh-control": controlKey() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

export async function init(flags: GlobalFlags, args: string[]): Promise<number> {
  try {
    return await runInit(flags, args);
  } finally {
    closePrompts();
  }
}

async function runInit(flags: GlobalFlags, _args: string[]): Promise<number> {
  const t0 = Date.now();
  const checks: Check[] = [];
  const add = (ch: Omit<Check, "at">) => checks.push({ ...ch, at: new Date().toISOString() });
  const timings: Record<string, number> = {};
  const mark = (k: string) => (timings[k] = Date.now() - t0);
  const TOTAL = 4;

  banner(VERSION);

  // ── 1. detect ────────────────────────────────────────────────────────────
  section("Detecting what is already on this machine", TOTAL);
  const [major] = process.versions.node.split(".").map(Number);
  if ((major ?? 0) < 22) {
    line.err("Node", `${process.versions.node}: ultimatehuman needs Node 22 or newer`);
    return 1;
  }
  line.ok("Node", process.versions.node);

  let claudeVersion = "";
  try {
    claudeVersion = execFileSync(claudeBin(), ["--version"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(" ")[0] ?? "";
  } catch {
    /* not installed */
  }
  const oauth = findEnv(["CLAUDE_CODE_OAUTH_TOKEN"]);
  const hasLoginFile = existsSync(join(homedir(), ".claude", ".credentials.json"));
  if (!claudeVersion) {
    line.err("Claude", "Claude Code is not installed. Install it, run `claude` once to sign in, then rerun init.");
    return 1;
  }
  const authKind = oauth ? "claude_oauth_token" : "claude_login";
  line.ok("Claude", `Claude Code ${claudeVersion} · ${oauth ? `signed in via ${c.bold("$" + oauth.name)}` : hasLoginFile ? "signed in (local login)" : "login not detected yet"} · ${c.muted("uses your subscription")}`);
  add({ id: "claude.detect", label: "Claude", status: "ok", summary: `Claude Code ${claudeVersion}, ${oauth ? `token from $${oauth.name}` : "local login"}` });

  const found: Record<string, { env: string; value: string }> = {};
  for (const p of bundledPlugins) {
    const secret = p.manifest.credentials.find((f) => f.secret);
    if (!secret) continue;
    const hit = findEnv([secret.preferredEnv, ...(secret.alternateEnv ?? [])]);
    if (hit) {
      found[p.manifest.id] = { env: hit.name, value: hit.value };
      line.ok(p.manifest.displayName, `key found in ${c.bold("$" + hit.name)}`);
      add({ id: `${p.manifest.id}.detect`, label: p.manifest.displayName, status: "ok", summary: `Key found in $${hit.name}` });
    } else if (p.manifest.kind === "output") {
      line.skip(p.manifest.displayName, `no $${secret.preferredEnv}: issues will be previewed, never created (dry run)`);
      add({ id: `${p.manifest.id}.detect`, label: p.manifest.displayName, status: "missing", summary: `No $${secret.preferredEnv}: dry run, issues are previewed and never created`, helpUrl: secret.helpUrl });
    } else {
      line.skip(p.manifest.displayName, `no $${secret.preferredEnv} · add later: ${secret.helpUrl}`);
      add({ id: `${p.manifest.id}.detect`, label: p.manifest.displayName, status: "missing", summary: `No $${secret.preferredEnv}. Optional, add it later.`, helpUrl: secret.helpUrl });
    }
  }
  const sources = bundledPlugins.filter((p) => p.manifest.kind === "source" && found[p.manifest.id]);
  if (!sources.length) {
    line.err("Sources", "no tracker key found. Export POSTHOG_PERSONAL_API_KEY or SENTRY_AUTH_TOKEN and rerun.");
    return 2;
  }
  mark("detect");

  // ── 2. live probes ───────────────────────────────────────────────────────
  section("Checking each one live (read-only)", TOTAL);
  const cp = await spin("Claude", "sending one tiny prompt to read your usage window", () =>
    runClaude({ prompt: "Reply with the single word ok.", cwd: ensureHome(), model: "haiku", maxTurns: 1, tools: [], env: oauth ? { CLAUDE_CODE_OAUTH_TOKEN: oauth.value } : {} }),
  );
  const rl: RateLimitReading | undefined = cp.rateLimits.at(-1);
  if (!cp.ok) {
    line.err("Claude", `${cp.error ?? "no answer"} · run \`claude\` once to sign in, then rerun init`);
    return 1;
  }
  const windowLine = rl?.fiveHourPct !== undefined ? `window ${rl.fiveHourPct}% used · resets ${hhmm(rl.fiveHourResetsAt)} · 30% always kept for you` : "window usage not reported by this CLI: the radar will admit one small step at a time";
  line.ok("Claude", `answered in ${(cp.durationMs / 1000).toFixed(1)}s · ${windowLine}`);
  add({ id: "claude.probe", label: "Claude", status: "ok", summary: `Answered in ${(cp.durationMs / 1000).toFixed(1)}s`, detail: windowLine });
  mark("probe_claude");

  const pluginConfig: Record<string, any> = {};
  const probeResults: Record<string, ProbeResult> = {};
  for (const p of sources) {
    const secret = p.manifest.credentials.find((f) => f.secret)!;
    const hostField = p.manifest.credentials.find((f) => f.key === "host");
    const creds: Record<string, string> = { [secret.key]: found[p.manifest.id]!.value };
    const hostEnv = hostField ? findEnv([hostField.preferredEnv]) : null;
    const hosts = hostEnv ? [hostEnv.value] : p.manifest.id === "posthog" ? ["https://us.posthog.com", "https://eu.posthog.com"] : [hostField?.default ?? ""];
    let res: ProbeResult | null = null;
    let host = hosts[0]!;
    for (const h of hosts) {
      host = h;
      if (hostField) creds[hostField.key] = h;
      const ctx = { credentials: creds, options: {}, http: readOnlyHttp(p.manifest.id, p.readOnlyPostAllowlist ?? [], () => {}), log: () => {}, signal: new AbortController().signal };
      res = await spin(p.manifest.displayName, `probing ${h.replace("https://", "")}`, () => (p as Plugin).probe(ctx as any));
      if (res.ok) break;
    }
    probeResults[p.manifest.id] = res!;
    if (!res!.ok) {
      line.err(p.manifest.displayName, `${res!.summary}${res!.fix ? ` · ${res!.fix}` : ""}`);
      add({ id: `${p.manifest.id}.probe`, label: p.manifest.displayName, status: "fail", summary: res!.summary, ...(res!.fix ? { detail: res!.fix } : {}) });
      continue;
    }
    line.ok(p.manifest.displayName, res!.summary);
    if (!hostEnv && hostField) line.sub(`host auto-detected: ${host}`);
    add({ id: `${p.manifest.id}.probe`, label: p.manifest.displayName, status: "ok", summary: res!.summary, detail: `Read-only probe against ${host}` });
    if (res!.overScoped?.length) {
      line.warn(p.manifest.displayName, `this key can also write (${res!.overScoped.length} write scopes). ultimatehuman only ever reads;`);
      line.sub(`a read-only key is safer: ${secret.helpUrl}`);
      add({ id: `${p.manifest.id}.scopes`, label: p.manifest.displayName, status: "warn", summary: `Key is broader than needed: ${res!.overScoped.length} write scopes`, detail: "ultimatehuman only sends GET requests and read-only HogQL queries. Create a read-only key to be safe.", helpUrl: secret.helpUrl });
    }
    let projectId = String(res!.detected?.projectId ?? "");
    const projects = (res!.detected?.projects as { id: number; name: string; events7d: number }[] | undefined) ?? [];
    if (flags.project && p.manifest.id === "posthog") {
      if (!projects.some((x) => String(x.id) === flags.project)) {
        line.err(p.manifest.displayName, `--project ${flags.project} is not visible to this key; it sees ${projects.map((x) => `${x.name} (${x.id})`).join(", ")}`);
        return 2;
      }
      projectId = flags.project;
    } else if (projects.length > 1) {
      // Inside a checkout, the project named like the repo is the likely answer ("Jalsa app" for .../jalsa).
      const slug = (process.env.ULTIMATEHUMAN_GITHUB_REPO ?? gitRemoteRepo())?.split("/")[1]?.toLowerCase().replace(/[^a-z0-9]/g, "");
      const match = slug ? projects.findIndex((x) => x.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(slug)) : -1;
      const def = match >= 0 ? match : Math.max(0, projects.findIndex((x) => String(x.id) === projectId));
      if (flags.nonInteractive) projectId = String(projects[def]!.id);
      else {
        console.log("");
        const i = await choose(
          `Which PostHog project should the radar watch?${match >= 0 ? c.muted(" (preselected: its name matches this repo)") : ""}`,
          projects.map((x) => `${x.name} ${c.muted(`(${x.id}) · ${x.events7d.toLocaleString("en-US")} events in 7 days`)}`),
          def,
        );
        projectId = String(projects[i]!.id);
      }
    }
    const chosen = projects.find((x) => String(x.id) === projectId);
    if (chosen && projects.length > 1) {
      const watch = `Watching "${chosen.name}" (${chosen.id}) · ${chosen.events7d.toLocaleString("en-US")} events in the last 7 days`;
      line.ok(p.manifest.displayName, watch);
      add({ id: `${p.manifest.id}.project`, label: p.manifest.displayName, status: "ok", summary: watch, detail: `${projects.length} projects visible to this key; you picked this one in init` });
    }
    pluginConfig[p.manifest.id] = {
      credentials: { [secret.key]: `\${${found[p.manifest.id]!.env}}`, ...(hostField ? { [hostField.key]: host } : {}) },
      options: { projectId, excludeTeamMembers: true },
    };
  }
  if (!Object.keys(pluginConfig).length) return 1;
  mark("probe_sources");

  const repoDefault = process.env.ULTIMATEHUMAN_GITHUB_REPO ?? gitRemoteRepo();
  console.log("");
  const repo = flags.repo ?? (flags.nonInteractive ? repoDefault ?? "" : await ask("GitHub repo for issues (owner/name):", repoDefault));
  closePrompts();
  if (repo) {
    const gh = found.github;
    pluginConfig.github = {
      credentials: { ...(gh ? { token: `\${${gh.env}}` } : {}), repo },
      options: { labels: ["ultimatehuman"], dryRun: true },
    };
    const how = flags.repo ? "from --repo" : process.env.ULTIMATEHUMAN_GITHUB_REPO ? "from $ULTIMATEHUMAN_GITHUB_REPO" : repo === repoDefault && repoDefault ? "from this folder's git remote" : "typed";
    line.ok("GitHub", `${repo} · ${c.muted(`${how} · dry run: issues are previewed, never created`)}`);
    add({ id: "github.repo", label: "GitHub", status: "ok", summary: `Issues go to ${repo} (${how})`, detail: "Dry run: issues are rendered and previewed, never created" });
  }
  // The checkout we were started in becomes the read-only code the root-cause agents may read.
  const codePath = repo && repo === gitRemoteRepo() ? gitTopLevel() : undefined;
  if (codePath) {
    line.ok("Code", `${tilde(codePath)} ${c.muted("· read-only: agents may Read/Grep it to cite code lines, never run or change it")}`);
    add({ id: "code.repo", label: "Code", status: "ok", summary: `Read-only code: ${tilde(codePath)}`, detail: "Root-cause agents can Read and Grep this checkout to cite file:line pointers. They cannot run, edit or push anything." });
  }
  mark("questions");

  // ── 3. config ────────────────────────────────────────────────────────────
  section("Writing your config", TOTAL);
  const home = ensureHome();
  // A second install on this machine (another project, another home) gets the next free port
  // instead of silently talking to the first install's engine.
  let state = await whoIsOn(port);
  while (state === "other" && port < 4767) state = await whoIsOn(++port);
  if (state === "other") {
    line.err("Engine", "ports 4747-4767 are all taken by other ultimatehuman installs");
    return 1;
  }
  if (port !== 4747) line.ok("Port", `${port} ${c.muted("· 4747 belongs to another ultimatehuman install on this machine")}`);
  const config = {
    version: 1,
    ...(port !== 4747 ? { server: { port } } : {}),
    auth: { sources: [authKind === "claude_oauth_token" ? { id: "sub", kind: "claude_oauth_token", token: "${CLAUDE_CODE_OAUTH_TOKEN}" } : { id: "sub", kind: "claude_login" }] },
    governor: { humanReservePct: 30 },
    radar: { schedule: "0 7 * * *", lookbackHours: 24, firstPassLookbackHours: 168, minUsersAffected: 2, maxFindingsPerRun: 3, autoFile: false, ...(codePath ? { repo: { path: codePath } } : {}) },
    plugins: pluginConfig,
  };
  const path = defaultConfigPath();
  await writeConfig(config, path, "// ultimatehuman config. Secrets are ${ENV_VAR} references only; values never touch this file.\n// Edit by hand, with `ultimatehuman config set`, or in the dashboard. Every path validates first.");
  line.ok("Config", `${tilde(path)} ${c.muted("· secrets stored as ${ENV} references only")}`);
  mark("config");

  // ── 4. engine + first pass ───────────────────────────────────────────────
  section("Starting the engine and the first radar pass", TOTAL);
  const alive = state === "mine";
  let pid: number | undefined;
  if (!alive) {
    const cli = fileURLToPath(import.meta.url);
    const out = openSync(join(home, "logs", "engine.out"), "a");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "start"], { detached: true, stdio: ["ignore", out, out], env: process.env });
    child.unref();
    pid = child.pid;
    await spin("Engine", `starting on 127.0.0.1:${port}`, async () => {
      for (let i = 0; i < 100; i++) {
        if ((await whoIsOn(port)) === "mine") return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`engine did not come up; see ${tilde(join(home, "logs", "engine.out"))}`);
    });
  }
  line.ok("Engine", `running on ${c.bold(`127.0.0.1:${port}`)}${pid ? c.muted(` · pid ${pid}`) : ""} ${c.muted("· loopback only")}`);
  await api("/api/onboarding", { checks, initStartedAt: new Date(t0).toISOString(), timings, window: rl ?? null, probes: probeResults });
  const { run } = await api("/api/runs", { trigger: "onboarding" });
  line.ok("Radar", `first pass started · looking back ${run.lookbackHours / 24} days · ${c.muted(run.id)}`);
  mark("run_started");
  await api("/api/onboarding", { checks, initStartedAt: new Date(t0).toISOString(), timings, window: rl ?? null, probes: probeResults, runId: run.id });
  const { url } = await api("/api/auth/link", {});

  console.log("");
  console.log(`  ${c.bold("Open your dashboard")} ${c.muted("(this link works once, for 10 minutes):")}`);
  console.log(`  ${c.link(url)}`);
  console.log("");
  console.log(`  ${c.muted("Lost it? Run")} ultimatehuman dashboard ${c.muted("for a fresh link.")}`);
  const opener = process.env.BROWSER ?? (process.platform === "darwin" ? "open" : "xdg-open");
  try {
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
    console.log(`  ${c.muted("Opening your browser…")}`);
  } catch {
    /* headless machine: the link above is enough */
  }
  console.log("");
  return 0;
}
