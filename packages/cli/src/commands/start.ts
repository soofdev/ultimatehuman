import { dirname, resolve } from "node:path";
import { existsSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startDaemon, ensureHome } from "@ultimatehuman/core";
import { serviceInstalled } from "./service";
import { bundledPlugins } from "../plugins";
import type { GlobalFlags } from "../flags";

export const VERSION = "0.1.0-slice";

export function dashboardDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [resolve(here, "dashboard"), resolve(here, "../../dashboard/dist")]) if (existsSync(resolve(p, "index.html"))) return p;
  return null;
}

/** Foreground engine. `init` spawns this detached; `service install` points a launchd/systemd unit at it. */
export async function start(_flags: GlobalFlags): Promise<number> {
  const d = await startDaemon({ plugins: bundledPlugins, staticDir: dashboardDir(), version: VERSION, service: {
    installed: serviceInstalled,
    install: () => {
      const fd = openSync(resolve(ensureHome(), "logs", "service-install.log"), "a");
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "service", "install"], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
      child.unref();
      closeSync(fd);
    },
  } });
  const stop = async () => {
    await d.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise(() => {});
  return 0;
}
