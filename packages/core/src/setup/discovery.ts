import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { scanRepo } from "./scan";
import type { RepoConfig } from "../config/schema";

const exec = promisify(execFile);
const git = async (path: string, args: string[]) =>
  (
    await exec("git", ["-C", path, ...args], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout.trim();
export interface RepositoryDiscovery {
  name: string;
  path: string;
  project: string;
  available: boolean;
  scannedAt: string;
  branch?: string;
  commit?: string;
  remote?: string;
  issueRepo?: string;
  trackedFiles: number;
  facts: { label: string; kind: string; path: string; detail: string }[];
  trackers: ReturnType<typeof scanRepo>;
  /** Where the code sends its tracker data, read from the code itself (e.g. DD_SITE=datadoghq.eu). Defaults for the key form. */
  hints?: { datadogSite?: string; posthogHost?: string };
  error?: string;
}

const mostFrequent = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/** Datadog site and PostHog region named in tracked files. Only explicit hosts count; lockfiles and minified files are skipped. */
async function trackerHints(root: string): Promise<{ datadogSite?: string; posthogHost?: string }> {
  const grep = (pattern: string) =>
    git(root, ["grep", "-I", "-h", "-o", "-i", "-E", pattern, "--", ".", ":(exclude)*.lock", ":(exclude)*-lock.json", ":(exclude)*.min.js"])
      .then((out) => out.toLowerCase().split("\n").filter(Boolean))
      .catch(() => [] as string[]); // git grep exits 1 when nothing matches
  const [datadog, posthog] = await Promise.all([
    grep("(us3\\.|us5\\.|ap1\\.)datadoghq\\.com|datadoghq\\.eu|ddog-gov\\.com|DD_SITE[\"']?[[:space:]]*[=:][[:space:]]*[\"']?datadoghq\\.com"),
    grep("(eu|us)(\\.i)?\\.posthog\\.com|app\\.posthog\\.com"),
  ]);
  const datadogSite = mostFrequent(datadog.map((m) => /datadoghq\.com$/.test(m) && !/^(us3|us5|ap1)\./.test(m) ? "datadoghq.com" : m));
  const posthogHost = mostFrequent(posthog.map((m) => m.startsWith("eu") ? "https://eu.posthog.com" : "https://us.posthog.com"));
  return { ...(datadogSite ? { datadogSite } : {}), ...(posthogHost ? { posthogHost } : {}) };
}

export function githubRepo(remote: string): string | undefined {
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)?.[1];
}

/** A bounded inventory of tracked files. No project code or install scripts are executed. */
export async function inspectRepository(
  repo: RepoConfig,
): Promise<RepositoryDiscovery> {
  const result: RepositoryDiscovery = {
    name: repo.name,
    project: repo.project ?? repo.name,
    path: repo.path,
    available: false,
    scannedAt: new Date().toISOString(),
    trackedFiles: 0,
    facts: [],
    trackers: [],
  };
  try {
    const root = realpathSync(repo.path);
    await git(root, ["rev-parse", "--show-toplevel"]);
    const [list, branch, commit, remote] = await Promise.all([
      git(root, ["ls-files"]),
      git(root, ["branch", "--show-current"]),
      git(root, ["rev-parse", "HEAD"]).catch(() => ""),
      git(root, ["remote", "get-url", "origin"]).catch(() => ""),
    ]);
    const files = list.split("\n").filter(Boolean);
    result.available = true;
    result.trackedFiles = files.length;
    result.branch = branch || "Detached HEAD";
    if (commit) result.commit = commit;
    const slug = repo.issueRepo ?? githubRepo(remote);
    if (slug) {
      result.issueRepo = slug;
      result.remote = `https://github.com/${slug}`;
    }
    const facts = result.facts;
    for (const file of files
      .filter(
        (p) => /(^|\/)package\.json$/.test(p) && !/node_modules|vendor/.test(p),
      )
      .slice(0, 12)) {
      try {
        const full = realpathSync(join(root, file));
        const rel = relative(root, full);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        const raw = readFileSync(full, "utf8");
        if (raw.length > 200_000) continue;
        const pkg = JSON.parse(raw);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const framework = deps.next
          ? "Next.js"
          : deps.react
            ? "React"
            : deps.vue
              ? "Vue"
              : deps.svelte
                ? "Svelte"
                : deps.express
                  ? "Express"
                  : "Node.js";
        facts.push({
          label: framework,
          kind: "application",
          path: file,
          detail: pkg.name || file.replace(/\/package.json$/, ""),
        });
        const test = [
          "playwright",
          "@playwright/test",
          "vitest",
          "jest",
          "cypress",
        ].find((d) => deps[d]);
        if (test)
          facts.push({
            label: test.replace("@playwright/test", "Playwright"),
            kind: "tests",
            path: file,
            detail: "Test tooling detected; execution not verified",
          });
      } catch {
        /* A malformed or inaccessible manifest is not a fact. */
      }
    }
    for (const [pattern, label] of [
      [/(^|\/)(pyproject\.toml|requirements\.txt)$/, "Python"],
      [/(^|\/)go\.mod$/, "Go"],
      [/(^|\/)Cargo\.toml$/, "Rust"],
      [/(^|\/)Gemfile$/, "Ruby"],
    ] as const) {
      const path = files.find((p) => pattern.test(p));
      if (path)
        facts.push({
          label,
          kind: "application",
          path,
          detail: "Dependency manifest detected",
        });
    }
    const ci = files.filter((p) => /^\.github\/workflows\/.*\.ya?ml$/.test(p));
    if (ci[0])
      facts.push({
        label: `${ci.length} CI workflow${ci.length === 1 ? "" : "s"}`,
        kind: "ci",
        path: ci[0],
        detail: "Configuration found; results not verified",
      });
    const auth = files.find(
      (p) =>
        /(auth|permission|session|middleware)/i.test(p) &&
        /\.(tsx?|jsx?|py|go|rb)$/.test(p) &&
        !/(test|spec|fixture)/i.test(p),
    );
    if (auth)
      facts.push({
        label: "Authentication",
        kind: "area",
        path: auth,
        detail: "Potential review area, inferred from filenames",
      });
    result.trackers = scanRepo(root, repo.name);
    if (result.trackers.some((t) => t.provider === "datadog" || t.provider === "posthog")) {
      const hints = await trackerHints(root);
      if (Object.keys(hints).length) result.hints = hints;
    }
  } catch {
    result.error =
      "This checkout is unavailable. Check its path and Git access, then rescan.";
  }
  return result;
}

/** Resolve a local checkout or clone an HTTPS/SSH remote into managed storage. */
export async function connectRepository(
  input: string,
  home: string,
  existing: RepoConfig[],
): Promise<RepoConfig> {
  const value = input.trim();
  if (!value || value.length > 2048 || /[\r\n\0]/.test(value))
    throw new Error("Enter a local repository path or an HTTPS/SSH Git URL.");
  const remote = /^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(value);
  let path: string;
  if (remote) {
    if (value.startsWith("https://")) {
      const url = new URL(value);
      if (url.username || url.password)
        throw new Error(
          "Use your Git credential helper instead of putting a token in the URL.",
        );
    }
    const key = createHash("sha256").update(value).digest("hex").slice(0, 12);
    path = join(home, "checkouts", key);
    mkdirSync(join(home, "checkouts"), { recursive: true, mode: 0o700 });
    if (!existsSync(join(path, ".git"))) {
      try {
        await exec(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "clone",
            "--depth",
            "1",
            "--",
            value,
            path,
          ],
          {
            timeout: 120_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );
      } catch {
        throw new Error(
          "Could not clone this repository. Check the URL and your Git authentication, or use a local checkout.",
        );
      }
    }
  } else path = resolve(value.replace(/^~(?=$|\/)/, homedir()));
  try {
    path = realpathSync(await git(path, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error("This path is not an accessible Git checkout.");
  }
  const found = existing.find((r) => r.path === path);
  if (found) return { ...found };
  const base =
    (remote
      ? value
          .split(/[/:]/)
          .pop()!
          .replace(/\.git$/, "")
      : basename(path)
    ).replace(/[^A-Za-z0-9._-]/g, "-") || "project";
  let name = base;
  for (let n = 2; existing.some((r) => r.name === name); n++)
    name = `${base}-${n}`;
  const origin = await git(path, ["remote", "get-url", "origin"]).catch(
    () => "",
  );
  const issueRepo = githubRepo(origin);
  return { name, path, ...(issueRepo ? { issueRepo } : {}) };
}
