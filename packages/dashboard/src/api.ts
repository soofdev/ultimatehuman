import type { ApiRoutes } from "@ultimatehuman/sdk";

type Route = keyof ApiRoutes;
type Res<R extends Route> = ApiRoutes[R] extends { res: infer T } ? T : never;

/** Typed fetch against the engine. Session is an HttpOnly cookie; no tokens in JS. */
export async function api<R extends Route>(route: R, body?: unknown, params: Record<string, string> = {}): Promise<Res<R>> {
  const [method, rawPath] = route.split(" ") as [string, string];
  const path = rawPath.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ""));
  const init: RequestInit = { method, credentials: "same-origin", headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${route} -> ${res.status}`);
  return (await res.json()) as Res<R>;
}

/** Redeem the single-use code from the URL fragment, then wipe it from history. */
export async function redeemLoginFragment(): Promise<boolean> {
  const code = new URLSearchParams(location.hash.slice(1)).get("code");
  if (!code) return false;
  history.replaceState(null, "", location.pathname);
  await api("POST /api/auth/redeem", { code });
  return true;
}
