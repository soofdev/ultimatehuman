import type { GlobalFlags } from "../flags";

export async function start(_flags: GlobalFlags): Promise<number> {
  console.log("start is a stub in this skeleton (core-engine leg wires loadConfig -> startDaemon).");
  return 0;
}
