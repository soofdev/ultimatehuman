import { definePlugin, type PluginContext, type Signal, type TimeWindow } from "@ultimatehuman/sdk";

/**
 * Datadog source: error-status logs and error events, read-only. Two keys: the org API key
 * (has no scopes; /api/v1/validate checks it) and an Application key scoped to read only
 * (logs_read_data, logs_read_index_data, events_read). Every call is a GET.
 */

export const DATADOG_SCOPES = ["logs_read_data", "logs_read_index_data", "events_read"] as const;
const SITES = ["datadoghq.com", "datadoghq.eu", "us3.datadoghq.com", "us5.datadoghq.com", "ap1.datadoghq.com", "ddog-gov.com"];

const site = (ctx: PluginContext) => (ctx.credentials.site || "datadoghq.com").replace(/^https?:\/\//, "").replace(/^(api|app)\./, "").replace(/\/+$/, "");
/** API base: `https://api.<site>`, or `apiBase` when set (a proxy, or a local stub in tests). */
const api = (ctx: PluginContext) => (ctx.credentials.apiBase || `https://api.${site(ctx)}`).replace(/\/+$/, "");
const app = (ctx: PluginContext) => `https://app.${site(ctx)}`;
const headers = (ctx: PluginContext) => ({ "DD-API-KEY": ctx.credentials.apiKey ?? "", "DD-APPLICATION-KEY": ctx.credentials.appKey ?? "", Accept: "application/json" });

export interface DatadogLog {
  id: string;
  attributes: {
    timestamp: string;
    status?: string;
    service?: string;
    message?: string;
    attributes?: Record<string, any>;
  };
}

export interface DatadogEvent {
  id: number | string;
  title: string;
  text?: string;
  date_happened: number;
  alert_type?: string;
  source_type_name?: string;
  tags?: string[];
}

/** Ids, numbers and hashes out of a message so one bug groups as one signal. */
export const normalizeMessage = (m: string) =>
  m
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
const normalizeRoute = (p?: string) => (p ? p.split("?")[0]!.replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, "/:id").replace(/\/\d+(?=\/|$)/g, "/:id") : undefined);

/**
 * Error logs -> radar signals (the same `error_group` shape the PostHog adapter yields):
 * grouped by service + error kind + normalized message, users from `usr.id`, route from
 * `http.url_details.path`, release from `version`.
 */
export function logsToSignals(logs: readonly DatadogLog[], siteHost: string): Signal[] {
  const groups = new Map<string, { logs: DatadogLog[]; service: string; kind: string; msg: string; route?: string; users: Set<string>; releases: Set<string> }>();
  for (const l of logs) {
    const a = l.attributes;
    const inner = a.attributes ?? {};
    const kind = String(inner.error?.kind ?? "Error");
    const msg = normalizeMessage(String(inner.error?.message ?? a.message ?? ""));
    const service = a.service ?? "unknown";
    const route = normalizeRoute(inner.http?.url_details?.path);
    const key = `${service}|${kind}|${msg}`;
    const g = groups.get(key) ?? { logs: [], service, kind, msg, ...(route ? { route } : {}), users: new Set<string>(), releases: new Set<string>() };
    g.logs.push(l);
    if (inner.usr?.id) g.users.add(String(inner.usr.id));
    if (inner.version) g.releases.add(String(inner.version));
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => {
    const ts = g.logs.map((l) => l.attributes.timestamp).sort();
    const users = [...g.users];
    const q = encodeURIComponent(`status:error service:${g.service} "${g.msg.split("#")[0]!.slice(0, 60).trim()}"`);
    return {
      id: `datadog:log:${key}`,
      pluginId: "datadog",
      type: "error_group",
      title: `${g.kind}: ${g.msg.slice(0, 80)}${g.route ? ` on ${g.route}` : ` in ${g.service}`}`,
      firstSeen: ts[0]!,
      lastSeen: ts.at(-1)!,
      count: g.logs.length,
      usersAffected: users.length,
      url: `https://app.${siteHost}/logs?query=${q}`,
      keys: { fingerprint: `datadog|${key}`, users, service: g.service, ...(g.route ? { route: g.route } : {}), ...(g.releases.size ? { release: [...g.releases] } : {}) },
      excerpt: { service: g.service, kind: g.kind, message: g.msg, route: g.route, occurrences: g.logs.length, users: users.length, sampleStack: String(g.logs[0]!.attributes.attributes?.error?.stack ?? "").slice(0, 600) },
    } satisfies Signal;
  });
}

/** Error events (monitor alerts, deploy failures) -> one signal per title. */
export function eventsToSignals(events: readonly DatadogEvent[], siteHost: string): Signal[] {
  const groups = new Map<string, DatadogEvent[]>();
  for (const e of events.filter((e) => e.alert_type === "error")) groups.set(e.title, [...(groups.get(e.title) ?? []), e]);
  return [...groups.entries()].map(([title, es]) => {
    const t = es.map((e) => new Date(e.date_happened * 1000).toISOString()).sort();
    return {
      id: `datadog:event:${title}`,
      pluginId: "datadog",
      type: "event_anomaly",
      title: `Datadog event: ${title.slice(0, 100)}`,
      firstSeen: t[0]!,
      lastSeen: t.at(-1)!,
      count: es.length,
      url: `https://app.${siteHost}/event/explorer?query=${encodeURIComponent(title)}`,
      keys: { fingerprint: `datadog|event|${title}`, users: [], tags: [...new Set(es.flatMap((e) => e.tags ?? []))].slice(0, 20) },
      excerpt: { title, source: es[0]!.source_type_name, occurrences: es.length, text: String(es[0]!.text ?? "").slice(0, 400) },
    } satisfies Signal;
  });
}

