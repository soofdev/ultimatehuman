#!/usr/bin/env node
import { parseArgs } from "node:util";
import { init } from "./commands/init";
import { start } from "./commands/start";
import { doctor } from "./commands/doctor";
import { configCmd } from "./commands/config";

const USAGE = `ultimatehuman <command>

  init        Detect keys, probe each source, start the first radar pass
  start       Run the engine in the foreground (dashboard on 127.0.0.1:4747)
  doctor      Check config, credentials, scopes and service; --fix repairs
  config      get <path> | set <path> <value> | schema
  dashboard   Print a single-use dashboard login link
  service     install | uninstall | status (systemd user unit / launchd agent)

Every interactive step has a flag; pass --non-interactive to fail instead of prompting.`;

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
    },
  });
  const flags = { nonInteractive: values["non-interactive"] === true, json: values.json === true, fix: values.fix === true };
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
    case "service":
      console.log(`${command} is a stub in this skeleton.`);
      return 0;
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
