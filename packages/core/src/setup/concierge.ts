import { createHash } from "node:crypto";
import JSON5 from "json5";
import type { Plugin, ProbeResult } from "@ultimatehuman/sdk";
import type { Config, PendingItem } from "../config/schema";
import { resolveSecretRefs, type SecretRefValue } from "../config/load";
import { readOnlyHttp } from "../plugins/http";
import { loadEngineEnv } from "../envfile";
import { gradeSetup, gradeProbes, type SetupGrade } from "./grade";
import { isResolved } from "./pending";
import { mergePatch } from "../chat/chat";
import type { Store } from "../store/store";

/**
 * The pending-ledger watcher (rides the daemon's existing 30 s tick, once a minute):
 * re-reads engine.env, and for each pending item whose env vars appeared (or whose grade
 * check now passes) probes the plugin read-only, applies the item's `activate` patch, drops
 * the item, and announces the new grade in the setup chat (and on Telegram when it is on).
 * A key that fails its probe is remembered by hash, so it is retried only once it changes.
 */

export interface ConciergeDeps {
  store: Store;
  plugins: readonly Plugin[];
  getConfig: () => Config;
  readRawConfig: () => Promise<string>;
  patchConfig: (patch: (raw: Record<string, any>) => void) => Promise<Config>;
  configPath: string;
  /** Posts an assistant message into the chat (all doors). */
  announce: (text: string) => Promise<void>;
  log: (m: string) => void;
}

const tierName = (t: string | null) => (t ? t[0]!.toUpperCase() + t.slice(1) : "not set up");
const sourceIds = (plugins: readonly Plugin[]) => plugins.filter((p) => p.manifest.kind === "source").map((p) => p.manifest.id);

export async function currentGrade(d: Pick<ConciergeDeps, "getConfig" | "readRawConfig" | "plugins">): Promise<SetupGrade> {
  const cfg = d.getConfig();
  return gradeSetup(cfg, JSON5.parse(await d.readRawConfig()) as Record<string, any>, gradeProbes(cfg, sourceIds(d.plugins)));
}

export async function checkPending(d: ConciergeDeps): Promise<void> {
  const changed = loadEngineEnv();
  if (changed.length) d.log(`engine.env: picked up ${changed.map((v) => "$" + v).join(", ")}`);
  const cfg = d.getConfig();
  if (!cfg.pending?.length) return;
  const before = await currentGrade(d);
  const done: { item: PendingItem; probe?: ProbeResult }[] = [];
  for (const item of cfg.pending) {
    if (!isResolved(item, before)) continue;
    const plugin = item.plugin ? d.plugins.find((p) => p.manifest.id === item.plugin) : undefined;
    const inst = (item.activate?.plugins as Record<string, any> | undefined)?.[item.plugin ?? ""];
    if (!plugin || !inst || plugin.manifest.kind !== "source") {
      done.push({ item });
      continue;
    }
    // Probe with the new key before switching the plugin on; a failing key is not retried until it changes.
    const creds: Record<string, string> = {};
    for (const [k, v] of Object.entries(inst.credentials ?? {})) creds[k] = await resolveSecretRefs(v as SecretRefValue, d.configPath).catch(() => "");
    const tried = createHash("sha256").update(JSON.stringify(creds)).digest("hex").slice(0, 16);
    const kv = `pending.tried.${item.id}`;
    if (d.store.getKv<string>(kv) === tried) continue;
    d.store.setKv(kv, tried);
    const ctx = { credentials: creds, options: inst.options ?? {}, http: readOnlyHttp(plugin.manifest.id, plugin.readOnlyPostAllowlist ?? [], d.log), log: () => {}, signal: AbortSignal.timeout(30_000) };
    const probe = await plugin.probe(ctx as any).catch((e) => ({ ok: false, summary: (e as Error).message }) as ProbeResult);
    if (!probe.ok) {
      d.log(`pending ${item.id}: key found but the probe failed: ${probe.summary}`);
      await d.announce(`⚠️ I found the ${plugin.manifest.displayName} key you added, but its read-only check failed: ${probe.summary}.${probe.fix ? ` ${probe.fix}` : ""} It stays pending; replace the key and I will retry within a minute.`);
      continue;
    }
    // Probe-detected options (e.g. a PostHog project id) fill what the wizard would have asked.
    if (probe.detected?.projectId && plugin.manifest.id === "posthog") inst.options = { projectId: String(probe.detected.projectId), excludeTeamMembers: true, ...inst.options };
    done.push({ item, probe });
  }
  if (!done.length) return;
  const ids = new Set(done.map((x) => x.item.id));
  await d.patchConfig((raw) => {
    for (const { item } of done) if (item.activate) mergePatch(raw, structuredClone(item.activate));
    raw.pending = (raw.pending ?? []).filter((p: PendingItem) => !ids.has(p.id));
    if (!raw.pending.length) delete raw.pending;
  });
  const after = await currentGrade(d);
  const left = d.getConfig().pending ?? [];
  const lines = done.map(({ item, probe }) => `✅ ${item.label}: done${probe ? ` · ${probe.summary}` : ""}`);
  const moved = after.tier !== before.tier;
  lines.push(moved ? `🎉 Setup grade: ${tierName(before.tier)} → ${tierName(after.tier)}` : `Setup grade: ${tierName(after.tier)}${after.next ? ` (next: ${tierName(after.next)} — ${after.unlocks.map((u) => u.label.toLowerCase()).join(", ")})` : ""}`);
  lines.push(left.length ? `Still pending: ${left.map((p) => p.label).join(", ")}.` : "Nothing left pending.");
  d.log(`pending resolved: ${[...ids].join(", ")}; grade ${before.tier ?? "none"} -> ${after.tier ?? "none"}`);
  await d.announce(lines.join("\n"));
}
