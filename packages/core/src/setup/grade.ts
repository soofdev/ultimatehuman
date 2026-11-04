import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Config } from "../config/schema";
import { codexBin } from "../runner/codex";
import { providerFor, providerLabel } from "../runner/provider";
import { claudeBin } from "../runner/claude";

/**
 * Setup grade (docs/setup-grade.md): a pure function over the config, the raw file
 * (to tell "decided" from "defaulted") and a few cheap probes. Each tier needs every
 * check of its own tier and of the tiers below it.
 */

export const TIERS = ["bronze", "silver", "gold", "platinum"] as const;
export type Tier = (typeof TIERS)[number];

/** Where `ultimatehuman ci install` writes the workflow inside a repo. */
export const CI_WORKFLOW_PATH = ".github/workflows/ultimatehuman-pr-review.yml";

export interface GradeProbes {
  claudeCli: boolean;
  /** Repo names whose checkout has the CI check workflow. */
  ciInstalled: string[];
  /** Repo names whose configured path is an existing directory. */
  reposPresent: string[];
  /** Source plugins (trackers) configured and enabled. */
  sources: string[];
}

export interface GradeCheck {
  id: string;
  tier: Tier;
  label: string;
  ok: boolean;
  /** What to do to pass it. */
  hint: string;
}

export interface SetupGrade {
  tier: Tier | null;
  next: Tier | null;
  checks: GradeCheck[];
  /** Unmet checks of the next tier: "what unlocks the next tier". */
  unlocks: GradeCheck[];
}

export function gradeSetup(cfg: Config, raw: Record<string, any>, p: GradeProbes): SetupGrade {
  const repos = cfg.repos ?? [];
  const tg = cfg.notifications?.telegram;
  const chatTg = cfg.chat?.telegram;
  const hasKeyCap = cfg.auth.sources.some((s) => s.kind === "anthropic_api_key");
  const checks: GradeCheck[] = [
    { id: "repos", tier: "bronze", label: "At least one repo configured and on disk", ok: repos.length > 0 && repos.every((r) => p.reposPresent.includes(r.name)), hint: repos.length ? `Fix the path of: ${repos.filter((r) => !p.reposPresent.includes(r.name)).map((r) => r.name).join(", ")}` : "Add a repo to `repos` in the config (name + local path)." },
    { id: "pipelines", tier: "bronze", label: "At least one pipeline enabled", ok: (cfg.pipelines ?? []).some((x) => x.enabled), hint: "Add a pipeline from a template in Config > Pipelines (or ask the chat), or enable one." },
    { id: "claude", tier: "bronze", label: `${providerLabel(providerFor(cfg))} CLI found on this machine`, ok: p.claudeCli, hint: "Install and sign in to your selected AI CLI." },
    { id: "sources", tier: "silver", label: "An error tracker or analytics source connected", ok: p.sources.length > 0, hint: "Connect Sentry, PostHog or Datadog with a read-only key (`ultimatehuman init`, or ask the chat what is pending)." },
    { id: "notifications", tier: "silver", label: "Notifications or Telegram chat on", ok: !!tg?.enabled || !!(chatTg?.enabled && chatTg.botToken), hint: "Set notifications.telegram.enabled = true (bot token as a ${ENV_VAR} ref + chat id), or chat.telegram.enabled = true with a botToken ${ENV_VAR} ref (enabled defaults to false)." },
    { id: "guard", tier: "silver", label: "Usage guard on (window reserve or API daily cap)", ok: cfg.governor.humanReservePct > 0 || hasKeyCap, hint: "Set governor.humanReservePct above 0 (default 30)." },
    { id: "fixLoop", tier: "gold", label: "Fix loop enabled", ok: cfg.features.fixLoop, hint: "Turn on features.fixLoop (reserved: the fix loop ships later)." },
    { id: "validationGate", tier: "gold", label: "Validation gate decided (on or off, explicitly)", ok: typeof raw?.features?.validationGate === "boolean" || (Array.isArray(raw?.pipelines) && raw.pipelines.some((x: any) => typeof x?.features?.validationGate === "boolean")), hint: "Choose on or off for the validation gate in Config > Features." },
    { id: "testUrl", tier: "gold", label: "A test URL set on a repo", ok: repos.some((r) => !!r.testUrl), hint: "Add testUrl (staging/test, never production) to a repo." },
    { id: "ci", tier: "platinum", label: "CI check installed in every repo", ok: repos.length > 0 && repos.every((r) => p.ciInstalled.includes(r.name)), hint: "Run `ultimatehuman ci install --repo <path>` in each repo (needs a self-hosted runner)." },
    { id: "failover", tier: "platinum", label: "Auth failover (2+ sources, switch on exhaustion)", ok: cfg.auth.sources.length > 1 && cfg.auth.switchOnExhaustion, hint: "Add a second auth source (e.g. an API key with dailyCapUsd)." },
    { id: "ledger", tier: "platinum", label: "Ledger on", ok: cfg.features.ledger, hint: "Turn on features.ledger (reserved: ships later)." },
  ];
  let tier: Tier | null = null;
  for (const t of TIERS) {
    if (checks.filter((c) => c.tier === t).every((c) => c.ok)) tier = t;
    else break;
  }
  const next = tier === null ? "bronze" : TIERS[TIERS.indexOf(tier) + 1] ?? null;
  return { tier, next, checks, unlocks: next ? checks.filter((c) => c.tier === next && !c.ok) : [] };
}

/** The cheap live probes: file-system checks only, no network, no agent. `sourceIds` = plugin ids of kind source. */
export function gradeProbes(cfg: Config, sourceIds: readonly string[] = []): GradeProbes {
  const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
  const bin = providerFor(cfg) === "codex" ? codexBin() : claudeBin();
  const claudeCli = bin.includes("/") ? existsSync(bin) : (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
  const present = (cfg.repos ?? []).filter((r) => isDir(r.path));
  return {
    claudeCli,
    reposPresent: present.map((r) => r.name),
    ciInstalled: present.filter((r) => existsSync(join(r.path, CI_WORKFLOW_PATH))).map((r) => r.name),
    sources: sourceIds.filter((id) => cfg.plugins[id] && cfg.plugins[id]!.enabled !== false),
  };
}
