import { readFile, writeFile, rename, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { ConfigSchema, migrateConfig, type Config } from "./schema";
import { uhHome } from "../home";

export class MissingEnvVarError extends Error {
  constructor(
    readonly varName: string,
    readonly configPath: string,
  ) {
    super(`config ${configPath} references \${${varName}} but it is not set`);
  }
}

export type SecretRefValue = string | { source: "env"; id: string } | { source: "file"; path: string };

export function defaultConfigPath(): string {
  return process.env.ULTIMATEHUMAN_CONFIG ?? join(uhHome(), "config.json5");
}

/** Parse + validate. Secret refs stay as refs; call resolveSecretRefs at use time only. */
export async function loadConfig(path = defaultConfigPath()): Promise<Config> {
  const raw = await readFile(path, "utf8");
  return ConfigSchema.parse(migrateConfig(JSON5.parse(raw)));
}

export async function loadRawConfig(path = defaultConfigPath()): Promise<string> {
  return readFile(path, "utf8");
}

/** Validate, then write atomically, keeping a .bak ring of 5. Only a config that validates is ever written. */
export async function writeConfig(config: unknown, path = defaultConfigPath(), header?: string): Promise<Config> {
  config = migrateConfig(config);
  const parsed = ConfigSchema.parse(config);
  if (existsSync(path)) {
    for (let i = 4; i >= 1; i--) {
      if (existsSync(`${path}.bak${i}`)) await rename(`${path}.bak${i}`, `${path}.bak${i + 1}`);
    }
    await copyFile(path, `${path}.bak1`);
  }
  const body = (header ? header.trimEnd() + "\n" : "") + JSON5.stringify(config, null, 2) + "\n";
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, path);
  return parsed;
}

/** Dereference a single secret ref into memory. Never written back, never logged. */
export async function resolveSecretRefs(
  ref: SecretRefValue,
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
  const st = await stat(ref.path);
  if ((st.mode & 0o077) !== 0) throw new Error(`secret file ${ref.path} must be mode 0600`);
  return (await readFile(ref.path, "utf8")).trim();
}

/** Show a secret ref without ever revealing a value. */
export function describeRef(ref: unknown): string {
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object" && "source" in ref) {
    const r = ref as { source: string; id?: string; path?: string };
    return r.source === "env" ? `\${${r.id}}` : `file:${r.path}`;
  }
  return String(ref);
}
