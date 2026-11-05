import { randomUUID } from "node:crypto";
import type { Store } from "../store/store";

/** Where each value comes from, shown next to its field so nobody has to guess which key goes where. */
export const SOURCE_GUIDES = {
  posthog: {
    title: "Connect PostHog",
    docsUrl: "https://posthog.com/docs/api/personal-api-keys",
    steps: ["Open Personal API keys in your PostHog account.", "Create a key named ultimatehuman with the read scopes below.", "Paste the key here. We’ll check access and let you choose the project."],
    links: [{ label: "Create a personal API key", path: "/settings/user-api-keys" }],
    fields: {
      apiKey: { hint: "Settings → Personal API keys → Create key. It starts with phx_.", link: { label: "Open Personal API keys", path: "/settings/user-api-keys" }, placeholder: "phx_…", scopes: true },
    },
  },
  datadog: {
    title: "Connect Datadog",
    docsUrl: "https://docs.datadoghq.com/account_management/api-app-keys/",
    steps: ["Copy or create an organization API key.", "Create an Application key with the read scopes below.", "Paste both keys here to check access to your logs."],
    links: [{ label: "API keys", path: "/organization-settings/api-keys" }, { label: "Application keys", path: "/organization-settings/application-keys" }],
    fields: {
      site: { hint: "Match your Datadog address: app.datadoghq.eu → datadoghq.eu. If it is wrong, we find the right one." },
      apiKey: { hint: "Organization Settings → API Keys → New Key, then copy the value it shows: 32 letters and numbers. Not the Key ID.", link: { label: "Open API keys", path: "/organization-settings/api-keys" }, placeholder: "32 letters and numbers" },
      appKey: { hint: "Organization Settings → Application Keys → New Key. Copy it right away: Datadog shows it once.", link: { label: "Open Application keys", path: "/organization-settings/application-keys" }, placeholder: "ddapp_…", scopes: true },
    },
  },
} as const;

export type SourceId = keyof typeof SOURCE_GUIDES;
export interface ConnectionRequest {
  id: string;
  source: SourceId;
  project?: string;
  status: "pending" | "connected";
  createdAt: string;
  completedAt?: string;
  /** The last submission was saved but its access check failed; the chat explains why. */
  lastAttempt?: { at: string; verified: boolean };
}

/** Only public connection intent is stored here. Credentials use the existing probe/env-file route. */
export class ConnectionRequests {
  constructor(private store: Store, private emit: (event: unknown) => void) {}
  list(): ConnectionRequest[] { return this.store.getKv<ConnectionRequest[]>("chat.connections") ?? []; }
  request(source: unknown, project?: unknown): ConnectionRequest {
    if (source !== "posthog" && source !== "datadog") throw new Error("Choose PostHog or Datadog.");
    const group = typeof project === "string" && project ? project.slice(0, 100) : undefined;
    const requests = this.list();
    const pending = requests.find((r) => r.source === source && r.project === group && r.status === "pending");
    if (pending) return pending;
    const request: ConnectionRequest = { id: randomUUID(), source, ...(group ? { project: group } : {}), status: "pending", createdAt: new Date().toISOString() };
    this.store.setKv("chat.connections", [...requests.slice(-39), request]);
    this.emit({ type: "chat.connection", request });
    return request;
  }
  complete(id: string): void {
    this.store.setKv("chat.connections", this.list().map((r) => r.id === id ? { ...r, status: "connected", completedAt: new Date().toISOString() } : r));
    this.emit({ type: "chat.connection", id, status: "connected" });
  }
  /** Keeps the request open so its card can reopen the form, and records that keys were tried. */
  attempted(id: string): void {
    this.store.setKv("chat.connections", this.list().map((r) => r.id === id ? { ...r, lastAttempt: { at: new Date().toISOString(), verified: false } } : r));
    this.emit({ type: "chat.connection", id, status: "pending" });
  }
  /** Every open request for a source, once that source is connected by any route. */
  completeSource(source: string): void {
    for (const r of this.list()) if (r.source === source && r.status === "pending") this.complete(r.id);
  }
}

/** Recognizable pasted credentials must not become chat history, drafts, or model input. */
export function redactChatSecrets(text: string): string {
  return text
    .replace(/\bphx_[A-Za-z0-9]{16,}\b/g, "[PostHog key removed — use Connect PostHog]")
    .replace(/\bddapp_[A-Za-z0-9]{16,}\b/g, "[Datadog key hidden]")
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[credential removed]");
}

export interface PastedCredential { source: SourceId; field: string; value: string; label: string }

/**
 * Source keys pasted into a chat message, found before the message is stored or reaches a model.
 * ddapp_ and phx_ keys are unambiguous. Bare hex values are read as Datadog keys only in a Datadog
 * context (an open Datadog request, or the message names Datadog or a key): 32 hex = API key, 40 hex = Application key.
 */
