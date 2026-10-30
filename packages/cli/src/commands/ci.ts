import { existsSync, mkdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { loadConfig, CI_WORKFLOW_PATH, DEFAULT_MODEL, type Config, type RepoConfig } from "@ultimatehuman/core";
import PROMPT from "../../templates/ci/PROMPT.md";
import ADDENDUM from "../../templates/ci/ADDENDUM.md";
import README from "../../templates/ci/README.md";
import RUN_SH from "../../templates/ci/run.sh";
import WORKFLOW from "../../templates/ci/pr-review.yml";
import { line, c } from "../ui";

export interface CiFlags {
  repo?: string;
  base?: string;
  runnerLabel?: string;
  model?: string;
  force?: boolean;
}

/** Only the install-time {{UPPER}} placeholders; GitHub's ${{ ... }} expressions and run.sh's CI-time ones stay. */
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/(?<!\$)\{\{([A-Z_]+)\}\}/g, (m, k: string) => v[k] ?? m);

/** Per-repo product context, generated from the config: the one part of the prompt the team maintains. */
export function productContext(repo: RepoConfig, all: readonly RepoConfig[]): string {
  const siblings = all.filter((r) => r.name !== repo.name);
  return [
    `Repository: ${repo.name}.${repo.notes ? ` ${repo.notes}` : ""}`,
    "<!-- Describe the product in two or three lines: who uses it, what it does, the stack and its build/test commands. -->",
    ...(repo.testUrl ? ["", `Test environment: ${repo.testUrl} (never production).`] : []),
    "",
    "INTENDED BEHAVIOR — never report as bugs:",
    "- <!-- e.g. billing rules that look odd but are by design -->",
    "",
    "High-risk areas:",
    "- <!-- e.g. payments, auth/session handling, admin routes -->",
    ...(siblings.length
      ? ["", `Sibling repos: ${siblings.map((s) => s.name).join(", ")}. Flag any change that only works if a sibling-repo change deploys first (deploy coupling), and say which repo must ship first.`]
      : []),
    "",
  ].join("\n");
}

function gitTop(path: string): string | null {
  try {
    return execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** Writes the workflow + .github/review/ into one checkout. Never commits or pushes: the repo's owner does. */
export function installCi(root: string, repo: RepoConfig, all: readonly RepoConfig[], f: CiFlags): { written: string[]; skipped: string[] } {
  const vars = { BASE_BRANCH: f.base ?? "main", RUNNER_LABEL: f.runnerLabel ?? "ultimatehuman-review", MODEL: f.model ?? "fable" };
  const files: [string, string, boolean][] = [
    [CI_WORKFLOW_PATH, fill(WORKFLOW, vars), false],
    [".github/review/run.sh", RUN_SH, true],
    [".github/review/PROMPT.md", PROMPT, false],
    [".github/review/ADDENDUM.md", ADDENDUM, false],
    [".github/review/README.md", fill(README, vars), false],
    [".github/review/PRODUCT_CONTEXT.md", productContext(repo, all), false],
  ];
  const written: string[] = [];
  const skipped: string[] = [];
  for (const [rel, body, exec] of files) {
    const abs = join(root, rel);
    // PRODUCT_CONTEXT.md is the team's file once written: never overwritten, even with --force.
    if (existsSync(abs) && (!f.force || rel.endsWith("PRODUCT_CONTEXT.md"))) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
    if (exec) chmodSync(abs, 0o755);
    written.push(rel);
  }
  return { written, skipped };
}

/** `ultimatehuman ci install [--repo <name|path>] [--base main] [--runner-label x] [--model fable] [--force]` */
export async function ci(sub: string | undefined, f: CiFlags): Promise<number> {
  if (sub !== "install") {
    console.error("usage: ultimatehuman ci install [--repo <name|path>] [--base <branch>] [--runner-label <label>] [--model <id>] [--force]");
    return 2;
  }
  const cfg: Config | null = await loadConfig().catch(() => null);
  const configured = cfg?.repos ?? [];
  let targets: RepoConfig[];
  if (f.repo) {
    const byName = configured.find((r) => r.name === f.repo);
    const path = byName ? byName.path : resolve(f.repo);
    const byPath = configured.find((r) => resolve(r.path) === path);
    targets = [byName ?? byPath ?? { name: basename(path).replace(/[^A-Za-z0-9._-]/g, "-"), path }];
  } else if (configured.length) {
    targets = configured;
  } else {
    const top = gitTop(process.cwd());
    if (!top) {
      console.error("no repo: pass --repo <path>, add repos to the config, or run this inside a git checkout");
      return 1;
    }
    targets = [{ name: basename(top).replace(/[^A-Za-z0-9._-]/g, "-"), path: top }];
  }
  let failed = 0;
  for (const t of targets) {
    const root = existsSync(t.path) && statSync(t.path).isDirectory() ? gitTop(t.path) : null;
    if (!root) {
      line.err(t.name, `${t.path} is not a git checkout`);
      failed++;
      continue;
    }
    const r = installCi(root, t, configured.length ? configured : targets, f);
    line.ok(t.name, `${root} ${c.muted(`· wrote ${r.written.length} file${r.written.length === 1 ? "" : "s"}${r.skipped.length ? `, kept ${r.skipped.length} existing (--force overwrites all but PRODUCT_CONTEXT.md)` : ""}`)}`);
    for (const w of r.written) console.log(`    + ${w}`);
  }
  console.log(`
Next, in each repo:
  1. Edit .github/review/PRODUCT_CONTEXT.md (intended behaviour, high-risk areas).
  2. Commit and push the files on a branch, merge to ${f.base ?? "main"} (the Run-workflow button needs the file on the default branch).
  3. Register a self-hosted runner with the label ${f.runnerLabel ?? "ultimatehuman-review"} on a machine with a logged-in claude CLI.
  See docs/ci-check.md. Default reviewer model: ${f.model ?? "fable"} (radar default is ${DEFAULT_MODEL}).`);
  return failed ? 1 : 0;
}
