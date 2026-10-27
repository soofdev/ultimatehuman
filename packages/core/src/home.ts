import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Data dir: ~/.ultimatehuman (0700). ULTIMATEHUMAN_HOME overrides it. */
export function uhHome(): string {
  return process.env.ULTIMATEHUMAN_HOME ?? join(homedir(), ".ultimatehuman");
}

export function ensureHome(): string {
  const home = uhHome();
  for (const d of [home, join(home, "runs"), join(home, "logs")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  chmodSync(home, 0o700);
  return home;
}

/**
 * Local control secret shared by the CLI and the daemon (0600 file). Lets
 * `ultimatehuman dashboard` ask the running daemon for a login link without
 * any token ever travelling in a URL.
 */
export function controlKey(): string {
  const p = join(ensureHome(), "control.key");
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("hex"), { mode: 0o600 });
  return readFileSync(p, "utf8").trim();
}
