#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { parseArgs } from "node:util";
import { init } from "./commands/init";
import { start, VERSION } from "./commands/start";
import { doctor } from "./commands/doctor";
import { configCmd } from "./commands/config";
import { dashboard } from "./commands/dashboard";
import { service, serviceInstalled } from "./commands/service";
import { ci } from "./commands/ci";
import { chat } from "./commands/chat";
import { key } from "./commands/key";
import { welcome } from "./commands/welcome";

const USAGE = `ultimatehuman <command>

  (no command) Detect Claude and open the shared setup chat
  --version   Print the installed version

  init        Detect Claude and set up through chat (--advanced keeps the original wizard)
  start       Run the engine in the foreground (dashboard on 127.0.0.1:4747)
  doctor      Check config, credentials, scopes and service; --fix repairs
  config      get <path> | set <path> <value> | schema
  dashboard   Print a single-use dashboard login link
  chat        The setup chat (same conversation as the dashboard Chat page and Telegram);
              chat "<message>" sends one message and prints the reply
  telegram    Pair this conversation with your Telegram bot
  stop        Stop the engine started by init
  service     install | uninstall | status (systemd user unit / launchd agent)
  ci          install [--repo <name|path>] [--base main] [--runner-label <label>] [--model <id>] [--force]
              writes the PR review check (workflow + .github/review/) into a repo; never commits

  key         <ENV_NAME> saves one secret into the engine env file (prompted, never echoed);
              a pending tracker key is picked up by the running engine within a minute

Repository setup: --repos <path-or-url,path-or-url> --port <n> --no-open
Full setup (init): --pipelines <template,template>, --test-url <url>,
--project <posthog id>, --repo owner/name, --notify-prefix <text>, --notify-server <url>,
--port <n>;
pass --non-interactive to take the detected defaults instead of prompting.`;

async function main(argv: string[]): Promise<number> {
  let [command, ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return 0;
  }
  if (!command || (command.startsWith("--") && command !== "--help")) { rest = argv; command = "welcome"; }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      "non-interactive": { type: "boolean" },
      "no-open": { type: "boolean" },
      advanced: { type: "boolean" },
      json: { type: "boolean" },
      fix: { type: "boolean" },
      config: { type: "string" },
      project: { type: "string" },
      repo: { type: "string" },
      "notify-prefix": { type: "string" },
      "notify-server": { type: "string" },
      repos: { type: "string" },
      pipelines: { type: "string" },
      "test-url": { type: "string" },
      port: { type: "string" },
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
    noOpen: values["no-open"] === true,
    advanced: values.advanced === true,
    ...(typeof values.project === "string" ? { project: values.project } : {}),
    ...(typeof values.repo === "string" ? { repo: values.repo } : {}),
    ...(typeof values["notify-prefix"] === "string" ? { notifyPrefix: values["notify-prefix"] } : {}),
    ...(typeof values["notify-server"] === "string" ? { notifyServer: values["notify-server"] } : {}),
    ...(typeof values.repos === "string" ? { repos: values.repos } : {}),
    ...(typeof values.pipelines === "string" ? { pipelines: values.pipelines } : {}),
    ...(typeof values["test-url"] === "string" ? { testUrl: values["test-url"] } : {}),
    ...(typeof values.port === "string" && Number(values.port) > 0 ? { port: Number(values.port) } : {}),
  };
  switch (command) {
    case "init":
      return flags.advanced || flags.pipelines !== undefined ? init(flags, positionals) : welcome(flags);
    case "telegram": {
      const { telegram } = await import("./commands/telegram");
      return telegram();
    }
    case "welcome":
      return flags.advanced || flags.pipelines !== undefined ? init(flags, []) : welcome(flags);
    case "start":
      return start(flags);
    case "doctor":
      return doctor(flags);
    case "config":
      return configCmd(positionals);
    case "dashboard":
      return dashboard();
    case "chat":
      return chat(positionals);
    case "key":
      return key(positionals);
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
