#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { parseArgs } from "node:util";
import { init } from "./commands/init";
import { start } from "./commands/start";
import { doctor } from "./commands/doctor";
import { configCmd } from "./commands/config";
import { dashboard } from "./commands/dashboard";
import { service, serviceInstalled } from "./commands/service";
import { ci } from "./commands/ci";

const USAGE = `ultimatehuman <command>

  init        Detect keys, probe each source, start the first radar pass
  start       Run the engine in the foreground (dashboard on 127.0.0.1:4747)
  doctor      Check config, credentials, scopes and service; --fix repairs
  config      get <path> | set <path> <value> | schema
  dashboard   Print a single-use dashboard login link
  stop        Stop the engine started by init
  service     install | uninstall | status (systemd user unit / launchd agent)
  ci          install [--repo <name|path>] [--base main] [--runner-label <label>] [--model <id>] [--force]
              writes the PR review check (workflow + .github/review/) into a repo; never commits

Every interactive step has a flag (init: --project <posthog id>, --repo owner/name,
--notify-prefix <text>, --notify-server <url>);
pass --non-interactive to take the detected defaults instead of prompting.`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      "non-interactive": { type: "boolean" },
      json: { type: "boolean" },
      fix: { type: "boolean" },
      config: { type: "string" },
      project: { type: "string" },
      repo: { type: "string" },
      "notify-prefix": { type: "string" },
      "notify-server": { type: "string" },
      base: { type: "string" },
      "runner-label": { type: "string" },
      model: { type: "string" },
      force: { type: "boolean" },
    },
  });
  const flags = {
    nonInteractive: values["non-interactive"] === true,
    json: values.json === true,
    fix: values.fix === true,
    ...(typeof values.project === "string" ? { project: values.project } : {}),
    ...(typeof values.repo === "string" ? { repo: values.repo } : {}),
    ...(typeof values["notify-prefix"] === "string" ? { notifyPrefix: values["notify-prefix"] } : {}),
    ...(typeof values["notify-server"] === "string" ? { notifyServer: values["notify-server"] } : {}),
  };
  switch (command) {
    case "init":
      return init(flags, positionals);
    case "start":
      return start(flags);
    case "doctor":
      return doctor(flags);
    case "config":
      return configCmd(positionals);
    case "dashboard":
      return dashboard();
    case "stop": {
      if (serviceInstalled()) {
        console.log("the engine runs as a service (it would restart); use `ultimatehuman service uninstall` to stop it");
        return 1;
      }
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { uhHome } = await import("@ultimatehuman/core");
      try {
        const pid = Number(readFileSync(join(uhHome(), "engine.pid"), "utf8"));
        process.kill(pid, "SIGTERM");
        console.log(`engine (pid ${pid}) stopped`);
        return 0;
      } catch {
        console.log("engine is not running");
        return 1;
      }
    }
    case "service":
      return service(positionals[0], flags);
    case "ci":
      return ci(positionals[0], {
        ...(typeof values.repo === "string" ? { repo: values.repo } : {}),
        ...(typeof values.base === "string" ? { base: values.base } : {}),
        ...(typeof values["runner-label"] === "string" ? { runnerLabel: values["runner-label"] } : {}),
        ...(typeof values.model === "string" ? { model: values.model } : {}),
        force: values.force === true,
      });
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