export function findPastedCredentials(text: string, datadogContext: boolean): PastedCredential[] {
  const out: PastedCredential[] = [];
  const add = (source: SourceId, field: string, value: string, label: string) => {
    if (!out.some((c) => c.value === value)) out.push({ source, field, value, label });
  };
  for (const m of text.matchAll(/\bddapp_[A-Za-z0-9]{16,}\b/g)) add("datadog", "appKey", m[0], "Datadog Application key");
  for (const m of text.matchAll(/\bphx_[A-Za-z0-9]{16,}\b/g)) add("posthog", "apiKey", m[0], "PostHog personal API key");
  const datadog = datadogContext || out.some((c) => c.source === "datadog") || /datadog|\bdd[_ ]?api|api[ _-]?key|app(lication)?[ _-]?key/i.test(text);
  if (datadog) {
    for (const m of text.matchAll(/(?<![0-9a-f-])[0-9a-f]{32}(?![0-9a-f-])/gi)) add("datadog", "apiKey", m[0], "Datadog API key");
    if (/datadog|app(lication)?[ _-]?key/i.test(text) || datadogContext)
      for (const m of text.matchAll(/(?<![0-9a-f-])[0-9a-f]{40}(?![0-9a-f-])/gi)) if (!out.some((c) => c.field === "appKey")) add("datadog", "appKey", m[0], "Datadog Application key");
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATADOG_API_KEY = /^[0-9a-f]{32}$/i;
const DATADOG_APP_KEY = /^(ddapp_[A-Za-z0-9]{16,}|[0-9a-f]{40})$/i;

/**
 * Puts Datadog keys in the fields their format says they belong to, before any check:
 * a ddapp_ key in the API key field moves to Application key, two keys in each other's fields swap,
 * and a key ID (UUID) is set aside because it can never authenticate. Returns plain-language notes, never values.
 */
export function sortCredentials(source: string, values: Record<string, string>): { values: Record<string, string>; notes: string[] } {
  if (source !== "datadog") return { values, notes: [] };
  const v = { ...values };
  const notes: string[] = [];
  for (const field of ["apiKey", "appKey"] as const) {
    if (v[field] && UUID.test(v[field]!.trim())) {
      notes.push(`The ${field === "apiKey" ? "API key" : "Application key"} field held a key ID (a UUID), which is only the key's name in Datadog's list. It was set aside.`);
      delete v[field];
    }
  }
  const api = v.apiKey?.trim() ?? "", app = v.appKey?.trim() ?? "";
  if (DATADOG_APP_KEY.test(api) && !DATADOG_APP_KEY.test(app)) {
    if (DATADOG_API_KEY.test(app)) { v.apiKey = app; notes.push("The API key and the Application key were in each other's fields. They were swapped."); }
    else { delete v.apiKey; notes.push("The Application key (ddapp_…) was in the API key field. It was moved to the Application key field."); }
    v.appKey = api;
  } else if (DATADOG_API_KEY.test(app) && !DATADOG_API_KEY.test(api)) {
    v.apiKey = app; delete v.appKey;
    notes.push("The API key was in the Application key field. It was moved to the API key field.");
  }
  return { values: v, notes };
}
export const DATADOG_SITES = ["datadoghq.com", "datadoghq.eu", "us3.datadoghq.com", "us5.datadoghq.com", "ap1.datadoghq.com", "ddog-gov.com"];
const POSTHOG_CLOUD: Record<string, string> = { "https://us.posthog.com": "US Cloud", "https://eu.posthog.com": "EU Cloud" };

/**
 * Plain-language facts about the SHAPE of submitted values, so the chat can say which value is wrong.
 * Formats: Datadog API keys are 32 hex characters; application keys start with ddapp_; key IDs are UUIDs.
 * Never includes a value.
 */
export function credentialFacts(source: string, values: Record<string, string | undefined>): string[] {
  const facts: string[] = [];
  if (source === "datadog") {
    const api = values.apiKey?.trim() ?? "";
    const app = values.appKey?.trim() ?? "";
    const shape = (v: string) => UUID.test(v) ? "a UUID, which is how Datadog shows a key ID. The ID is not the key itself" :
      /^ddapp_/.test(v) ? "an Application key (it starts with ddapp_)" :
        DATADOG_API_KEY.test(v) ? "an API key (32 hexadecimal characters)" : `a ${v.length}-character value`;
    if (api && !DATADOG_API_KEY.test(api)) facts.push(`The API key field contains ${shape(api)}. A Datadog API key is exactly 32 hexadecimal characters (0-9, a-f).`);
    if (app && (UUID.test(app) || DATADOG_API_KEY.test(app))) facts.push(`The Application key field contains ${shape(app)}.`);
  } else if (source === "posthog") {
    const key = values.apiKey?.trim() ?? "";
    if (/^phc_/.test(key)) facts.push("The key starts with phc_: that is the project API key, which can only send events. Reading data needs a personal API key, which starts with phx_.");
    else if (key && !/^phx_/.test(key)) facts.push("PostHog personal API keys start with phx_.");
  }
  return facts;
}

/** Other plausible readings of a submission that failed: another site or region, or the two keys swapped. */
export function credentialVariants(source: string, values: Record<string, string>): { values: Record<string, string>; note: string }[] {
  const out: { values: Record<string, string>; note: string }[] = [];
  if (source === "datadog") {
    const site = values.site || "datadoghq.com";
    // A proxy or local API base fixes the endpoint, so only the swap applies there.
    const others = values.apiBase ? [] : DATADOG_SITES.filter((s) => s !== site);
    if (DATADOG_API_KEY.test(values.apiKey ?? ""))
      for (const s of others) out.push({ values: { ...values, site: s }, note: `These keys belong to the ${s} site, not ${site}. The site was switched to ${s}.` });
    if (values.apiKey && DATADOG_API_KEY.test(values.appKey ?? "")) {
      const swapped = { ...values, apiKey: values.appKey!, appKey: values.apiKey };
      out.push({ values: swapped, note: "The API key and the Application key were in each other's fields. They were swapped." });
      for (const s of others) out.push({ values: { ...swapped, site: s }, note: `The two keys were in each other's fields and belong to the ${s} site. Both were corrected.` });
    }
  } else if (source === "posthog") {
    const host = values.host || "https://us.posthog.com";
    const other = Object.keys(POSTHOG_CLOUD).find((h) => h !== host && POSTHOG_CLOUD[host]);
    if (other) out.push({ values: { ...values, host: other }, note: `This key belongs to PostHog ${POSTHOG_CLOUD[other]}, not ${POSTHOG_CLOUD[host]}. The region was switched.` });
  }
  return out;
}
