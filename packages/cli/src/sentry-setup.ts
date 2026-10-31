import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFramework, type Framework } from "@ultimatehuman/core";

/**
 * No-tracker mode: a minimal, framework-aware Sentry init written on a NEW branch of the
 * user's repo. It goes through a temporary `git worktree`, so the checkout the user has open
 * (and its default branch) is never touched. Nothing is pushed; nothing is installed.
 */

export interface SentryPatch {
  framework: Framework;
  branch: string;
  base: string;
  files: string[];
  diff: string;
  install: string;
  steps: string[];
}

const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const tryGit = (cwd: string, args: string[]) => {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
};

const DSN_NOTE = "SENTRY_DSN comes from your Sentry project (Settings > Client Keys). Unset = Sentry stays off.";

function jsEntry(repo: string): string | null {
  try {
    const main = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).main as string | undefined;
    if (main && existsSync(join(repo, main))) return main;
  } catch {
    /* no main */
  }
  return ["index.js", "server.js", "app.js", "src/index.js", "src/server.js", "src/app.js", "index.mjs", "server.mjs"].find((f) => existsSync(join(repo, f))) ?? null;
}

function isEsm(repo: string, entry: string | null): boolean {
  if (entry?.endsWith(".mjs")) return true;
  try {
    return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).type === "module";
  } catch {
    return false;
  }
}

