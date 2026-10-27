import type { DoctorCheck } from "@ultimatehuman/sdk";
import type { GlobalFlags } from "../flags";

/** Checks: config parses + validates, every ${ENV} ref resolves, every plugin probe passes,
 *  tokens are not over-scoped, auth source reachable, service unit matches binary, store schema current. */
export async function doctor(flags: GlobalFlags): Promise<number> {
  const checks: DoctorCheck[] = [{ id: "skeleton", ok: true, message: "doctor is a stub in this skeleton", fixable: false }];
  if (flags.json) console.log(JSON.stringify({ checks }));
  else for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.message}`);
  return checks.every((c) => c.ok) ? 0 : 1;
}
