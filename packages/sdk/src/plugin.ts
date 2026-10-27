/**
 * Plugin contract. One manifest drives three surfaces:
 *   - the CLI wizard (`ultimatehuman init`)
 *   - the dashboard credential form
 *   - `ultimatehuman doctor` repair checks
 * A plugin never receives write-capable credentials: `requiredScopes` lists the
 * minimum read scopes and `doctor` flags any token that is broader than needed
 * whenever the provider lets us introspect it.
 */

import type { Finding } from "./finding";

export type PluginKind = "source" | "output";

export interface CredentialField {
  /** Key inside `plugins.<id>.credentials` in the config file. */
  key: string;
  label: string;
  /** Secrets are only ever stored as `${ENV_VAR}` refs, never inline. */
  secret: boolean;
  /** Env var the wizard auto-detects and the config ref defaults to. */
  preferredEnv: string;
  /** Other env names commonly used for the same value (detected, then aliased). */
  alternateEnv?: readonly string[];
  /** Deep link to the exact provider page where the user creates this value. */
  helpUrl: string;
  /** One line shown under the field: which scopes to tick, which project to pick. */
  helpText: string;
  /** Default for non-secret fields (e.g. API host). */
  default?: string;
  /** Optional regex used for instant client-side shape checks before the live probe. */
  pattern?: string;
  optional?: boolean;
}

export interface PluginManifest {
  id: string;
  displayName: string;
  kind: PluginKind;
  /** 0-100. How easy setup is for a newcomer; the wizard offers higher scores first. */
  newcomerScore: number;
  /** Minimum provider-side scopes. Shown in the wizard and checked by doctor. */
  requiredScopes: readonly string[];
  credentials: readonly CredentialField[];
  /** Non-credential, schema-described options (project ids, lookback window, filters). */
  options?: Readonly<Record<string, OptionField>>;
  docsUrl: string;
}

export type OptionField =
  | { type: "string"; label: string; default?: string; helpText?: string }
  | { type: "number"; label: string; default?: number; min?: number; max?: number; helpText?: string }
  | { type: "boolean"; label: string; default?: boolean; helpText?: string }
  | { type: "string[]"; label: string; default?: readonly string[]; helpText?: string };

/** Resolved values handed to a plugin at runtime. Secrets already dereferenced in memory only. */
export interface PluginContext {
  credentials: Readonly<Record<string, string>>;
  options: Readonly<Record<string, unknown>>;
  /** Read-only HTTP: the engine's fetch wrapper rejects non-GET methods for source plugins
   *  unless the endpoint is in the plugin's `readOnlyPostAllowlist` (e.g. query APIs). */
  http: ReadOnlyHttp;
  log: (level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown) => void;
  signal: AbortSignal;
}

export interface ReadOnlyHttp {
  get(url: string, init?: { headers?: Record<string, string> }): Promise<HttpResponse>;
  /** Only for read-semantics query endpoints declared in the plugin's allowlist. */
  query(url: string, body: unknown, init?: { headers?: Record<string, string> }): Promise<HttpResponse>;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
}

/** Live validation probe: proves the credential works AND shows the user something real. */
export interface ProbeResult {
  ok: boolean;
  /** Human sentence, e.g. "Found 37 unresolved issues in project web-app". */
  summary: string;
  /** Machine-readable details (counts, detected project ids) used to pre-fill options. */
  detected?: Readonly<Record<string, unknown>>;
  /** On failure: what to do next, phrased as an instruction. */
  fix?: string;
  /** Set when the token is broader than `requiredScopes` (warning, not failure). */
  overScoped?: readonly string[];
}

export interface TimeWindow {
  from: string; // ISO-8601
  to: string;
}

/** A normalized raw observation pulled from a source (error group, funnel drop, event spike...). */
export interface Signal {
  id: string; // stable: `${pluginId}:${nativeId}`
  pluginId: string;
  type: SignalType;
  title: string;
  firstSeen: string;
  lastSeen: string;
  /** Occurrence count inside the window. */
  count: number;
  /** Distinct users affected inside the window, if the source knows it. */
  usersAffected?: number;
  /** Deep link back to the source UI. Every finding cites these. */
  url: string;
  /** Correlation keys: release, route, user ids (hashed), error fingerprint, feature flag. */
  keys: Readonly<Record<string, string | readonly string[]>>;
  /** Small, redacted payload for the root-cause step. Never full user records. */
  excerpt?: unknown;
}

export type SignalType =
  | "error_group"
  | "performance_regression"
  | "funnel_drop"
  | "event_anomaly"
  | "rage_click"
  | "session_recording"
  | "log_pattern";

export interface SourceAdapter {
  /** Collect signals for one radar window. Must be idempotent and read-only. */
  collect(ctx: PluginContext, window: TimeWindow): AsyncIterable<Signal>;
  /** Fetch deeper detail for one signal during root-causing (stack trace, recording, events). */
  expand?(ctx: PluginContext, signalId: string): Promise<unknown>;
}

/** Output plugins file issues. In v1 the only output is GitHub issues. */
export interface OutputAdapter {
  /** Open issues the radar may be duplicating, for dedupe. */
  listCandidates(ctx: PluginContext, query: { labels?: readonly string[]; since?: string }): Promise<ExistingIssue[]>;
  /** File one finding. Called only on an explicit human click or `autoFile: true`. */
  file(ctx: PluginContext, finding: Finding): Promise<FiledIssue>;
  /** Add new evidence to an issue the radar already filed (recurrence). */
  comment?(ctx: PluginContext, issueRef: string, body: string): Promise<void>;
}

export interface ExistingIssue {
  ref: string; // e.g. "owner/repo#123"
  title: string;
  body: string;
  state: "open" | "closed";
  url: string;
  labels: readonly string[];
  updatedAt: string;
}

export interface FiledIssue {
  ref: string;
  url: string;
}

interface PluginBase {
  manifest: PluginManifest;
  probe(ctx: PluginContext): Promise<ProbeResult>;
  /** POST endpoints with read semantics (e.g. HogQL query). Everything else non-GET is refused. */
  readOnlyPostAllowlist?: readonly RegExp[];
}

export interface SourcePlugin extends PluginBase {
  manifest: PluginManifest & { kind: "source" };
  source: SourceAdapter;
}

export interface OutputPlugin extends PluginBase {
  manifest: PluginManifest & { kind: "output" };
  output: OutputAdapter;
}

export type Plugin = SourcePlugin | OutputPlugin;
