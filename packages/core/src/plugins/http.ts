import type { HttpResponse, ReadOnlyHttp } from "@ultimatehuman/sdk";

/**
 * Read-only HTTP handed to source plugins. GET only, plus POST to the
 * plugin's declared read-semantics endpoints. Anything else throws, is logged,
 * and aborts the step.
 */
export class WriteRefusedError extends Error {}

export function readOnlyHttp(pluginId: string, allowlist: readonly RegExp[], log: (m: string) => void, signal?: AbortSignal): ReadOnlyHttp & { calls: number } {
  const wrap = async (r: Response): Promise<HttpResponse> => {
    const text = await r.text();
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    return { status: r.status, headers, json: async <T>() => JSON.parse(text) as T, text: async () => text };
  };
  const api = {
    calls: 0,
    async get(url: string, init?: { headers?: Record<string, string> }) {
      api.calls++;
      return wrap(await fetch(url, { method: "GET", headers: init?.headers ?? {}, signal: signal ?? null }));
    },
    async query(url: string, body: unknown, init?: { headers?: Record<string, string> }) {
      const path = new URL(url).pathname;
      if (!allowlist.some((re) => re.test(path))) {
        log(`refused POST ${path} for plugin ${pluginId}: not in readOnlyPostAllowlist`);
        throw new WriteRefusedError(`plugin ${pluginId} tried POST ${path}, which is not an allowlisted read endpoint`);
      }
      api.calls++;
      return wrap(
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
          body: JSON.stringify(body),
          signal: signal ?? null,
        }),
      );
    },
  };
  return api;
}
