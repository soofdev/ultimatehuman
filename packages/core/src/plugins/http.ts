import type { HttpResponse, OutboundHttp, ReadOnlyHttp } from "@ultimatehuman/sdk";

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

/** The hosts a notify plugin may reach: its declared ones, plus the server the user put in its `hostOption`. */
export function notifyHosts(plugin: { sendHosts: readonly string[]; hostOption?: string }, options: Readonly<Record<string, unknown>>): string[] {
  const custom = plugin.hostOption ? options[plugin.hostOption] : undefined;
  if (typeof custom !== "string" || !custom) return [...plugin.sendHosts];
  try {
    return [...plugin.sendHosts, new URL(custom).host];
  } catch {
    return [...plugin.sendHosts];
  }
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/;

/**
 * Outbound HTTP handed to notify plugins: POST only, and only to the hosts in
 * `notifyHosts` (https; plain http only on loopback). Anything else throws before a byte leaves.
 */
export function outboundHttp(pluginId: string, hosts: readonly string[], log: (m: string) => void, signal?: AbortSignal): OutboundHttp {
  return {
    async post(url: string, body: unknown, init?: { headers?: Record<string, string> }) {
      const u = new URL(url);
      const allowed = hosts.includes(u.host) || hosts.includes(u.hostname);
      if (!allowed || (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.test(u.host)))) {
        const why = allowed ? "plain http is only allowed on loopback" : "not one of its sendHosts";
        log(`refused POST to ${u.host} for notify plugin ${pluginId}: ${why}`);
        throw new WriteRefusedError(`notify plugin ${pluginId} tried POST ${u.protocol}//${u.host}: ${why}`);
      }
      const form = typeof FormData !== "undefined" && body instanceof FormData;
      const r = await fetch(url, {
        method: "POST",
        headers: form ? (init?.headers ?? {}) : { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        body: form ? body : JSON.stringify(body),
        signal: signal ?? null,
      });
      const text = await r.text();
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => (headers[k] = v));
      return { status: r.status, headers, json: async <T>() => JSON.parse(text) as T, text: async () => text };
    },
  };
}
