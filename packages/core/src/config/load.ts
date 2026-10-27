import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { ConfigSchema, type Config } from "./schema";

export class MissingEnvVarError extends Error {
  constructor(
    readonly varName: string,
    readonly configPath: string,
  ) {
    super(`config ${configPath} references \${${varName}} but it is not set`);
  }
}

export function defaultConfigPath(): string {
  return process.env.ULTIMATEHUMAN_CONFIG ?? join(homedir(), ".ultimatehuman", "config.json5");
}

/** Parse + validate. Secret refs stay as refs; call resolveSecretRefs at use time only. */
export async function loadConfig(path = defaultConfigPath()): Promise<Config> {
  const raw = await readFile(path, "utf8");
  return ConfigSchema.parse(JSON5.parse(raw));
}

/** Dereference a single secret ref into memory. Never written back, never logged. */
export async function resolveSecretRefs(
  ref: string | { source: "env"; id: string } | { source: "file"; path: string },
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (typeof ref === "string") {
    const m = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(ref);
    if (!m) return ref; // non-secret plain value
    const name = m[1]!;
    const v = env[name];
    if (!v) throw new MissingEnvVarError(name, configPath);
    return v;
  }
  if (ref.source === "env") {
    const v = env[ref.id];
    if (!v) throw new MissingEnvVarError(ref.id, configPath);
    return v;
  }
  return (await readFile(ref.path, "utf8")).trim();
}
