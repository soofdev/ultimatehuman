import { definePlugin, type PluginContext, type ProbeResult, type Signal, type TimeWindow } from "@ultimatehuman/sdk";

/**
 * PostHog source. Read-only: GETs plus the HogQL query endpoint (POST with
 * read semantics, allowlisted). Signals: interaction friction (rage clicks,
 * dead clicks, dead swipes) per route with a previous-window baseline,
 * $exception groups, slow LCP per route, and recordings that logged console
 * errors. Team members' own activity and the project's test-account filters
 * are excluded before anything is counted.
 */

const QUERY_PATH = /\/api\/projects\/[^/]+\/query\/?$/;

interface Ctx extends PluginContext {}

function base(ctx: Ctx): string {
  return (ctx.credentials.host ?? "https://us.posthog.com").replace(/\/$/, "");
}
function auth(ctx: Ctx): Record<string, string> {
  return { Authorization: `Bearer ${ctx.credentials.apiKey}` };
}
function projectId(ctx: Ctx): string {
  const p = ctx.options.projectId;
  if (!p) throw new Error("posthog.options.projectId is not set (run init or doctor to detect it)");
  return String(p);
}

async function getJson<T>(ctx: Ctx, path: string): Promise<T> {
  const r = await ctx.http.get(`${base(ctx)}${path}`, { headers: auth(ctx) });
  if (r.status >= 400) throw new Error(`PostHog GET ${path.split("?")[0]} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json<T>();
}

export async function hogql(ctx: Ctx, query: string): Promise<{ columns: string[]; results: unknown[][] }> {
  const url = `${base(ctx)}/api/projects/${projectId(ctx)}/query/`;
  const r = await ctx.http.query(url, { query: { kind: "HogQLQuery", query }, name: "ultimatehuman-radar" }, { headers: auth(ctx) });
  if (r.status >= 400) throw new Error(`PostHog HogQL -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function iso(t: string): string {
  return t.replace("T", " ").replace(/\.\d+Z?$/, "").replace(/Z$/, "");
}
function sqlStr(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** /dashboard/agents/68f9f5bfb726b7897b8c383b/knowledge -> /dashboard/agents/:id/knowledge */
export function normalizeRoute(path: string | null | undefined): string {
  if (!path) return "(unknown page)";
  return (
    path
      .split("/")
      .map((seg) =>
        /^[0-9a-f]{16,}$/i.test(seg) || /^[0-9a-f-]{32,36}$/i.test(seg) || /^\d{3,}$/.test(seg) || (seg.length > 24 && /\d/.test(seg))
          ? ":id"
          : seg,
      )
      .join("/") || "/"
  );
}

/** Project test-account filters (simple property regex / exact forms) as a HogQL predicate. */
async function filtersSql(ctx: Ctx): Promise<{ sql: string; notes: string[] }> {
  const parts: string[] = [];
  const notes: string[] = [];
  const proj = await getJson<{ test_account_filters?: { key: string; type: string; value: unknown; operator: string }[] }>(
    ctx,
    `/api/projects/${projectId(ctx)}/`,
  );
  for (const f of proj.test_account_filters ?? []) {
    const col = f.type === "person" ? `person.properties.${f.key}` : `properties.${f.key}`;
    const v = Array.isArray(f.value) ? f.value : [f.value];
    if (f.operator === "not_regex") parts.push(`NOT match(toString(${col}), ${sqlStr(String(v[0]))})`);
    else if (f.operator === "not_icontains") parts.push(`NOT (toString(${col}) ILIKE ${sqlStr(`%${String(v[0])}%`)})`);
    else if (f.operator === "is_not") parts.push(`toString(${col}) NOT IN (${v.map((x) => sqlStr(String(x))).join(",")})`);
    else continue;
    notes.push(`test-account filter ${f.key} ${f.operator}`);
  }
  if (ctx.options.excludeTeamMembers !== false) {
    const members = await getJson<{ results: { user: { email: string } }[] }>(ctx, `/api/organizations/@current/members/`);
    const emails = members.results.map((m) => m.user.email).filter(Boolean);
    if (emails.length) {
      parts.push(`coalesce(toString(person.properties.email), '') NOT IN (${emails.map(sqlStr).join(",")})`);
      notes.push(`${emails.length} team members' own activity excluded`);
    }
  }
  return { sql: parts.length ? parts.map((p) => `(${p})`).join(" AND ") : "1 = 1", notes };
}

export function insightLink(ctx: Ctx, query: string): string {
  const q = { kind: "DataTableNode", source: { kind: "HogQLQuery", query } };
  return `${base(ctx)}/project/${projectId(ctx)}/insights/new#q=${encodeURIComponent(JSON.stringify(q)).replace(/[()']/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase())}`;
}
export function replayLink(ctx: Ctx, sessionId: string): string {
  return `${base(ctx)}/project/${projectId(ctx)}/replay/${sessionId}`;
}
export function personLink(ctx: Ctx, distinctId: string): string {
  return `${base(ctx)}/project/${projectId(ctx)}/person/${encodeURIComponent(distinctId)}#activeTab=events`;
}

const FRICTION_LABEL: Record<string, string> = {
  $rageclick: "rage clicks",
  $dead_click: "dead clicks",
  $dead_swipe: "dead swipes",
};

interface FrictionRow {
  event: string;
  route: string;
  el: string | null;
  count: number;
  users: Set<string>;
  sessions: Set<string>;
  first: string;
  last: string;
}

export default definePlugin({
  manifest: {
    id: "posthog",
    displayName: "PostHog",
    kind: "source",
    newcomerScore: 80,
    requiredScopes: ["query:read", "session_recording:read", "error_tracking:read", "project:read", "organization_member:read"],
    credentials: [
      {
        key: "apiKey",
        label: "Personal API key",
        secret: true,
        preferredEnv: "POSTHOG_PERSONAL_API_KEY",
        alternateEnv: ["POSTHOG_API_KEY"],
        helpUrl: "https://app.posthog.com/settings/user-api-keys",
        helpText: "Create a personal API key with read-only scopes: Query, Session recording, Error tracking, Project.",
        pattern: "^phx_[A-Za-z0-9]+$",
      },
      {
        key: "host",
        label: "PostHog host",
        secret: false,
        preferredEnv: "POSTHOG_HOST",
        helpUrl: "https://posthog.com/docs/api",
        helpText: "https://us.posthog.com, https://eu.posthog.com, or your self-hosted URL.",
        default: "https://us.posthog.com",
      },
    ],
    options: {
      projectId: { type: "string", label: "Project id", helpText: "Auto-detected by the probe." },
      excludeTeamMembers: { type: "boolean", label: "Exclude your team's own activity", default: true },
    },
    docsUrl: "https://posthog.com/docs/api",
  },
  readOnlyPostAllowlist: [QUERY_PATH],

  async probe(ctx: Ctx): Promise<ProbeResult> {
    let projects: { id: number; name: string }[];
    try {
      projects = (await getJson<{ results: { id: number; name: string }[] }>(ctx, "/api/projects/")).results;
    } catch (e) {
      const msg = (e as Error).message;
      return {
        ok: false,
        summary: /401|403/.test(msg) ? "PostHog rejected the key" : `PostHog unreachable: ${msg}`,
        fix: /401/.test(msg) ? "Check the host (EU keys only work on https://eu.posthog.com) or create a new personal API key." : "Check the host URL.",
      };
    }
    const counts: { id: number; name: string; events7d: number; users7d: number }[] = [];
    for (const p of projects) {
      const pctx = { ...ctx, options: { ...ctx.options, projectId: String(p.id) } } as Ctx;
      try {
        const r = await hogql(pctx, "SELECT count(), uniq(distinct_id) FROM events WHERE timestamp > now() - INTERVAL 7 DAY");
        counts.push({ id: p.id, name: p.name, events7d: Number(r.results[0]?.[0] ?? 0), users7d: Number(r.results[0]?.[1] ?? 0) });
      } catch {
        counts.push({ id: p.id, name: p.name, events7d: -1, users7d: -1 });
      }
    }
    counts.sort((a, b) => b.events7d - a.events7d);
    const chosen = ctx.options.projectId ? counts.find((c) => String(c.id) === String(ctx.options.projectId)) ?? counts[0] : counts[0];
    if (!chosen) return { ok: false, summary: "The key sees no PostHog project", fix: "Grant the key access to your project." };

    let overScoped: string[] | undefined;
    try {
      const key = await getJson<{ scopes?: string[] }>(ctx, "/api/personal_api_keys/@current/");
      const writes = (key.scopes ?? []).filter((s) => s === "*" || s.endsWith(":write"));
      if (writes.length) overScoped = writes;
    } catch {
      /* provider did not let us introspect: no warning, no claim */
    }
    const res: ProbeResult = {
      ok: chosen.events7d >= 0,
      summary: `${chosen.events7d.toLocaleString("en-US")} events from ${chosen.users7d.toLocaleString("en-US")} people in the last 7 days · "${chosen.name}" (${chosen.id})`,
      detected: { projectId: String(chosen.id), projects: counts, host: base(ctx) },
    };
    if (overScoped) res.overScoped = overScoped;
    return res;
  },

  source: {
    async *collect(ctx: Ctx, window: TimeWindow): AsyncIterable<Signal> {
      const { sql: filt, notes } = await filtersSql(ctx);
      ctx.log("info", `filters: ${notes.join("; ") || "none"}`);
      const from = iso(window.from);
      const to = iso(window.to);
      const spanMs = Date.parse(window.to) - Date.parse(window.from);
      const prevFrom = iso(new Date(Date.parse(window.from) - spanMs).toISOString());

      // 1. Interaction friction per route, current window + previous window as baseline.
      const fq = (a: string, b: string) => `SELECT event, properties.$pathname, properties.$el_text, count(), groupUniqArray(500)(distinct_id), groupUniqArray(50)(properties.$session_id), min(timestamp), max(timestamp)
FROM events WHERE event IN ('$rageclick', '$dead_click', '$dead_swipe') AND timestamp >= toDateTime('${a}') AND timestamp < toDateTime('${b}') AND ${filt}
GROUP BY event, properties.$pathname, properties.$el_text LIMIT 2000`;
      const cur = await hogql(ctx, fq(from, to));
      const prev = await hogql(ctx, fq(prevFrom, from));
      const agg = (rows: unknown[][]) => {
        const m = new Map<string, FrictionRow>();
        for (const r of rows) {
          const [event, path, el, count, users, sessions, first, last] = r as [string, string, string | null, number, string[], string[], string, string];
          const route = normalizeRoute(path);
          const key = `${route}|${event}`;
          const row = m.get(key) ?? { event, route, el: null, count: 0, users: new Set(), sessions: new Set(), first, last };
          row.count += Number(count);
          users.forEach((u) => row.users.add(u));
          sessions.filter(Boolean).forEach((s) => row.sessions.add(s));
          if (el && !row.el) row.el = el;
          if (first < row.first) row.first = first;
          if (last > row.last) row.last = last;
          m.set(key, row);
        }
        return m;
      };
      // When did the project start capturing each friction event at all? A "new" trend means nothing if tracking began this week.
      const since = await hogql(
        ctx,
        `SELECT event, min(timestamp) FROM events WHERE event IN ('$rageclick', '$dead_click', '$dead_swipe', '$web_vitals') AND timestamp > now() - INTERVAL 180 DAY GROUP BY event`,
      );
      const trackedSince = new Map(since.results.map((r) => [String(r[0]), String(r[1])]));
      const curAgg = agg(cur.results);
      const prevAgg = agg(prev.results);
      const elsByKey = new Map<string, Map<string, number>>();
      for (const r of cur.results) {
        const [event, path, el, count] = r as [string, string, string | null, number];
        const k = `${normalizeRoute(path)}|${event}`;
        const m = elsByKey.get(k) ?? new Map();
        const label = el ? el.slice(0, 80) : "(no text: icon, image or empty area)";
        m.set(label, (m.get(label) ?? 0) + Number(count));
        elsByKey.set(k, m);
      }
      for (const [key, row] of curAgg) {
        const before = prevAgg.get(key);
        const prevUsers = before?.users.size ?? 0;
        const q = `SELECT timestamp, event, properties.$pathname, properties.$el_text, properties.$session_id, distinct_id FROM events WHERE event = ${sqlStr(row.event)} AND timestamp >= toDateTime('${from}') AND timestamp < toDateTime('${to}') AND ${filt} ORDER BY timestamp DESC LIMIT 200`;
        const elements = [...(elsByKey.get(key) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
        yield {
          id: `posthog:friction:${key}`,
          pluginId: "posthog",
          type: "rage_click",
          title: `${FRICTION_LABEL[row.event] ?? row.event} on ${row.route}`,
          firstSeen: row.first,
          lastSeen: row.last,
          count: row.count,
          usersAffected: row.users.size,
          url: insightLink(ctx, q.replace(`event = ${sqlStr(row.event)}`, `event = ${sqlStr(row.event)} AND properties.$pathname LIKE ${sqlStr(row.route.replace(/:id/g, "%"))}`)),
          keys: {
            route: row.route,
            event: row.event,
            users: [...row.users],
            sessions: [...row.sessions].slice(0, 12),
          },
          excerpt: {
            event: row.event,
            route: row.route,
            occurrences: row.count,
            users: row.users.size,
            previousWindowUsers: prevUsers,
            previousWindowOccurrences: before?.count ?? 0,
            previousWindow: `${prevFrom} to ${from}`,
            eventFirstCapturedInProject: trackedSince.get(row.event) ?? "unknown (more than 180 days ago or never)",
            clickedElements: elements.map(([el, n]) => `${n}x "${el}"`),
          },
        };
      }

      // 2. Exceptions grouped by type + message.
      const ex = await hogql(
        ctx,
        `SELECT properties.$exception_type, substring(toString(properties.$exception_message), 1, 200), properties.$pathname, count(), groupUniqArray(500)(distinct_id), groupUniqArray(20)(properties.$session_id), min(timestamp), max(timestamp)
FROM events WHERE event = '$exception' AND timestamp >= toDateTime('${from}') AND timestamp < toDateTime('${to}') AND ${filt}
GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 200`,
      );
      for (const r of ex.results) {
        const [type, msg, path, count, users, sessions, first, last] = r as [string, string, string, number, string[], string[], string, string];
        const route = normalizeRoute(path);
        yield {
          id: `posthog:exception:${type}|${msg}|${route}`,
          pluginId: "posthog",
          type: "error_group",
          title: `${type ?? "Error"}: ${(msg ?? "").slice(0, 80)} on ${route}`,
          firstSeen: first,
          lastSeen: last,
          count: Number(count),
          usersAffected: users.length,
          url: `${base(ctx)}/project/${projectId(ctx)}/error_tracking`,
          keys: { route, fingerprint: `${type}|${msg}`, users, sessions: sessions.filter(Boolean).slice(0, 12) },
          excerpt: { type, message: msg, route, occurrences: Number(count), users: users.length },
        };
      }

      // 3. Slow pages: p75 LCP per route (Google's "poor" threshold is 4 s).
      const lcp = await hogql(
        ctx,
        `SELECT properties.$pathname, quantile(0.75)(toFloat(properties.$web_vitals_LCP_value)), count(), groupUniqArray(500)(distinct_id), groupUniqArray(20)(properties.$session_id), min(timestamp), max(timestamp)
FROM events WHERE event = '$web_vitals' AND properties.$web_vitals_LCP_value IS NOT NULL AND timestamp >= toDateTime('${from}') AND timestamp < toDateTime('${to}') AND ${filt}
GROUP BY 1 LIMIT 2000`,
      );
      const lcpPrev = await hogql(
        ctx,
        `SELECT properties.$pathname, quantile(0.75)(toFloat(properties.$web_vitals_LCP_value)), count(), uniq(distinct_id)
FROM events WHERE event = '$web_vitals' AND properties.$web_vitals_LCP_value IS NOT NULL AND timestamp >= toDateTime('${prevFrom}') AND timestamp < toDateTime('${from}') AND ${filt}
GROUP BY 1 LIMIT 2000`,
      );
      const prevLcp = new Map<string, { p75: number; n: number; u: number }>();
      for (const r of lcpPrev.results) {
        const route = normalizeRoute(r[0] as string);
        const e = prevLcp.get(route) ?? { p75: 0, n: 0, u: 0 };
        e.p75 = Math.max(e.p75, Number(r[1]));
        e.n += Number(r[2]);
        e.u += Number(r[3]);
        prevLcp.set(route, e);
      }
      const lcpByRoute = new Map<string, { vals: number[]; n: number; users: Set<string>; sessions: Set<string>; first: string; last: string }>();
      for (const r of lcp.results) {
        const [path, p75, n, users, sessions, first, last] = r as [string, number, number, string[], string[], string, string];
        const route = normalizeRoute(path);
        const e = lcpByRoute.get(route) ?? { vals: [], n: 0, users: new Set(), sessions: new Set(), first, last };
        e.vals.push(Number(p75));
        e.n += Number(n);
        users.forEach((u) => e.users.add(u));
        sessions.filter(Boolean).forEach((s) => e.sessions.add(s));
        if (first < e.first) e.first = first;
        if (last > e.last) e.last = last;
        lcpByRoute.set(route, e);
      }
      for (const [route, e] of lcpByRoute) {
        const p75 = Math.max(...e.vals);
        if (e.n < 5 || p75 < 4000) continue;
        yield {
          id: `posthog:lcp:${route}`,
          pluginId: "posthog",
          type: "performance_regression",
          title: `Slow page load on ${route} (p75 LCP ${(p75 / 1000).toFixed(1)} s)`,
          firstSeen: e.first,
          lastSeen: e.last,
          count: e.n,
          usersAffected: e.users.size,
          url: insightLink(ctx, `SELECT timestamp, properties.$pathname, properties.$web_vitals_LCP_value, distinct_id FROM events WHERE event = '$web_vitals' AND properties.$pathname LIKE ${sqlStr(route.replace(/:id/g, "%"))} AND timestamp >= toDateTime('${from}') ORDER BY timestamp DESC LIMIT 200`),
          keys: { route, users: [...e.users], sessions: [...e.sessions].slice(0, 12) },
          excerpt: {
            route,
            p75LcpMs: Math.round(p75),
            samples: e.n,
            users: e.users.size,
            previousWindowP75LcpMs: prevLcp.get(route) ? Math.round(prevLcp.get(route)!.p75) : "no samples",
            previousWindowSamples: prevLcp.get(route)?.n ?? 0,
            previousWindowUsers: prevLcp.get(route)?.u ?? 0,
            threshold: "Google rates LCP above 4000 ms as poor",
            webVitalsFirstCapturedInProject: trackedSince.get("$web_vitals") ?? "unknown",
          },
        };
      }

      // 4. Recordings that logged console errors.
      const recs = await getJson<{ results: { id: string; distinct_id: string; start_url: string; console_error_count: number; start_time: string; end_time: string }[] }>(
        ctx,
        `/api/projects/${projectId(ctx)}/session_recordings/?limit=200&date_from=${encodeURIComponent(window.from)}&date_to=${encodeURIComponent(window.to)}`,
      );
      const byRoute = new Map<string, typeof recs.results>();
      for (const r of recs.results.filter((r) => r.console_error_count > 0)) {
        let route = "(unknown page)";
        try {
          route = normalizeRoute(new URL(r.start_url).pathname);
        } catch {
          /* keep unknown */
        }
        byRoute.set(route, [...(byRoute.get(route) ?? []), r]);
      }
      for (const [route, rs] of byRoute) {
        const users = [...new Set(rs.map((r) => r.distinct_id))];
        yield {
          id: `posthog:console:${route}`,
          pluginId: "posthog",
          type: "session_recording",
          title: `Recordings with console errors starting on ${route}`,
          firstSeen: rs.map((r) => r.start_time).sort()[0]!,
          lastSeen: rs.map((r) => r.end_time).sort().at(-1)!,
          count: rs.reduce((a, r) => a + r.console_error_count, 0),
          usersAffected: users.length,
          url: replayLink(ctx, rs[0]!.id),
          keys: { route, users, sessions: rs.map((r) => r.id).slice(0, 12) },
          excerpt: { route, recordings: rs.length, consoleErrors: rs.reduce((a, r) => a + r.console_error_count, 0) },
        };
      }
      ctx.log("info", `collected; recordings scanned: ${recs.results.length}`);
    },

    /** Text timelines of the sample sessions behind a signal: what the user did right before and after. */
    async expand(ctx: Ctx, sessionIdsCsv: string) {
      const ids = sessionIdsCsv.split(",").filter(Boolean).slice(0, 6);
      if (!ids.length) return { sessions: [] };
      const r = await hogql(
        ctx,
        `SELECT properties.$session_id, timestamp, event, properties.$pathname, substring(toString(properties.$el_text), 1, 90), distinct_id, substring(toString(properties.$exception_message), 1, 160), properties.$event_type, substring(splitByChar(':', splitByChar(';', toString(elements_chain))[1])[1], 1, 40)
FROM events WHERE properties.$session_id IN (${ids.map(sqlStr).join(",")}) AND event NOT IN ('$web_vitals', '$feature_flag_called', '$set', '$opt_in')
ORDER BY timestamp ASC LIMIT 1200`,
      );
      let recorded = new Set<string>();
      try {
        const q = encodeURIComponent(JSON.stringify(ids));
        const rr = await getJson<{ results: { id: string }[] }>(ctx, `/api/projects/${projectId(ctx)}/session_recordings/?session_ids=${q}&limit=50`);
        recorded = new Set(rr.results.map((x) => x.id));
      } catch {
        /* no recordings info: links fall back to the person's event list */
      }
      const sessions = ids.map((id) => {
        const rows = r.results.filter((x) => x[0] === id);
        return {
          sessionId: id,
          distinctId: (rows[0]?.[5] as string) ?? "",
          hasRecording: recorded.has(id),
          url: recorded.has(id) ? replayLink(ctx, id) : personLink(ctx, String(rows[0]?.[5] ?? "")),
          events: rows.map((x) => ({
            t: String(x[1]),
            event: String(x[2]),
            path: (x[3] as string) ?? "",
            el: (x[4] as string) || "",
            err: (x[6] as string) || "",
            action: [x[7], String(x[8] ?? "").replace(/\..*$/, "")].filter(Boolean).join(" "),
          })),
        };
      });
      return { sessions };
    },
  },
});
