import { spawn, execFileSync } from "node:child_process";
import { openSync, existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { ensureHome, connectRepository, controlKey, homeId, writeConfig, TEMPLATES, instantiate, describeSchedule, defaultConfigPath, runClaude, claudeBin, readOnlyHttp, outboundHttp, notifyHosts, scanRepo, detectFramework, gradeSetup, gradeProbes, setEngineEnv, readEnvFile, writeEnvFile, engineEnvPath, type RateLimitReading, type PendingItem } from "@ultimatehuman/core";
import type { NotifyPlugin, Plugin, ProbeResult } from "@ultimatehuman/sdk";
import { bundledPlugins } from "../plugins";
import type { GlobalFlags } from "../flags";
import { banner, section, line, spin, ask, askSecret, choose, closePrompts, c } from "../ui";
import { sentryPatch } from "../sentry-setup";
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

function gitRemoteRepo(cwd?: string): string | undefined {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
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

/** Git top-level of a path ("" when it is not inside a git checkout). */
function gitTop(p: string): string {
  try {
    return execFileSync("git", ["-C", p, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const ERROR_TRACKERS = ["sentry", "datadog"];
const TIER_WORD: Record<string, string> = { bronze: "Bronze", silver: "Silver", gold: "Gold", platinum: "Platinum" };

/** One secret the wizard has for a plugin: from the shell (fast path) or pasted. */
interface KeyHit {
  env: string;
  value: string;
  pasted?: boolean;
}

async function runInit(flags: GlobalFlags, _args: string[]): Promise<number> {
  const t0 = Date.now();
  const checks: Check[] = [];
  const add = (ch: Omit<Check, "at">) => checks.push({ ...ch, at: new Date().toISOString() });
  const timings: Record<string, number> = {};
  const mark = (k: string) => (timings[k] = Date.now() - t0);
  const pending: PendingItem[] = [];
  const addPending = (p: Omit<PendingItem, "since">) => {
    if (!pending.some((x) => x.id === p.id)) pending.push({ ...p, since: new Date().toISOString() });
  };
  const TOTAL = 5;
  const home = ensureHome();

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
  let hasLogin = existsSync(join(homedir(), ".claude", ".credentials.json"));
  try {
    // Claude owns macOS Keychain and custom config-directory discovery.
    hasLogin = JSON.parse(execFileSync(claudeBin(), ["auth", "status"], { stdio: ["ignore", "pipe", "ignore"] }).toString()).loggedIn === true;
  } catch { /* The live request below remains authoritative, including older CLI versions. */ }
  if (!claudeVersion) {
    line.err("Claude", "Claude Code is not installed. Install it, run `claude` once to sign in, then rerun init.");
    return 1;
  }
  const authKind = oauth ? "claude_oauth_token" : "claude_login";
  line.ok("Claude", `Claude Code ${claudeVersion} · ${oauth ? `signed in via ${c.bold("$" + oauth.name)}` : hasLogin ? "signed in (local login)" : "login not detected yet"} · ${c.muted("uses your subscription")}`);
  add({ id: "claude.detect", label: "Claude", status: "ok", summary: `Claude Code ${claudeVersion}, ${oauth ? `token from $${oauth.name}` : "local login"}` });

  // Verify the existing account before asking for repositories or integrations.
  const cp = await spin("Claude", "sending one tiny prompt to read your usage window", () =>
    runClaude({ prompt: "Reply with the single word ok.", cwd: home, model: "haiku", maxTurns: 1, tools: [], env: oauth ? { CLAUDE_CODE_OAUTH_TOKEN: oauth.value } : {} }),
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

  // Repos: the checkout we were started in is the default; more can be added. Each must be a git checkout.
  const cwdRepo = gitTopLevel();
  let repoInput = flags.repos ?? "";
  if (!repoInput && !flags.nonInteractive) {
    console.log("");
    repoInput = await ask("Which repos should the pipeline watch? (local paths, comma-separated)", cwdRepo ? tilde(cwdRepo) : undefined);
  } else if (!repoInput) repoInput = cwdRepo ?? "";
  const repoPaths: string[] = [];
  const takeRepos = async (input: string) => {
    for (const raw of input.split(",").map((x) => x.trim()).filter(Boolean)) {
      const abs = /^(https?:\/\/|ssh:\/\/|git@)/.test(raw)
        ? (await connectRepository(raw, home, [])).path
        : resolve(raw.replace(/^~(?=$|\/)/, homedir()));
      const top = existsSync(abs) ? gitTop(abs) : "";
      if (!top) line.warn("Repo", `${raw}: not a git checkout, skipped`);
      else if (!repoPaths.includes(top)) repoPaths.push(top);
    }
  };
  await takeRepos(repoInput);
  if (!flags.nonInteractive && !flags.repos) {
    for (;;) {
      const more = await ask("Another repo path? (Enter when done)");
      if (!more) break;
      await takeRepos(more);
    }
  }
  const usedNames = new Set<string>();
  const repos = repoPaths.map((path) => {
    const base = basename(path).replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
    let name = base;
    for (let i = 2; usedNames.has(name); i++) name = `${base}-${i}`;
    usedNames.add(name);
    return { name, path } as { name: string; path: string; testUrl?: string };
  });
  for (const r of repos) {
    line.ok("Code", `${r.name} · ${tilde(r.path)} ${c.muted("· read-only: agents may Read/Grep it to cite code lines, never run or change it")}`);
    add({ id: "code.repo", label: "Code", status: "ok", summary: `Read-only code: ${r.name} (${tilde(r.path)})`, detail: "Root-cause agents can Read and Grep this checkout to cite file:line pointers. They cannot run, edit or push anything." });
  }
  if (!repos.length) {
    line.err("Code", "no git checkout to watch. Run init inside your project, or pass --repos <path>.");
    if (flags.nonInteractive) return 2;
    add({ id: "code.repo", label: "Code", status: "missing", summary: "No repo connected: root causes stay at the level the tracker data supports." });
  }

  // Pipelines: the templates are suggestions, one [Y/n] each, copied into the config (the user owns them after that).
  const picked = flags.pipelines !== undefined ? new Set(flags.pipelines.split(",").map((x) => x.trim()).filter(Boolean)) : null;
  const pipelines = [];
  for (const t of TEMPLATES) {
    let on = picked ? picked.has(t.id) : t.suggestedByDefault;
    if (!picked && !flags.nonInteractive) {
      const a = (await ask(`Pipeline "${t.name}": ${t.description} (${describeSchedule(t.pipeline.schedule)}) ${t.suggestedByDefault ? "[Y/n]" : "[y/N]"}`, t.suggestedByDefault ? "Y" : "N")).trim().toLowerCase();
      on = a === "" ? t.suggestedByDefault : a.startsWith("y");
    }
    if (on) pipelines.push(instantiate(t));
    if (on) line.ok("Pipeline", `${t.name} ${c.muted(`· ${describeSchedule(t.pipeline.schedule)} · yours to edit, disable or delete in Config > Pipelines`)}`);
    else line.skip("Pipeline", `${t.name} not added ${c.muted("· add it any time from Config > Pipelines or the chat")}`);
  }

  // Trackers: the shell's env vars are the fast path; otherwise look at what the code uses and ask for a key.
  const detections = repos.flatMap((r) => scanRepo(r.path, r.name));
  const detectedBy = (id: string) => detections.filter((d) => d.provider === id);
  for (const id of [...new Set(detections.map((d) => d.provider))]) {
    const ds = detectedBy(id);
    const where = [...new Set(ds.map((d) => `${d.pkg} in ${d.repo}${d.manifest !== "package.json" && !d.manifest.startsWith("requirements") ? ` (${d.manifest})` : ""}`))];
    line.ok("Scan", `found ${c.bold(where.slice(0, 3).join(", "))}${where.length > 3 ? ` +${where.length - 3}` : ""}`);
  }
  if (repos.length && !detections.length) line.skip("Scan", "no Sentry, PostHog or Datadog SDK in the dependency manifests");

  const found: Record<string, { env: string; value: string; all: Record<string, KeyHit> }> = {};
  const nonSecret: Record<string, Record<string, string>> = {};
  const sourcePlugins = bundledPlugins.filter((p) => p.manifest.kind === "source");
  const secretsOf = (p: Plugin) => p.manifest.credentials.filter((f) => f.secret);
  const fromEnv = (p: Plugin): Record<string, KeyHit> | null => {
    const all: Record<string, KeyHit> = {};
    for (const f of secretsOf(p)) {
      const hit = findEnv([f.preferredEnv, ...(f.alternateEnv ?? [])]);
      if (!hit && !f.optional) return null;
      if (hit) all[f.key] = { env: hit.name, value: hit.value };
    }
    return all[secretsOf(p)[0]!.key] ? all : null;
  };
  const setFound = (p: Plugin, all: Record<string, KeyHit>) => {
    const first = secretsOf(p)[0]!;
    found[p.manifest.id] = { env: all[first.key]!.env, value: all[first.key]!.value, all };
  };
  for (const p of bundledPlugins) {
    const secret = secretsOf(p)[0];
    if (!secret) continue;
    const hit = fromEnv(p);
    if (hit) {
      setFound(p, hit);
      line.ok(p.manifest.displayName, `key found in ${c.bold(Object.values(hit).map((h) => "$" + h.env).join(" + "))}`);
      add({ id: `${p.manifest.id}.detect`, label: p.manifest.displayName, status: "ok", summary: `Key found in ${Object.values(hit).map((h) => "$" + h.env).join(" + ")}` });
    } else if (p.manifest.kind === "notify") {
      line.skip(p.manifest.displayName, `no $${secret.preferredEnv} · optional: new findings as cards in your chat, bot from ${secret.helpUrl}`);
      add({ id: `${p.manifest.id}.detect`, label: p.manifest.displayName, status: "missing", summary: `No $${secret.preferredEnv}. Optional: notifications stay off.`, helpUrl: secret.helpUrl });
    } else if (p.manifest.kind === "output") {
      line.skip(p.manifest.displayName, `no $${secret.preferredEnv}: issues will be previewed, never created (dry run)`);
      add({ id: `${p.manifest.id}.detect`, label: p.manifest.displayName, status: "missing", summary: `No $${secret.preferredEnv}: dry run, issues are previewed and never created`, helpUrl: secret.helpUrl });
    }
  }
  mark("detect");

  // ── 2. trackers ──────────────────────────────────────────────────────────
  section("Connecting your trackers (read-only keys, all optional)", TOTAL);
  /** Asks for every secret of a plugin; returns null when the user skips any required one. */
  const pasteKeys = async (p: Plugin): Promise<Record<string, KeyHit> | null> => {
    line.sub(`${p.manifest.displayName} needs read-only access: ${p.manifest.requiredScopes.join(", ")}`);
    const all: Record<string, KeyHit> = {};
    for (const f of secretsOf(p)) {
      line.sub(`${f.helpText} ${f.helpUrl}`);
      const v = (await askSecret(`Paste the ${p.manifest.displayName} ${f.label} (Enter to skip):`)).trim();
      if (!v) {
        if (f.optional) continue;
        return null;
      }
      all[f.key] = { env: f.preferredEnv, value: v, pasted: true };
    }
    if (p.manifest.id === "datadog" && !findEnv(["DATADOG_SITE", "DD_SITE"])) {
      const sites = ["datadoghq.com", "datadoghq.eu", "us3.datadoghq.com", "us5.datadoghq.com", "ap1.datadoghq.com"];
      nonSecret.datadog = { ...nonSecret.datadog, site: sites[await choose("Which Datadog site is your account on? (the domain in your Datadog URL)", sites, 0)]! };
    }
    return all;
  };
  /** Non-secret fields (site, base URL): the shell's env, a wizard answer, or the manifest default. */
  const plainFields = (p: Plugin): Record<string, string> => {
    const plain: Record<string, string> = {};
    for (const x of p.manifest.credentials.filter((x) => !x.secret && x.key !== "host")) {
      const v = findEnv([x.preferredEnv, ...(x.alternateEnv ?? [])])?.value ?? nonSecret[p.manifest.id]?.[x.key] ?? x.default;
      if (v) plain[x.key] = v;
    }
    return plain;
  };
  const why: Record<string, string> = {
    sentry: "Sentry errors are the strongest radar signal: real exceptions, with stack traces and affected users.",
    posthog: "PostHog shows what users actually hit: exceptions, rage clicks, slow pages, failed funnels.",
    datadog: "Datadog error logs and alerts tell the radar which backend failures real users hit.",
  };
  const pendingKey = (p: Plugin, reason: string) => {
    const secrets = secretsOf(p).filter((f) => !f.optional);
    const plain = plainFields(p);
    addPending({
      id: `${p.manifest.id}.key`,
      label: `${p.manifest.displayName} read-only key${secrets.length > 1 ? "s" : ""}`,
      why: `${reason} ${why[p.manifest.id] ?? ""}`.trim(),
      unlock: `Get ${secrets.map((f) => f.label).join(" + ")} (${p.manifest.requiredScopes.join(", ")}), then run ${secrets.map((f) => `\`ultimatehuman key ${f.preferredEnv}\``).join(" and ")}. If an admin holds it, ask the chat to draft the request.`,
      tier: "silver",
      plugin: p.manifest.id,
      envVars: secrets.map((f) => f.preferredEnv),
      activate: { plugins: { [p.manifest.id]: { credentials: { ...Object.fromEntries(secrets.map((f) => [f.key, `\${${f.preferredEnv}}`])), ...plain }, options: {} } } },
    });
  };
  for (const p of sourcePlugins) {
    if (found[p.manifest.id]) continue;
    const ds = detectedBy(p.manifest.id);
    if (!ds.length) continue;
    const reason = `Found ${ds[0]!.pkg} in ${ds[0]!.repo}.`;
    line.ok(p.manifest.displayName, `${reason.replace(/\.$/, "")}: connect it so the radar reads it`);
    const keys = flags.nonInteractive ? null : await pasteKeys(p);
    if (keys) setFound(p, keys);
    else {
      line.skip(p.manifest.displayName, "skipped · recorded as pending, add it later with `ultimatehuman key` or ask the chat");
      add({ id: `${p.manifest.id}.detect`, label: p.manifest.displayName, status: "missing", summary: `${reason} No key yet: pending.`, helpUrl: secretsOf(p)[0]!.helpUrl });
      pendingKey(p, reason);
    }
  }
  // Nothing detected and nothing exported: offer the trackers anyway, one pick.
  if (!sourcePlugins.some((p) => found[p.manifest.id]) && !detections.length && !flags.nonInteractive) {
    const offer = sourcePlugins.map((p) => p);
    const i = await choose("No tracker key yet. Connect one now?", [...offer.map((p) => `${p.manifest.displayName} ${c.muted(`· ${p.manifest.requiredScopes.join(", ")}`)}`), "Skip for now"], offer.length);
    if (i < offer.length) {
      const p = offer[i]!;
      const keys = await pasteKeys(p);
      if (keys) setFound(p, keys);
      else pendingKey(p, "You picked it in init and skipped the key.");
    }
  }

  // No-tracker mode: no error tracker anywhere -> offer a Sentry init patch on a branch of a repo.
  const hasErrorTracker = ERROR_TRACKERS.some((id) => found[id] || detectedBy(id).length);
  if (!hasErrorTracker) {
    line.warn("Errors", "no error tracker found (most teams have none: that is fine, the radar starts with what you have)");
    const target = repos.find((r) => detectFramework(r.path) !== "unknown");
    let patched = false;
    if (target && !flags.nonInteractive) {
      const fw = detectFramework(target.path);
      const yes = (await ask(`Set up Sentry in ${target.name} (${fw}) now? It writes a minimal init on a NEW branch, never your current or default branch. [y/N]`, "N")).trim().toLowerCase();
      if (yes.startsWith("y")) {
        try {
          const patch = await spin("Sentry", `writing a ${fw} Sentry init on a new branch of ${target.name}`, async () => sentryPatch(target.path));
          patched = true;
          line.ok("Sentry", `branch ${c.bold(patch.branch)} in ${tilde(target.path)} · ${patch.files.length} files · ${c.muted(`your ${patch.base} branch and working tree are untouched`)}`);
          console.log("");
          for (const l of patch.diff.split("\n")) console.log(`    ${l.startsWith("+") && !l.startsWith("+++") ? c.ok(l) : l.startsWith("-") && !l.startsWith("---") ? c.err(l) : c.muted(l)}`);
          console.log("");
          console.log(`  ${c.bold("Next steps")}`);
          patch.steps.forEach((s, n) => console.log(`    ${n + 1}. ${s}`));
          add({ id: "sentry.setup", label: "Sentry", status: "warn", summary: `Sentry init written on branch ${patch.branch} of ${target.name} (${fw})`, detail: patch.steps.join(" "), helpUrl: "https://sentry.io/signup/" });
          addPending({
            id: "sentry.setup",
            label: `Finish the Sentry setup in ${target.name}`,
            why: `No error tracker yet. The init is ready on branch ${patch.branch}; once it is deployed with a DSN, real exceptions reach the radar.`,
            unlock: patch.steps.map((x, n) => `(${n + 1}) ${x}`).join(" "),
            tier: "silver",
            plugin: "sentry",
            envVars: ["SENTRY_AUTH_TOKEN"],
            activate: { plugins: { sentry: { credentials: { authToken: "${SENTRY_AUTH_TOKEN}", baseUrl: "https://sentry.io" }, options: {} } } },
          });
        } catch (e) {
          line.err("Sentry", `could not write the patch: ${(e as Error).message}`);
        }
      }
    }
    if (!patched)
      addPending({
        id: "errors.tracker",
        label: "An error tracker",
        why: "Without one the radar only sees analytics. Sentry's free tier is enough; the wizard can write the init on a branch for you.",
        unlock: `Rerun \`ultimatehuman init\` in ${target?.name ?? "your repo"} and answer yes to "Set up Sentry", or connect Datadog with \`ultimatehuman key DATADOG_API_KEY\`.`,
        tier: "silver",
        gradeCheck: "sources",
      });
  }

  // Probe the selected sources with the account already verified.
  const sources = sourcePlugins.filter((p) => found[p.manifest.id]);
  const pluginConfig: Record<string, any> = {};
  const probeResults: Record<string, ProbeResult> = {};
  for (const p of sources) {
    const f = found[p.manifest.id]!;
    const hostField = p.manifest.credentials.find((x) => x.key === "host");
    const creds: Record<string, string> = Object.fromEntries(Object.entries(f.all).map(([k, h]) => [k, h.value]));
    const plain = plainFields(p);
    Object.assign(creds, plain);
    const hostEnv = hostField ? findEnv([hostField.preferredEnv]) : null;
    const hosts = hostEnv ? [hostEnv.value] : p.manifest.id === "posthog" ? ["https://us.posthog.com", "https://eu.posthog.com"] : [hostField?.default ?? ""];
    let res: ProbeResult | null = null;
    let host = hosts[0]!;
    for (const h of hosts) {
      host = h;
      if (hostField) creds[hostField.key] = h;
      const ctx = { credentials: creds, options: {}, http: readOnlyHttp(p.manifest.id, p.readOnlyPostAllowlist ?? [], () => {}), log: () => {}, signal: new AbortController().signal };
      res = await spin(p.manifest.displayName, `probing ${(h || plain.apiBase || plain.site || plain.baseUrl || "").replace(/^https?:\/\//, "")}`, () => (p as Plugin).probe(ctx as any).catch((e) => ({ ok: false, summary: (e as Error).message }) as ProbeResult));
      if (res.ok) break;
    }
    probeResults[p.manifest.id] = res!;
    if (!res!.ok) {
      line.err(p.manifest.displayName, `${res!.summary}${res!.fix ? ` · ${res!.fix}` : ""}`);
      add({ id: `${p.manifest.id}.probe`, label: p.manifest.displayName, status: "fail", summary: res!.summary, ...(res!.fix ? { detail: res!.fix } : {}) });
      // A pasted key that fails is not kept: the pending item resolves when a working one is added.
      const pasted = Object.values(f.all).filter((h) => h.pasted);
      if (pasted.length) {
        const env = readEnvFile();
        for (const h of pasted) env.delete(h.env);
        writeEnvFile(env);
      }
      pendingKey(p, `The key ${pasted.length ? "you pasted" : `in $${f.env}`} failed the live probe: ${res!.summary}.`);
      continue;
    }
    // Pasted keys go to the engine env file (0600), the config keeps only ${ENV} refs.
    const pasted = Object.values(f.all).filter((h) => h.pasted);
    if (pasted.length) {
      setEngineEnv(Object.fromEntries(pasted.map((h) => [h.env, h.value])));
      for (const h of pasted) process.env[h.env] = h.value;
      line.sub(`saved ${pasted.map((h) => "$" + h.env).join(" + ")} to ${tilde(engineEnvPath())} (0600); the config only holds the reference`);
    }
    line.ok(p.manifest.displayName, res!.summary);
    if (!hostEnv && hostField) line.sub(`host auto-detected: ${host}`);
    add({ id: `${p.manifest.id}.probe`, label: p.manifest.displayName, status: "ok", summary: res!.summary, detail: `Read-only probe against ${host || plain.apiBase || plain.site || plain.baseUrl}` });
    const secret = secretsOf(p)[0]!;
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
      const slug = (process.env.ULTIMATEHUMAN_GITHUB_REPO ?? gitRemoteRepo(repos[0]?.path))?.split("/")[1]?.toLowerCase().replace(/[^a-z0-9]/g, "");
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
      credentials: { ...Object.fromEntries(Object.entries(f.all).map(([k, h]) => [k, `\${${h.env}}`])), ...plain, ...(hostField ? { [hostField.key]: host } : {}) },
      options: p.manifest.id === "posthog" ? { projectId, excludeTeamMembers: true } : {},
    };
  }
  if (!Object.keys(pluginConfig).length) line.skip("Sources", "no tracker connected yet: the engine starts, the radar waits for one (see the pending list at the end)");
  mark("probe_sources");

  // ── 3. questions ─────────────────────────────────────────────────────────
  section("A few optional questions", TOTAL);
  // Notifiers stay off unless their keys are exported and the live probe (which posts one message) passes.
  const notifications: Record<string, any> = {};
  for (const p of bundledPlugins.filter((x): x is NotifyPlugin => x.manifest.kind === "notify" && !!found[x.manifest.id])) {
    const secret = p.manifest.credentials.find((f) => f.secret)!;
    const others = p.manifest.credentials.filter((f) => !f.secret);
    const missing = others.filter((f) => !f.optional && !findEnv([f.preferredEnv, ...(f.alternateEnv ?? [])]));
    if (missing.length) {
      line.skip(p.manifest.displayName, `$${found[p.manifest.id]!.env} found, no $${missing[0]!.preferredEnv}: notifications stay off · ${missing[0]!.helpText}`);
      add({ id: `${p.manifest.id}.probe`, label: p.manifest.displayName, status: "missing", summary: `No $${missing[0]!.preferredEnv}: notifications stay off`, helpUrl: missing[0]!.helpUrl });
      continue;
    }
    const plain: Record<string, string> = Object.fromEntries(others.map((f) => [f.key, findEnv([f.preferredEnv, ...(f.alternateEnv ?? [])])?.value ?? ""]));
    if (!flags.nonInteractive) {
      const yes = (await ask(`Send new findings to ${p.manifest.displayName} (chat ${Object.values(plain).join(" ")})? It posts one probe message now. [Y/n]`, "Y")).trim().toLowerCase();
      if (yes.startsWith("n")) {
        line.skip(p.manifest.displayName, "notifications off (your answer)");
        continue;
      }
    }
    const options = { ...(flags.notifyPrefix ? { prefix: flags.notifyPrefix } : {}), ...(flags.notifyServer && p.hostOption ? { [p.hostOption]: flags.notifyServer } : {}) };
    const log = () => {};
    const ctx = { credentials: { [secret.key]: found[p.manifest.id]!.value, ...plain }, options, http: readOnlyHttp(p.manifest.id, [], log), send: outboundHttp(p.manifest.id, notifyHosts(p, options), log), log, signal: new AbortController().signal };
    const res = await spin(p.manifest.displayName, "checking the bot and posting one probe message", () => p.probe(ctx));
    probeResults[p.manifest.id] = res;
    if (!res.ok) {
      line.err(p.manifest.displayName, `${res.summary}${res.fix ? ` · ${res.fix}` : ""}`);
      add({ id: `${p.manifest.id}.probe`, label: p.manifest.displayName, status: "fail", summary: res.summary, ...(res.fix ? { detail: res.fix } : {}) });
      continue;
    }
    line.ok(p.manifest.displayName, `${res.summary} ${c.muted("· each new finding arrives as a card; empty days send nothing")}`);
    add({ id: `${p.manifest.id}.probe`, label: p.manifest.displayName, status: "ok", summary: res.summary, detail: "Each new finding arrives as a card photo. A pass with findings sends one quiet line; an empty pass sends nothing." });
    notifications[p.manifest.id] = { enabled: true, credentials: { [secret.key]: `\${${found[p.manifest.id]!.env}}`, ...plain }, options };
  }

  // The first watched repo's remote, not the folder init runs in (bootstrap.sh runs it from its own checkout).
  const repoDefault = process.env.ULTIMATEHUMAN_GITHUB_REPO ?? (repos[0] ? gitRemoteRepo(repos[0].path) : undefined);
  console.log("");
  const repo = flags.repo ?? (flags.nonInteractive ? repoDefault ?? "" : await ask("GitHub repo for issue previews (optional, owner/name; Enter to skip):", repoDefault));
  if (repo) {
    const gh = found.github;
    pluginConfig.github = {
      credentials: { ...(gh ? { token: `\${${gh.env}}` } : {}), repo },
      options: { labels: ["ultimatehuman"], dryRun: true },
    };
    const how = flags.repo ? "from --repo" : process.env.ULTIMATEHUMAN_GITHUB_REPO ? "from $ULTIMATEHUMAN_GITHUB_REPO" : repo === repoDefault && repoDefault ? `from ${repos[0]!.name}'s git remote` : "typed";
    line.ok("GitHub", `${repo} · ${c.muted(`${how} · dry run: issues are previewed, never created`)}`);
    add({ id: "github.repo", label: "GitHub", status: "ok", summary: `Issues go to ${repo} (${how})`, detail: "Dry run: issues are rendered and previewed, never created" });
  }

  // Test/staging URL: where the AI can check a claim against the running product (never production).
  let testUrl = flags.testUrl ?? "";
  if (!testUrl && !flags.nonInteractive && repos.length) {
    console.log("");
    for (;;) {
      testUrl = await ask("Deployed test/staging URL? (optional, this is how the AI confirms truth; never production; Enter to skip)");
      if (!testUrl || /^https?:\/\/[^\s/]+/.test(testUrl)) break;
      line.warn("Test URL", `${testUrl} is not a URL (https://staging.example.com)`);
    }
  }
  if (testUrl && repos.length) {
    if (!/^https?:\/\/[^\s/]+/.test(testUrl)) {
      line.err("Test URL", `${testUrl} is not a URL`);
      return 2;
    }
    repos[0]!.testUrl = testUrl;
    line.ok("Test URL", `${testUrl} ${c.muted(`· on ${repos[0]!.name}`)}`);
    add({ id: "code.testurl", label: "Code", status: "ok", summary: `Test URL ${testUrl} on ${repos[0]!.name}`, detail: "Staging/test only: agents may check a finding against it, never production." });
  } else if (repos.length) {
    addPending({ id: "testurl", label: "A deployed test/staging URL", why: "It is how the AI confirms a finding is real on the running product, not just in the data. Needed for Gold.", unlock: `Ask the chat to set it, or set repos[0].testUrl (staging only, never production).`, tier: "gold", gradeCheck: "testUrl" });
  }
  if (!Object.keys(notifications).length) {
    addPending({ id: "notifications", label: "Phone notifications (Telegram)", why: "So new findings and setup upgrades reach you without opening the dashboard. Part of Silver.", unlock: "Save a BotFather token with `ultimatehuman key UH_CHAT_BOT_TOKEN`, then ask the chat to turn on chat.telegram (enabled: true, botToken \"${UH_CHAT_BOT_TOKEN}\"); or export TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID and rerun init.", tier: "silver", gradeCheck: "notifications" });
  }
  closePrompts();
  mark("questions");

  // ── 3. config ────────────────────────────────────────────────────────────
  section("Writing your config", TOTAL);
  // A second install on this machine (another project, another home) gets the next free port
  // instead of silently talking to the first install's engine.
  if (flags.port) port = flags.port;
  let state = await whoIsOn(port);
  while (state === "other" && !flags.port && port < 4767) state = await whoIsOn(++port);
  if (state === "other") {
    line.err("Engine", flags.port ? `port ${port} belongs to another ultimatehuman install` : "ports 4747-4767 are all taken by other ultimatehuman installs");
    return 1;
  }
  if (port !== 4747 && !flags.port) line.ok("Port", `${port} ${c.muted("· 4747 belongs to another ultimatehuman install on this machine")}`);
  const config = {
    version: 1,
    ...(port !== 4747 ? { server: { port } } : {}),
    auth: { sources: [authKind === "claude_oauth_token" ? { id: "sub", kind: "claude_oauth_token", token: "${CLAUDE_CODE_OAUTH_TOKEN}" } : { id: "sub", kind: "claude_login" }] },
    governor: { humanReservePct: 30 },
    pipelines,
    ...(repos.length ? { repos } : {}),
    plugins: pluginConfig,
    ...(Object.keys(notifications).length ? { notifications } : {}),
    ...(pending.length ? { pending } : {}),
  };
  const path = defaultConfigPath();
  const written = await writeConfig(config, path, "// ultimatehuman config. Secrets are ${ENV_VAR} references only; values never touch this file.\n// Edit by hand, with `ultimatehuman config set`, or in the dashboard. Every path validates first.\n// `pending` lists what init skipped; the engine clears an entry when it is done.");
  line.ok("Config", `${tilde(path)} ${c.muted("· secrets stored as ${ENV} references only")}`);
  const grade = gradeSetup(written, config, gradeProbes(written, sourcePlugins.map((p) => p.manifest.id)));
  mark("config");

  // ── 4. engine + first pass ───────────────────────────────────────────────
  section("Starting the engine and the first passes", TOTAL);
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
  // A pipeline that reads trackers waits for one; a repo audit can start at once. Passes are serialized by the engine.
  const hasTracker = Object.keys(pluginConfig).some((id) => sourcePlugins.some((p) => p.manifest.id === id));
  let firstRunId: string | undefined;
  for (const p of pipelines) {
    const needsTracker = !(p.sources ?? ["*"]).every((s) => s === "repos");
    if (needsTracker && !hasTracker) {
      line.skip(p.name, "no tracker connected: its first pass starts when one is (the engine checks every minute)");
      continue;
    }
    const out = await api("/api/runs", { trigger: "onboarding", pipelineId: p.id });
    if (out.run) line.ok(p.name, `first pass started · looking back ${out.run.lookbackHours / 24} days · ${c.muted(out.run.id)}`);
    else line.ok(p.name, `first pass queued ${c.muted(`(position ${out.position}: one pass runs at a time)`)}`);
    firstRunId ??= out.run?.id;
  }
  if (firstRunId) {
    mark("run_started");
    await api("/api/onboarding", { checks, initStartedAt: new Date(t0).toISOString(), timings, window: rl ?? null, probes: probeResults, runId: firstRunId });
  }
  const { url } = await api("/api/auth/link", {});

  // ── end screen: grade, what unlocks the next tier, and the pending ledger ──
  console.log("");
  console.log(`  ${c.bold("Setup grade:")} ${c.accent(c.bold(grade.tier ? TIER_WORD[grade.tier]! : "not set up yet"))}${grade.next ? c.muted(` · next: ${TIER_WORD[grade.next]}`) : ""}`);
  if (grade.next && grade.unlocks.length) {
    console.log(`  ${c.muted(`What unlocks ${TIER_WORD[grade.next]}:`)}`);
    for (const u of grade.unlocks) console.log(`    ${c.muted("·")} ${u.label} ${c.muted(`— ${u.hint}`)}`);
  }
  if (pending.length) {
    console.log("");
    console.log(`  ${c.bold(`Pending (${pending.length})`)} ${c.muted("· skipped now, nothing blocks you; the engine clears each one when it is done")}`);
    for (const p of pending) {
      console.log(`    ${c.warn("○")} ${c.bold(p.label)}${p.tier ? c.muted(` · ${TIER_WORD[p.tier]}`) : ""}`);
      console.log(`      ${c.muted(p.why)}`);
      console.log(`      ${c.muted("→")} ${p.unlock}`);
    }
    console.log(`  ${c.muted("Ask the setup chat (dashboard Chat, or `ultimatehuman chat`) \"what's missing?\" any time.")}`);
  }

  console.log("");
  console.log(`  ${c.bold("Open your dashboard")} ${c.muted("(this link works once, for 10 minutes):")}`);
  console.log(`  ${c.link(url)}`);
  console.log("");
  console.log(`  ${c.muted("Lost it? Run")} ultimatehuman dashboard ${c.muted("for a fresh link.")}`);
  const opener = process.env.BROWSER ?? (process.platform === "darwin" ? "open" : "xdg-open");
  try {
    if (!flags.noOpen && !flags.nonInteractive) {
      spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
      console.log(`  ${c.muted("Opening your browser…")}`);
    }
  } catch {
    /* headless machine: the link above is enough */
  }
  console.log("");
  // --non-interactive: 0 when the input reaches Bronze (a repo + claude); trackers and the rest are optional.
  return flags.nonInteractive && !grade.tier ? 2 : 0;
}
