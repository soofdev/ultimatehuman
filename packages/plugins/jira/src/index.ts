import { definePlugin, type ExistingIssue, type Finding, type OutputContext, type PluginContext, type TrackerIssue, type TrackerIssueDetail, type TrackerSearchResult } from "@ultimatehuman/sdk";
import { adfToText, findingDoc, plainDoc } from "./adf";

/**
 * Output plugin: files an accepted finding as an issue in ONE Jira Cloud
 * project, through the REST API v3 with an Atlassian API token.
 *
 * Writes it can make: create an issue, and comment on an issue it filed. All
 * POSTs go through the engine's outbound wrapper, pinned to the configured
 * Jira site; reads (probe, duplicate search) go through the read-only wrapper.
 *
 * `options.dryRun` (default true) renders the issue and makes no write at all.
 * Every filed issue carries an `uh-<fingerprint>` label, and filing searches
 * for it first, so accepting the same finding twice never creates two issues.
 */

/** The JQL search endpoint, on the site or through the scoped-token gateway (/ex/jira/<cloudId>/...). */
const SEARCH = /^(\/ex\/jira\/[\w-]+)?\/rest\/api\/3\/search\/jql$/;

const site = (ctx: PluginContext) => String(ctx.credentials.baseUrl ?? "").trim().replace(/\/+$/, "");
/** Where REST calls go: `apiUrl` for scoped tokens (https://api.atlassian.com/ex/jira/<cloudId>), else the site itself. Browse links always use the site. */
const api = (ctx: PluginContext) => String(ctx.credentials.apiUrl ?? "").trim().replace(/\/+$/, "") || site(ctx);
const headers = (ctx: PluginContext): Record<string, string> => ({
  authorization: `Basic ${Buffer.from(`${ctx.credentials.email ?? ""}:${ctx.credentials.apiToken ?? ""}`).toString("base64")}`,
  // The engine's HTTP wrappers set Content-Type for JSON bodies; repeating it here would duplicate the header.
  accept: "application/json",
});
const projectKey = (ctx: PluginContext) => String(ctx.credentials.projectKey ?? "").trim().toUpperCase();
const issueType = (ctx: PluginContext) => String(ctx.options.issueType ?? "Task").trim() || "Task";

/**
 * `options.issueTypeRules`: checked top to bottom, first match wins, `issueType` is the fallback.
 * Every condition a rule sets must match; a rule with no conditions matches everything.
 *   { issueType: "Bug", pipeline: "security-check" }          // pipeline id or template prefix
 *   { issueType: "Bug", severity: ["critical", "high"] }
 *   { issueType: "Story", repo: ["wodworx-flutter-app"] }
 */
