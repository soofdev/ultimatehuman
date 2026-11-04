import { randomUUID } from "node:crypto";
import type { Store } from "../store/store";

export const SOURCE_GUIDES = {
  posthog: {
    title: "Connect PostHog",
    docsUrl: "https://posthog.com/docs/api/personal-api-keys",
    steps: ["Open Personal API keys in your PostHog account.", "Create a key named ultimatehuman with the read scopes below.", "Paste the key here. We’ll check access and let you choose the project."],
    links: [{ label: "Create a personal API key", path: "/settings/user-api-keys" }],
  },
  datadog: {
    title: "Connect Datadog",
    docsUrl: "https://docs.datadoghq.com/account_management/api-app-keys/",
    steps: ["Copy or create an organization API key.", "Create an Application key with the read scopes below.", "Paste both keys here to check access to your logs."],
    links: [{ label: "API keys", path: "/organization-settings/api-keys" }, { label: "Application keys", path: "/organization-settings/application-keys" }],
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
}

/** Recognizable pasted credentials must not become chat history, drafts, or model input. */
export function redactChatSecrets(text: string): string {
  return text
    .replace(/\bphx_[A-Za-z0-9]{16,}\b/g, "[PostHog key removed — use Connect PostHog]")
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[credential removed]");
}
