import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Signal, TimeWindow } from "@ultimatehuman/sdk";
import type { CodeContext } from "../pass/prompts";
import { REPOS_SOURCE } from "./schema";

/**
 * Built-in source "repos": each watched repo becomes one cluster of three read-only signals
 * (dependency manifests, commits in the window, sensitive paths), so an audit pipeline runs
 * through the same collect -> correlate -> investigate -> review path as tracker signals.
 * Only `git log` / `git ls-files` and file reads: nothing is written, nothing leaves the machine.
 */
const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "Pipfile", "go.mod", "Gemfile", "Cargo.toml", "composer.json", "pom.xml", "build.gradle"];
const SENSITIVE = /(^|\/)(\.env(\..+)?|.*\.pem|.*\.key|id_rsa.*|.*credentials.*|.*secrets?\..*|\.npmrc|\.pypirc)$/i;
const AUTHISH = /(auth|login|session|jwt|token|middleware|permission|acl|admin|guard)/i;

const git = (root: string, args: string[]) => {
  try {
    return execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 }).toString();
  } catch {
    return "";
  }
};

function manifestLines(root: string, files: string[]): string[] {
  const out: string[] = [];
  for (const f of files.filter((f) => MANIFESTS.includes(f.split("/").pop()!)).slice(0, 8)) {
    const text = readFileSync(join(root, f), "utf8");
    if (f.endsWith("package.json")) {
      try {
        const j = JSON.parse(text);
        for (const k of ["dependencies", "devDependencies"]) for (const [n, v] of Object.entries(j[k] ?? {})) out.push(`${f} ${k}: "${n}": "${v}"`);
        for (const [n, v] of Object.entries(j.scripts ?? {})) if (/^(pre|post)?install$/.test(n)) out.push(`${f} scripts: "${n}": "${v}"`);
        continue;
      } catch {
        /* fall through to raw lines */
      }
    }
    for (const l of text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).slice(0, 80)) out.push(`${f}: ${l.trim()}`);
  }
  return out.slice(0, 200);
}

export function* repoSignals(repos: CodeContext[], window: TimeWindow): Generator<Signal> {
  for (const r of repos) {
    if (!existsSync(r.path)) continue;
    const files = git(r.path, ["ls-files"]).split("\n").filter(Boolean);
    const url = r.repo ? `https://github.com/${r.repo}` : `file://${r.path}`;
    const commits = git(r.path, ["log", `--since=${window.from}`, `--until=${window.to}`, "--date=iso-strict", "--pretty=format:%h %ad %s", "--name-only", "-n", "40"]).trim();
    const lastCommit = git(r.path, ["log", "-1", "--date=iso-strict", "--pretty=format:%ad"]).trim() || window.to;
    const keys = { route: `repo:${r.name}`, clusterTitle: `Code audit of ${r.name}`, repo: r.name, users: [] as string[] };
    const base = { pluginId: REPOS_SOURCE, type: "repo_audit", firstSeen: window.from, lastSeen: lastCommit, count: 1, usersAffected: 0 };
    const deps = manifestLines(r.path, files);
    yield { ...base, id: `repos:${r.name}:manifests`, title: `Dependency manifests in ${r.name}`, url, keys, excerpt: { checkout: r.path, ...(r.commit ? { commit: r.commit } : {}), dependencies: deps.length ? deps : ["(no manifest found)"] } };
    yield { ...base, id: `repos:${r.name}:changes`, title: `Commits in the window in ${r.name}`, url, keys, count: Math.max(1, (commits.match(/^[0-9a-f]{7,} /gm) ?? []).length), excerpt: { window: `${window.from} to ${window.to}`, commits: commits ? commits.split("\n").slice(0, 160) : ["(no commit in the window: audit the repo as it stands)"] } };
    const sensitive = files.filter((f) => SENSITIVE.test(f) && !/\.example$|\.sample$|\.template$/.test(f));
    const auth = files.filter((f) => AUTHISH.test(f) && !/(^|\/)(test|tests|__tests__|spec)\//.test(f)).slice(0, 60);
    yield { ...base, id: `repos:${r.name}:paths`, title: `Sensitive and auth paths in ${r.name}`, url, keys, excerpt: { trackedSensitiveFiles: sensitive.length ? sensitive : ["(none tracked)"], authRelatedFiles: auth.length ? auth : ["(none found by name)"], ...(r.notes ? { notes: r.notes } : {}) } };
  }
}