export interface IssueTypeRule {
  issueType: string;
  pipeline?: string | string[];
  severity?: string | string[];
  repo?: string | string[];
}
const asList = (v: unknown): string[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => String(x).trim().toLowerCase()).filter(Boolean));
export function issueTypeRules(ctx: PluginContext): IssueTypeRule[] {
  const raw = ctx.options.issueTypeRules;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("plugins.jira.options.issueTypeRules must be a list of rules.");
  return raw.map((r, i) => {
    if (!r || typeof r !== "object" || typeof (r as IssueTypeRule).issueType !== "string" || !(r as IssueTypeRule).issueType.trim()) {
      throw new Error(`plugins.jira.options.issueTypeRules[${i}] needs an issueType.`);
    }
    return r as IssueTypeRule;
  });
}
/** The issue type for one finding: the first matching rule, else the default. */
export function issueTypeFor(ctx: PluginContext, finding: Finding): string {
  const f = finding as Finding & { pipelineId?: string };
  const pipeline = String(f.pipelineId ?? "").toLowerCase();
  for (const rule of issueTypeRules(ctx)) {
    const pipes = asList(rule.pipeline);
    if (pipes.length && !pipes.some((p) => pipeline === p || pipeline.startsWith(`${p}-`))) continue;
    const sevs = asList(rule.severity);
    if (sevs.length && !sevs.includes(String(f.severity).toLowerCase())) continue;
    const repos = asList(rule.repo);
    if (repos.length && !repos.includes(String(f.repo ?? "").toLowerCase())) continue;
    return rule.issueType.trim();
  }
  return issueType(ctx);
}
const configuredLabels = (ctx: PluginContext): string[] => {
  const raw = ctx.options.labels;
  const list = Array.isArray(raw) ? raw.map(String) : ["ultimatehuman"];
  return list.map(toLabel).filter(Boolean);
};
/** Jira labels cannot contain spaces. */
const toLabel = (s: string) => s.trim().replace(/\s+/g, "-");
export const fingerprintLabel = (fp: string) => `uh-${fp.replace(/[^\w-]/g, "").slice(0, 40)}`;
const browse = (ctx: PluginContext, key: string) => `${site(ctx)}/browse/${key}`;
const jqlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Jira error bodies: { errorMessages: [], errors: { field: msg } }. One readable line. */
async function failure(what: string, r: { status: number; text(): Promise<string> }): Promise<Error> {
  const raw = await r.text().catch(() => "");
  let detail = raw.slice(0, 300);
  try {
    const j = JSON.parse(raw) as { errorMessages?: string[]; errors?: Record<string, string> };
    const parts = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)];
    if (parts.length) detail = parts.join("; ");
    detail = detail.replace(/[.\s]+$/, "");
  } catch {
    /* not JSON */
  }
  const hint = r.status === 401 ? " Check the email and API token." : r.status === 403 ? " The account lacks permission in this project." : "";
  return new Error(`Jira ${what} failed (HTTP ${r.status})${detail ? `: ${detail}` : ""}.${hint}`);
}

interface SearchHit {
  key: string;
  fields: { summary?: string; labels?: string[]; updated?: string; status?: { statusCategory?: { key?: string } } };
}

async function search(ctx: PluginContext, jql: string, max = 50): Promise<SearchHit[]> {
  const r = await ctx.http.query(`${api(ctx)}/rest/api/3/search/jql`, { jql, maxResults: max, fields: ["summary", "labels", "updated", "status"] }, { headers: headers(ctx) });
  if (r.status !== 200) throw await failure("search", r);
  return ((await r.json<{ issues?: SearchHit[] }>()).issues ?? []);
}

const toExisting = (ctx: PluginContext, h: SearchHit): ExistingIssue => ({
  ref: h.key,
  title: h.fields.summary ?? h.key,
  body: "",
  state: h.fields.status?.statusCategory?.key === "done" ? "closed" : "open",
  url: browse(ctx, h.key),
  labels: h.fields.labels ?? [],
  updatedAt: h.fields.updated ?? "",
});

/* ── Read-only lookup (chat) ─────────────────────────────────────────── */

const LOOKUP_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "reporter", "labels", "created", "updated"];
const MAX_LOOKUP = 100;

interface FullHit {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    priority?: { name?: string };
    assignee?: { displayName?: string } | null;
    reporter?: { displayName?: string } | null;
    labels?: string[];
    created?: string;
    updated?: string;
    description?: unknown;
    comment?: { total?: number; comments?: { author?: { displayName?: string }; created?: string; body?: unknown }[] };
  };
}

/** Jira's status categories: new / indeterminate / done. */
const category = (k: string | undefined) => (k === "new" ? "todo" : k === "indeterminate" ? "in_progress" : k ?? "unknown");

const toTracker = (ctx: PluginContext, h: FullHit, withDescription: boolean): TrackerIssue => ({
  ref: h.key,
  title: h.fields.summary ?? h.key,
  status: h.fields.status?.name ?? "unknown",
  statusCategory: category(h.fields.status?.statusCategory?.key),
  ...(h.fields.issuetype?.name ? { type: h.fields.issuetype.name } : {}),
  ...(h.fields.priority?.name ? { priority: h.fields.priority.name } : {}),
  assignee: h.fields.assignee?.displayName ?? "Unassigned",
  ...(h.fields.reporter?.displayName ? { reporter: h.fields.reporter.displayName } : {}),
  labels: h.fields.labels ?? [],
  ...(h.fields.created ? { created: h.fields.created } : {}),
  ...(h.fields.updated ? { updated: h.fields.updated } : {}),
  url: browse(ctx, h.key),
  ...(withDescription ? { description: h.fields.description ? adfToText(h.fields.description, 1500) : "" } : {}),
});

