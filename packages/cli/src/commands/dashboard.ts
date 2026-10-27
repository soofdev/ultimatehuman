import { controlKey } from "@ultimatehuman/core";

/** Prints a fresh single-use login link from the running engine. */
export async function dashboard(): Promise<number> {
  const r = await fetch("http://127.0.0.1:4747/api/auth/link", { method: "POST", headers: { "x-uh-control": controlKey() } }).catch(() => null);
  if (!r?.ok) {
    console.error("The engine is not running. Start it with `ultimatehuman start` (or rerun init).");
    return 1;
  }
  console.log(((await r.json()) as { url: string }).url);
  return 0;
}
