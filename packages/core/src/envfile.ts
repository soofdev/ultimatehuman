import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uhHome } from "./home";

/**
 * <home>/engine.env (0600): the secrets the config references as ${ENV_VAR}. Written by
 * `init` (keys pasted in the wizard) and `service install`; read by the service via
 * `node --env-file` and by the daemon itself, which re-reads it so a key added later
 * is picked up without a restart.
 */
export const engineEnvPath = () => join(uhHome(), "engine.env");

export function readEnvFile(p = engineEnvPath()): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(p)) return m;
  for (const l of readFileSync(p, "utf8").split("\n")) {
    const hit = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l);
    if (hit) m.set(hit[1]!, hit[2]!.replace(/^(['"])(.*)\1$/, "$2"));
  }
  return m;
}

export function writeEnvFile(env: Map<string, string>, p = engineEnvPath()): void {
  writeFileSync(p, [...env].map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
}

/** Adds or replaces entries, keeping everything else in the file. */
export function setEngineEnv(vars: Record<string, string>, p = engineEnvPath()): void {
  const env = readEnvFile(p);
  for (const [k, v] of Object.entries(vars)) env.set(k, v);
  writeEnvFile(env, p);
}

/** Variables this process took from engine.env (so a later edit of the file can update them). */
const fromFile = new Set<string>();

/**
 * Copies engine.env into process.env. A variable exported by the real environment wins;
 * one that came from the file is refreshed. Returns the names that are new or changed.
 */
export function loadEngineEnv(p = engineEnvPath()): string[] {
  const changed: string[] = [];
  for (const [k, v] of readEnvFile(p)) {
    if (k === "PATH") continue;
    if (process.env[k] !== undefined && !fromFile.has(k)) continue;
    if (process.env[k] !== v) changed.push(k);
    process.env[k] = v;
    fromFile.add(k);
  }
  return changed;
}
