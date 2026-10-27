import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startDaemon } from "@ultimatehuman/core";
import { bundledPlugins } from "../plugins";
import type { GlobalFlags } from "../flags";

export const VERSION = "0.1.0-slice";

export function dashboardDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [resolve(here, "dashboard"), resolve(here, "../../dashboard/dist")]) if (existsSync(resolve(p, "index.html"))) return p;
  return null;
}

/** Foreground engine. `init` spawns this detached; `service install` (not in this slice) would point a unit at it. */
export async function start(_flags: GlobalFlags): Promise<number> {
  const d = await startDaemon({ plugins: bundledPlugins, staticDir: dashboardDir(), version: VERSION });
  const stop = async () => {
    await d.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise(() => {});
  return 0;
}