async function getJson<T>(ctx: PluginContext, path: string): Promise<{ status: number; body: T | null }> {
  const r = await ctx.http.get(`${api(ctx)}${path}`, { headers: headers(ctx) });
  let body: T | null = null;
  try {
    body = await r.json<T>();
  } catch {
    /* non-JSON error page */
  }
  return { status: r.status, body };
}

const logsPath = (from: string, to: string, limit: number, cursor?: string) =>
  `/api/v2/logs/events?${new URLSearchParams({ "filter[query]": "status:error", "filter[from]": from, "filter[to]": to, "page[limit]": String(limit), sort: "timestamp", ...(cursor ? { "page[cursor]": cursor } : {}) })}`;

export default definePlugin({
  manifest: {
    id: "datadog",
    displayName: "Datadog",
    kind: "source",
    newcomerScore: 60,
    requiredScopes: DATADOG_SCOPES,
    credentials: [
      {
        key: "apiKey",
        label: "API key",
        secret: true,
        preferredEnv: "DATADOG_API_KEY",
        alternateEnv: ["DD_API_KEY"],
        helpUrl: "https://app.datadoghq.com/organization-settings/api-keys",
        helpText: "Organization API key (an org admin can create or share one; it has no scopes).",
      },
      {
        key: "appKey",
        label: "Application key",
        secret: true,
        preferredEnv: "DATADOG_APP_KEY",
        alternateEnv: ["DD_APP_KEY", "DD_APPLICATION_KEY"],
        helpUrl: "https://app.datadoghq.com/personal-settings/application-keys",
        helpText: `Scoped Application key with only: ${DATADOG_SCOPES.join(", ")}.`,
      },
      {
        key: "site",
        label: "Datadog site",
        secret: false,
        preferredEnv: "DATADOG_SITE",
        alternateEnv: ["DD_SITE"],
        helpUrl: "https://docs.datadoghq.com/getting_started/site/",
        helpText: `The site in your Datadog URL: ${SITES.join(", ")}.`,
        default: "datadoghq.com",
      },
      {
        key: "apiBase",
        label: "API base URL",
        secret: false,
        preferredEnv: "DATADOG_API_BASE",
        helpUrl: "https://docs.datadoghq.com/api/",
        helpText: "Leave empty: derived from the site. Set only for a proxy or a local stub.",
        optional: true,
      },
    ],
    options: {
      maxLogs: { type: "number", label: "Error logs read per pass", default: 2000, min: 100, max: 10000 },
    },
    docsUrl: "https://docs.datadoghq.com/api/latest/logs/",
  },
  async probe(ctx: PluginContext) {
    const v = await getJson<{ valid?: boolean }>(ctx, "/api/v1/validate");
    if (v.status !== 200 || !v.body?.valid) return { ok: false, summary: `API key rejected by ${site(ctx)} (HTTP ${v.status})`, fix: `Check the API key and the site (EU accounts use datadoghq.eu).` };
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 3600_000);
    const logs = await getJson<{ data?: DatadogLog[] }>(ctx, logsPath(from.toISOString(), to.toISOString(), 100));
    if (logs.status === 401 || logs.status === 403)
      return { ok: false, summary: `API key valid on ${site(ctx)}, but the Application key cannot read logs (HTTP ${logs.status})`, fix: `Use an Application key with ${DATADOG_SCOPES.join(", ")}.` };
    if (logs.status !== 200) return { ok: false, summary: `Logs read failed on ${site(ctx)} (HTTP ${logs.status})`, fix: "Retry; if it persists, check the Datadog status page." };
    const ev = await getJson<{ events?: DatadogEvent[] }>(ctx, `/api/v1/events?start=${Math.floor(from.getTime() / 1000)}&end=${Math.floor(to.getTime() / 1000)}`);
    const n = logs.body?.data?.length ?? 0;
    const errEvents = (ev.body?.events ?? []).filter((e) => e.alert_type === "error").length;
    const services = new Set((logs.body?.data ?? []).map((l) => l.attributes.service).filter(Boolean));
    return {
      ok: true,
      summary: `Keys valid on ${site(ctx)} · ${n === 100 ? "100+" : n} error logs in the last 24 h${services.size ? ` across ${services.size} service${services.size === 1 ? "" : "s"}` : ""}${ev.status === 200 ? ` · ${errEvents} error event${errEvents === 1 ? "" : "s"}` : " · events not readable (needs events_read)"}`,
      detected: { site: site(ctx), errorLogs24h: n, services: [...services], errorEvents24h: errEvents },
    };
  },
  source: {
    async *collect(ctx: PluginContext, window: TimeWindow): AsyncIterable<Signal> {
      const max = Number(ctx.options.maxLogs ?? 2000);
      const logs: DatadogLog[] = [];
      let cursor: string | undefined;
      do {
        const r = await getJson<{ data?: DatadogLog[]; meta?: { page?: { after?: string } } }>(ctx, logsPath(window.from, window.to, 1000, cursor));
        if (r.status !== 200) throw new Error(`Datadog logs read failed (HTTP ${r.status})`);
        logs.push(...(r.body?.data ?? []));
        cursor = r.body?.meta?.page?.after;
      } while (cursor && logs.length < max);
      yield* logsToSignals(logs.slice(0, max), site(ctx));
      const ev = await getJson<{ events?: DatadogEvent[] }>(ctx, `/api/v1/events?start=${Math.floor(Date.parse(window.from) / 1000)}&end=${Math.floor(Date.parse(window.to) / 1000)}`);
      if (ev.status === 200) yield* eventsToSignals(ev.body?.events ?? [], site(ctx));
      else ctx.log("warn", `events not readable (HTTP ${ev.status}); logs only`);
    },
  },
});
