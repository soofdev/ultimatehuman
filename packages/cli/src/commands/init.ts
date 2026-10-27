import type { GlobalFlags } from "../flags";
import { bundledPlugins } from "../plugins";

/**
 * init wizard (stub). Target flow, governed by time-to-wow:
 *  1. detect Claude auth (existing login -> setup-token -> API key)
 *  2. scan env for each manifest's preferredEnv/alternateEnv
 *  3. live-probe every detected credential, print "✓ found 37 unresolved issues"
 *  4. ask ONLY for what is missing; write config with ${ENV} refs
 *  5. start the daemon and the first radar pass while printing the login link
 */
export async function init(flags: GlobalFlags, _args: string[]): Promise<number> {
  for (const p of bundledPlugins) {
    const found = p.manifest.credentials.filter((c) => process.env[c.preferredEnv]).map((c) => c.preferredEnv);
    console.log(`${p.manifest.displayName}: ${found.length ? `found ${found.join(", ")}` : "no keys in environment"}`);
  }
  if (flags.nonInteractive) console.log("non-interactive: would fail on any missing required field");
  console.log("init is a stub in this skeleton.");
  return 0;
}
