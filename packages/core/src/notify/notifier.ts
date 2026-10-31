import type { Finding, NotifyContext, NotifyEvent, NotifyPlugin, Plugin } from "@ultimatehuman/sdk";
import type { Config } from "../config/schema";
import { resolveSecretRefs, type SecretRefValue } from "../config/load";
import { readOnlyHttp, outboundHttp, notifyHosts } from "../plugins/http";
import { renderFindingCard } from "./card-png";

export interface NotifierDeps {
  plugins: readonly Plugin[];
  getConfig: () => Config;
  configPath: string;
  log: (msg: string) => void;
}

/** Engine events the notifier listens to (a subset of what the daemon broadcasts). */
type EngineEvent = { type: string; finding?: Finding; run?: { id: string; phase: string; findings: number; dropped?: unknown[]; error?: string; emptyReason?: string } };

/**
 * Turns engine events into notifications: one message per event.
 * - finding.new: the finding's dashboard card as a photo, with a 2-line caption and a link.
 * - a pass that ends with findings (or fails): one quiet text line.
 * - a pass that ends with no findings: nothing at all. An honest empty day is not news.
 * Sends go one at a time, in event order, and a failed send is logged, never retried into a flood.
 */
export class Notifier {
  private queue: Promise<void> = Promise.resolve();
  private settled = new Set<string>();

  constructor(private readonly d: NotifierDeps) {}

  private enabled(): { plugin: NotifyPlugin; inst: NonNullable<Config["notifications"]["telegram"]> }[] {
    const cfg = this.d.getConfig();
    const out = [];
    for (const p of this.d.plugins) {
      if (p.manifest.kind !== "notify") continue;
      const inst = (cfg.notifications as Record<string, any>)[p.manifest.id];
      if (inst?.enabled) out.push({ plugin: p as NotifyPlugin, inst });
    }
    return out;
  }

  /** Base for links and for the card page the headless browser loads. */
  private localBase(): string {
    const s = this.d.getConfig().server;
    return `http://${s.host.includes(":") ? `[${s.host}]` : s.host}:${s.port}`;
  }

  private linkBase(): string {
    return (this.d.getConfig().notifications.dashboardUrl ?? this.localBase()).replace(/\/$/, "");
  }

  handle(ev: EngineEvent): void {
    if (ev.type === "finding.new" && ev.finding) return this.onFinding(ev.finding);
    if (ev.type === "run.phase" && ev.run && (ev.run.phase === "done" || ev.run.phase === "failed")) return this.onRunEnd(ev.run);
  }

  private onFinding(f: Finding): void {
    const targets = this.enabled().filter((t) => t.inst.options?.findings !== false);
    if (!targets.length) return;
    this.enqueue(async () => {
      let card: Uint8Array | undefined;
      try {
        card = await renderFindingCard(f, this.localBase());
      } catch (e) {
        this.d.log(`notify: card for ${f.id} not rendered (${(e as Error).message}); sending text instead`);
      }
      const url = `${this.linkBase()}/administration/claims?finding=${encodeURIComponent(f.id)}`;
      for (const t of targets) await this.send(t, { type: "finding.new", finding: f, url, ...(card ? { card } : {}) }, `finding ${f.id} sent as ${card ? `card photo (${card.byteLength} bytes)` : "text"}`);
    });
  }

  private onRunEnd(run: NonNullable<EngineEvent["run"]>): void {
    if (this.settled.has(run.id)) return;
    this.settled.add(run.id);
    const targets = this.enabled();
    if (!targets.length) return;
    if (run.phase === "done" && run.findings === 0) {
      this.d.log(`notify: run ${run.id} ended with no findings: honest empty pass, nothing sent${run.emptyReason ? ` (${run.emptyReason})` : ""}`);
      return;
    }
    const dropped = run.dropped?.length ?? 0;
    const line =
      run.phase === "failed"
        ? `${(run as any).pipelineName ?? "Pipeline"} pass failed: ${run.error ?? "unknown error"}`
        : `${(run as any).pipelineName ?? "Pipeline"} pass done: ${run.findings} new finding${run.findings === 1 ? "" : "s"}${dropped ? `, ${dropped} dropped` : ""}`;
    const url = `${this.linkBase()}/administration/pipeline-live`;
    this.enqueue(async () => {
      for (const t of targets.filter((x) => x.inst.options?.runSummaries !== false)) await this.send(t, { type: "run.summary", line, url }, `run ${run.id} summary sent: "${line}"`);
    });
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch((e) => this.d.log(`notify: ${(e as Error).message}`));
  }

  private async send(t: { plugin: NotifyPlugin; inst: any }, ev: NotifyEvent, done: string): Promise<void> {
    const id = t.plugin.manifest.id;
    try {
      await t.plugin.notify.send(await this.ctx(t.plugin, t.inst), ev);
      this.d.log(`notify ${id}: ${done}`);
    } catch (e) {
      this.d.log(`notify ${id}: send failed: ${(e as Error).message}`);
    }
  }

  async ctx(plugin: NotifyPlugin, inst: { credentials?: Record<string, unknown>; options?: Record<string, unknown> }): Promise<NotifyContext> {
    const credentials: Record<string, string> = {};
    for (const [k, v] of Object.entries(inst.credentials ?? {})) credentials[k] = await resolveSecretRefs(v as SecretRefValue, this.d.configPath);
    const log = (m: string) => this.d.log(`[${plugin.manifest.id}] ${m}`);
    return {
      credentials,
      options: inst.options ?? {},
      http: readOnlyHttp(plugin.manifest.id, [], log),
      send: outboundHttp(plugin.manifest.id, notifyHosts(plugin, inst.options ?? {}), log),
      log: (level, msg) => log(`${level}: ${msg}`),
      signal: new AbortController().signal,
    };
  }
}
