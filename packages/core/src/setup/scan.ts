import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

/**
 * Tracker SDK detection for the wizard: reads dependency manifests (package.json,
 * requirements*.txt, pyproject.toml, Gemfile) at the repo root and one workspace level
 * down (apps/*, packages/*, services/*). Pure file reads, no network, nothing executed.
 */

export type TrackerId = "sentry" | "posthog" | "datadog";

export interface Detection {
  provider: TrackerId;
  /** The SDK package as written in the manifest, e.g. "posthog-js". */
  pkg: string;
  /** Manifest path relative to the repo, e.g. "apps/web/package.json". */
  manifest: string;
  repo: string;
}

const NPM: [TrackerId, RegExp][] = [
  ["sentry", /^@sentry\//],
  ["sentry", /^raven(-js)?$/],
  ["posthog", /^posthog-(js|node|react-native)$/],
  ["posthog", /^@posthog\//],
  ["datadog", /^dd-trace$/],
  ["datadog", /^@datadog\//],
  ["datadog", /^datadog-/],
];
const PY: [TrackerId, RegExp][] = [
  ["sentry", /^sentry-sdk$/i],
  ["sentry", /^raven$/i],
  ["posthog", /^posthog$/i],
  ["datadog", /^ddtrace$/i],
  ["datadog", /^datadog(-api-client)?$/i],
];
const GEM: [TrackerId, RegExp][] = [
  ["sentry", /^sentry-(ruby|rails|sidekiq)$/],
  ["posthog", /^posthog-ruby$/],
  ["datadog", /^(ddtrace|datadog|dogapi)$/],
];

const match = (rules: [TrackerId, RegExp][], name: string) => rules.find(([, re]) => re.test(name))?.[0];

function manifestDirs(root: string): string[] {
  const dirs = [root];
  for (const ws of ["apps", "packages", "services"]) {
    const d = join(root, ws);
    if (!existsSync(d) || !statSync(d).isDirectory()) continue;
    for (const e of readdirSync(d)) if (!e.startsWith(".") && statSync(join(d, e)).isDirectory()) dirs.push(join(d, e));
  }
  return dirs;
}

function read(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function scanRepo(root: string, repo = basename(root)): Detection[] {
  const out: Detection[] = [];
  const hit = (provider: TrackerId | undefined, pkg: string, file: string) => {
    if (provider && !out.some((d) => d.provider === provider && d.pkg === pkg && d.manifest === relative(root, file))) out.push({ provider, pkg, manifest: relative(root, file), repo });
  };
  for (const dir of manifestDirs(root)) {
    const pj = read(join(dir, "package.json"));
    if (pj) {
      try {
        const j = JSON.parse(pj);
        for (const name of Object.keys({ ...j.dependencies, ...j.devDependencies })) hit(match(NPM, name), name, join(dir, "package.json"));
      } catch {
        /* unreadable manifest: skip */
      }
    }
    for (const f of existsSync(dir) ? readdirSync(dir).filter((f) => /^requirements.*\.txt$/.test(f)) : []) {
      for (const l of read(join(dir, f))!.split("\n")) {
        const name = /^\s*([A-Za-z0-9_.-]+)/.exec(l)?.[1];
        if (name) hit(match(PY, name), name, join(dir, f));
      }
    }
    const py = read(join(dir, "pyproject.toml"));
    if (py) for (const m of py.matchAll(/["']?([A-Za-z0-9_.-]+)\s*(?:[<>=~^!\[][^"'\n]*)?["']?\s*(?:=|,|$)/gm)) hit(match(PY, m[1]!), m[1]!, join(dir, "pyproject.toml"));
    const gem = read(join(dir, "Gemfile"));
    if (gem) for (const m of gem.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) hit(match(GEM, m[1]!), m[1]!, join(dir, "Gemfile"));
  }
  return out;
}

/** The framework a repo's code runs on, for the no-tracker Sentry patch. */
export type Framework = "next" | "express" | "node" | "django" | "flask" | "fastapi" | "python" | "unknown";

export function detectFramework(root: string): Framework {
  const pj = read(join(root, "package.json"));
  if (pj) {
    try {
      const j = JSON.parse(pj);
      const deps = { ...j.dependencies, ...j.devDependencies };
      if (deps.next) return "next";
      if (deps.express) return "express";
      return "node";
    } catch {
      return "node";
    }
  }
  const py = [read(join(root, "requirements.txt")), read(join(root, "pyproject.toml"))].filter(Boolean).join("\n").toLowerCase();
  if (py) return /\bdjango\b/.test(py) ? "django" : /\bflask\b/.test(py) ? "flask" : /\bfastapi\b/.test(py) ? "fastapi" : "python";
  return "unknown";
}