/** Writes the files into `dir` (the worktree). Returns the paths written and the install command. */
function writeFiles(dir: string, fw: Framework): { files: string[]; install: string; steps: string[] } {
  const files: string[] = [];
  const put = (rel: string, body: string) => {
    writeFileSync(join(dir, rel), body);
    files.push(rel);
  };
  const steps: string[] = [];
  if (fw === "next") {
    const ext = existsSync(join(dir, "tsconfig.json")) ? "ts" : "js";
    const init = (runtime: string) => `// ${runtime} Sentry init (added by ultimatehuman). ${DSN_NOTE}
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.${runtime === "Browser" ? "NEXT_PUBLIC_SENTRY_DSN" : "SENTRY_DSN"},
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
`;
    put(`sentry.server.config.${ext}`, init("Server"));
    put(`sentry.edge.config.${ext}`, init("Edge"));
    put(`instrumentation-client.${ext}`, init("Browser"));
    put(
      `instrumentation.${ext}`,
      `import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export const onRequestError = Sentry.captureRequestError;
`,
    );
    return { files, install: "npm install @sentry/nextjs", steps };
  }
  if (fw === "express" || fw === "node") {
    const entry = jsEntry(dir);
    const esm = isEsm(dir, entry);
    const ext = entry?.endsWith(".mjs") ? "mjs" : "js";
    const inst = `instrument.${ext}`;
    put(
      inst,
      `// Sentry init (added by ultimatehuman). Loaded before anything else. ${DSN_NOTE}
${esm ? 'import * as Sentry from "@sentry/node";' : 'const Sentry = require("@sentry/node");'}

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
});
`,
    );
    if (entry) {
      const rel = entry.includes("/") ? "../".repeat(entry.split("/").length - 1) + inst : `./${inst}`;
      let src = readFileSync(join(dir, entry), "utf8");
      const head = esm ? `import "${rel}";\nimport * as Sentry from "@sentry/node";\n` : `require("${rel}");\nconst Sentry = require("@sentry/node");\n`;
      src = head + src;
      if (fw === "express") {
        const m = /^(\s*)(\w+)\.listen\(/m.exec(src);
        if (m) src = src.replace(m[0], `${m[1]}// After all routes, before other error handlers.\n${m[1]}Sentry.setupExpressErrorHandler(${m[2]});\n${m[0]}`);
        else steps.push(`Add \`Sentry.setupExpressErrorHandler(app)\` after your routes in ${entry}.`);
      }
      writeFileSync(join(dir, entry), src);
      files.push(entry);
    } else steps.push(`Load ${inst} first thing in your entry file (no entry file was found).`);
    return { files, install: "npm install @sentry/node", steps };
  }
  if (fw === "django" || fw === "flask" || fw === "fastapi" || fw === "python") {
    put(
      "sentry_setup.py",
      `"""Sentry init (added by ultimatehuman). ${DSN_NOTE}
Import this module first thing in your entry point (manage.py / wsgi.py / app.py).
The ${fw === "python" ? "" : fw + " "}integration is enabled automatically by sentry-sdk."""
import os

import sentry_sdk

sentry_sdk.init(
    dsn=os.environ.get("SENTRY_DSN"),
    traces_sample_rate=0.1,
    send_default_pii=False,
)
`,
    );
    if (existsSync(join(dir, "requirements.txt"))) {
      const req = readFileSync(join(dir, "requirements.txt"), "utf8");
      writeFileSync(join(dir, "requirements.txt"), `${req.replace(/\n?$/, "\n")}sentry-sdk\n`);
      files.push("requirements.txt");
    }
    steps.push("Add `import sentry_setup` at the top of your entry point.");
    return { files, install: "pip install sentry-sdk", steps };
  }
  throw new Error("no package.json, requirements.txt or pyproject.toml: framework not recognized");
}

export function sentryPatch(repo: string): SentryPatch {
  const fw = detectFramework(repo);
  if (fw === "unknown") throw new Error("no package.json, requirements.txt or pyproject.toml: framework not recognized");
  const base = tryGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!tryGit(repo, ["rev-parse", "--verify", "HEAD"])) throw new Error("the repo has no commit yet");
  let branch = "ultimatehuman/add-sentry";
  for (let i = 2; tryGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]); i++) branch = `ultimatehuman/add-sentry-${i}`;
  const wt = join(mkdtempSync(join(tmpdir(), "uh-sentry-")), "wt");
  git(repo, ["worktree", "add", "-q", "-b", branch, wt, "HEAD"]);
  try {
    const { files, install, steps } = writeFiles(wt, fw);
    const envEx = join(wt, ".env.example");
    const dsnVars = fw === "next" ? "SENTRY_DSN=\nNEXT_PUBLIC_SENTRY_DSN=\n" : "SENTRY_DSN=\n";
    writeFileSync(envEx, existsSync(envEx) ? `${readFileSync(envEx, "utf8").replace(/\n?$/, "\n")}${dsnVars}` : dsnVars);
    files.push(".env.example");
    git(wt, ["add", "--", ...files]);
    const who = tryGit(repo, ["config", "user.email"]) ? [] : ["-c", "user.name=ultimatehuman", "-c", "user.email=ultimatehuman@localhost"];
    execFileSync("git", ["-C", wt, ...who, "commit", "-q", "--no-verify", "-m", `Add a minimal Sentry init (${fw})\n\nWritten by \`ultimatehuman init\` on its own branch. Needs SENTRY_DSN at runtime.`], { stdio: ["ignore", "pipe", "pipe"] });
    const diff = git(wt, ["diff", "HEAD~1", "HEAD"]);
    return {
      framework: fw,
      branch,
      base,
      files,
      diff,
      install,
      steps: [
        "Create a free Sentry account and project: https://sentry.io/signup/ (pick the platform; the free tier is enough). Copy its DSN.",
        `Review and take the branch: git diff ${base}...${branch}, then git checkout ${branch} && ${install}`,
        ...steps,
        `Set SENTRY_DSN${fw === "next" ? " and NEXT_PUBLIC_SENTRY_DSN" : ""} in your deployed environment, then deploy.`,
        "For the radar to read it: create a read-only auth token (org:read, project:read, event:read) at https://sentry.io/settings/account/api/auth-tokens/ and run `ultimatehuman key SENTRY_AUTH_TOKEN`.",
      ],
    };
  } finally {
    tryGit(repo, ["worktree", "remove", "--force", wt]);
  }
}