/** Issue keys look like MP-123. Anything else is refused before a request is made. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,19}-\d{1,9}$/;

export async function lookupSearch(ctx: PluginContext, q: { query?: string; max?: number; includeDescription?: boolean }): Promise<TrackerSearchResult> {
  if (!ctx.credentials.apiToken) throw new Error("No Jira API token is saved. Run `ultimatehuman key JIRA_API_TOKEN` in a terminal.");
  const query = (q.query ?? "").trim() || `project = ${jqlString(projectKey(ctx))} AND statusCategory != Done ORDER BY updated DESC`;
  if (query.length > 2000) throw new Error("The JQL query is too long (2000 characters at most).");
  const max = Math.min(Math.max(1, Math.floor(Number(q.max) || 25)), MAX_LOOKUP);
  const fields = q.includeDescription ? [...LOOKUP_FIELDS, "description"] : LOOKUP_FIELDS;
  const issues: FullHit[] = [];
  let nextPageToken: string | undefined;
  let more = false;
  do {
    const r = await ctx.http.query(`${api(ctx)}/rest/api/3/search/jql`, { jql: query, maxResults: Math.min(50, max - issues.length), fields, ...(nextPageToken ? { nextPageToken } : {}) }, { headers: headers(ctx) });
    if (r.status !== 200) throw await failure("search", r);
    const page = await r.json<{ issues?: FullHit[]; nextPageToken?: string; isLast?: boolean }>();
    issues.push(...(page.issues ?? []));
    nextPageToken = page.isLast === false || (page.isLast === undefined && page.nextPageToken) ? page.nextPageToken : undefined;
    more = !!nextPageToken;
  } while (nextPageToken && issues.length < max);
  return { query, issues: issues.slice(0, max).map((h) => toTracker(ctx, h, !!q.includeDescription)), more: more || issues.length > max };
}

export async function lookupGet(ctx: PluginContext, ref: string): Promise<TrackerIssueDetail> {
  if (!ctx.credentials.apiToken) throw new Error("No Jira API token is saved. Run `ultimatehuman key JIRA_API_TOKEN` in a terminal.");
  const key = String(ref ?? "").trim().toUpperCase();
  if (!ISSUE_KEY.test(key)) throw new Error(`"${ref}" is not a Jira issue key (expected something like MP-123).`);
  const r = await ctx.http.get(`${api(ctx)}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${[...LOOKUP_FIELDS, "description", "comment"].join(",")}`, { headers: headers(ctx) });
  if (r.status === 404) throw new Error(`${key} was not found, or this Jira account cannot see it.`);
  if (r.status !== 200) throw await failure(`reading ${key}`, r);
  const h = await r.json<FullHit>();
  const all = h.fields.comment?.comments ?? [];
  return {
    ...toTracker(ctx, h, true),
    commentCount: h.fields.comment?.total ?? all.length,
    comments: all.slice(-5).map((c) => ({ ...(c.author?.displayName ? { author: c.author.displayName } : {}), ...(c.created ? { created: c.created } : {}), body: adfToText(c.body, 800) })),
  };
}

export default definePlugin({
  manifest: {
    id: "jira",
    displayName: "Jira",
    kind: "output",
    newcomerScore: 80,
    requiredScopes: ["Browse projects (one project)", "Create issues", "Add comments"],
    credentials: [
      {
        key: "baseUrl",
        label: "Jira site URL",
        secret: false,
        preferredEnv: "JIRA_BASE_URL",
        helpUrl: "https://support.atlassian.com/jira-software-cloud/docs/what-is-a-jira-cloud-site/",
        helpText: "Your Jira Cloud site, e.g. https://your-team.atlassian.net",
        pattern: "^https?://[\\w.-]+(:\\d+)?/?$",
      },
      {
        key: "apiUrl",
        label: "API URL (scoped tokens only)",
        secret: false,
        preferredEnv: "JIRA_API_URL",
        helpUrl: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/",
        helpText: "Only for a token created with scopes: https://api.atlassian.com/ex/jira/<cloudId>. Your cloudId is shown at <site>/_edge/tenant_info. Leave empty for a classic token.",
        pattern: "^https?://[\\w.-]+(:\\d+)?(/ex/jira/[\\w-]+)?/?$",
        optional: true,
      },
      {
        key: "email",
        label: "Atlassian account email",
        secret: false,
        preferredEnv: "JIRA_EMAIL",
        helpUrl: "https://id.atlassian.com/manage-profile/profile-and-visibility",
        helpText: "The email of the account the API token belongs to. Issues are created as this account.",
      },
      {
        key: "apiToken",
        label: "API token",
        secret: true,
        preferredEnv: "JIRA_API_TOKEN",
        alternateEnv: ["ATLASSIAN_API_TOKEN"],
        helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
        helpText: "Prefer a dedicated account that can only browse and create issues in the one project.",
        optional: true,
      },
      {
        key: "projectKey",
        label: "Project key",
        secret: false,
        preferredEnv: "JIRA_PROJECT_KEY",
        helpUrl: "https://support.atlassian.com/jira-software-cloud/docs/what-is-an-issue/",
        helpText: "The prefix of the project's issue keys, e.g. WOD for WOD-123.",
        pattern: "^[A-Za-z][A-Za-z0-9_]{1,19}$",
      },
    ],
    options: {
      issueType: { type: "string", label: "Default issue type", default: "Task", helpText: "Used when no issueTypeRules entry matches. Must exist in the project (e.g. Bug, Task)." },
      labels: { type: "string[]", label: "Labels on filed issues", default: ["ultimatehuman"] },
      dryRun: { type: "boolean", label: "Dry run: preview issues, never create them", default: true },
    },
    docsUrl: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/",
  },
  readOnlyPostAllowlist: [SEARCH],
  sendHosts(credentials) {
    try {
      const urls = [credentials.apiUrl, credentials.baseUrl].map((u) => String(u ?? "").trim()).filter(Boolean);
      return [...new Set(urls.map((u) => new URL(u).host))];
    } catch {
      return [];
    }
  },

  async probe(ctx: PluginContext) {
    const key = projectKey(ctx);
    if (!site(ctx) || !key) return { ok: false, summary: "Jira site URL and project key are required", fix: "Set plugins.jira.credentials.baseUrl and projectKey." };
    if (!ctx.credentials.apiToken) {
      return ctx.options.dryRun !== false
        ? { ok: true, summary: `Dry run: issues for ${key} are rendered and previewed, never created (no API token yet)` }
        : { ok: false, summary: "Live filing needs an API token", fix: "Run `ultimatehuman key JIRA_API_TOKEN`, or keep options.dryRun: true." };
    }
    const me = await ctx.http.get(`${api(ctx)}/rest/api/3/myself`, { headers: headers(ctx) });
    if (me.status !== 200) {
      const e = await failure("sign-in check", me);
      return { ok: false, summary: e.message, fix: "Create a token at https://id.atlassian.com/manage-profile/security/api-tokens and check the email matches its account." };
    }
    const who = (await me.json<{ displayName?: string }>()).displayName ?? "your account";
    const types = await ctx.http.get(`${api(ctx)}/rest/api/3/issue/createmeta/${encodeURIComponent(key)}/issuetypes`, { headers: headers(ctx) });
    if (types.status !== 200) {
      const e = await failure(`project ${key} check`, types);
      return { ok: false, summary: e.message, fix: `Check the project key, and that ${who} can create issues in it.` };
    }
    const body = await types.json<{ issueTypes?: { name: string }[]; values?: { name: string }[] }>();
    const names = (body.issueTypes ?? body.values ?? []).map((t) => t.name);
    const want = issueType(ctx);
    let rules: IssueTypeRule[];
    try {
      rules = issueTypeRules(ctx);
    } catch (e) {
      return { ok: false, summary: (e as Error).message, fix: "Each rule is { issueType, pipeline?, severity?, repo? }." };
    }
    const used = [...new Set([want, ...rules.map((r) => r.issueType.trim())])];
    const missing = names.length ? used.filter((u) => !names.some((n) => n.toLowerCase() === u.toLowerCase())) : [];
    if (missing.length) {
      return { ok: false, summary: `Issue type${missing.length > 1 ? "s" : ""} ${missing.map((m) => `"${m}"`).join(", ")} ${missing.length > 1 ? "do" : "does"} not exist in ${key}`, fix: `Use only: ${names.join(", ")} (in issueType and issueTypeRules).`, detected: { issueTypes: names } };
    }
    const mode = ctx.options.dryRun !== false ? "dry run: issues are previewed, never created" : "live: accepted findings become issues";
    return { ok: true, summary: `Signed in as ${who}; can create ${used.join("/")} issues in ${key}${rules.length ? ` (${rules.length} type rule${rules.length > 1 ? "s" : ""})` : ""} (${mode})`, detected: { issueTypes: names } };
  },

  output: {
    async listCandidates(ctx: OutputContext, q: { labels?: readonly string[]; since?: string }): Promise<ExistingIssue[]> {
      if (!ctx.credentials.apiToken) return [];
      const labels = (q.labels?.length ? q.labels.map(toLabel) : configuredLabels(ctx)).filter(Boolean);
      const clauses = [`project = ${jqlString(projectKey(ctx))}`];
      if (labels.length) clauses.push(`labels in (${labels.map(jqlString).join(", ")})`);
      if (q.since) clauses.push(`updated >= ${jqlString(q.since.slice(0, 10))}`);
      return (await search(ctx, `${clauses.join(" AND ")} ORDER BY updated DESC`)).map((h) => toExisting(ctx, h));
    },

    async file(ctx: OutputContext, finding: Finding) {
      const key = projectKey(ctx);
      if (ctx.options.dryRun !== false) return { ref: `${key}-dry-run`, url: `${site(ctx)}/jira/software/projects/${key}/issues` };
      if (!ctx.send) throw new Error("Live Jira filing is not available in this engine.");
      if (!ctx.credentials.apiToken) throw new Error("No Jira API token. Run `ultimatehuman key JIRA_API_TOKEN`.");

      const fpLabel = fingerprintLabel(finding.dedupe.fingerprint);
      // Idempotence: one Jira issue per problem, even on a double click or a re-accept.
      const existing = await search(ctx, `project = ${jqlString(key)} AND labels = ${jqlString(fpLabel)} ORDER BY created ASC`, 1);
      if (existing[0]) {
        ctx.log("info", `${existing[0].key} already tracks ${fpLabel}; not creating a duplicate`);
        return { ref: existing[0].key, url: browse(ctx, existing[0].key) };
      }

      const labels = [...new Set([...configuredLabels(ctx), fpLabel, toLabel(`severity-${finding.severity}`)])];
      const summary = finding.title.replace(/\s+/g, " ").trim().slice(0, 250) || "ultimatehuman finding";
      const r = await ctx.send.post(
        `${api(ctx)}/rest/api/3/issue`,
        { fields: { project: { key }, issuetype: { name: issueTypeFor(ctx, finding) }, summary, labels, description: findingDoc(finding) } },
        { headers: headers(ctx) },
      );
      if (r.status !== 201 && r.status !== 200) throw await failure("issue creation", r);
      const created = await r.json<{ key: string }>();
      ctx.log("info", `created ${created.key}`);
      return { ref: created.key, url: browse(ctx, created.key) };
    },

    search: lookupSearch,
    get: lookupGet,

    async comment(ctx: OutputContext, issueRef: string, body: string) {
      if (ctx.options.dryRun !== false) return;
      if (!ctx.send) throw new Error("Live Jira filing is not available in this engine.");
      const r = await ctx.send.post(`${api(ctx)}/rest/api/3/issue/${encodeURIComponent(issueRef)}/comment`, { body: plainDoc(body) }, { headers: headers(ctx) });
      if (r.status !== 201 && r.status !== 200) throw await failure(`comment on ${issueRef}`, r);
    },
  },
});
