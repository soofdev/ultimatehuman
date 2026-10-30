import { z } from "zod";

/**
 * ONE schema-validated config file (JSON5, default ~/.ultimatehuman/config.json5).
 * Secrets are never stored inline: any credential value must be a `${ENV_VAR}` ref
 * or a secret-ref object. The dashboard config form is generated from
 * `configJsonSchema`, so every field here needs a `.describe()`.
 */

const ENV_REF = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

export const SecretRef = z
  .union([
    z.string().regex(ENV_REF, "secrets must be ${ENV_VAR} references, never inline values"),
    z.object({ source: z.literal("env"), id: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }),
    z.object({ source: z.literal("file"), path: z.string().describe("Path to a 0600 file holding only the secret") }),
  ])
  .describe("Secret reference. Inline secret values are rejected.");

const AuthSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string(),
    kind: z.literal("claude_login").describe("Reuse the Claude Code login already on this machine"),
  }),
  z.object({
    id: z.string(),
    kind: z.literal("claude_oauth_token").describe("Token from `claude setup-token`"),
    token: SecretRef,
  }),
  z.object({
    id: z.string(),
    kind: z.literal("anthropic_api_key"),
    apiKey: SecretRef,
    dailyCapUsd: z.number().positive().describe("Hard daily spend cap for this key. Required."),
  }),
]);

const PluginInstanceSchema = z.object({
  enabled: z.boolean().default(true),
  credentials: z.record(z.string(), z.union([SecretRef, z.string()])).default({})
    .describe("Secret fields must be refs; non-secret fields (host, org slug) may be plain."),
  options: z.record(z.string(), z.unknown()).default({}),
});

const TelegramNotifierSchema = PluginInstanceSchema.extend({
  enabled: z.boolean().default(false).describe("Off by default: nothing is sent until you turn it on"),
  credentials: z.object({
    botToken: SecretRef.describe("From BotFather. A ${ENV_VAR} ref, never the token itself"),
    chatId: z.union([SecretRef, z.string().regex(/^-?\d+$/, "a numeric chat id")]),
  }),
});

const RepoSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]+$/, "letters, digits, dot, dash, underscore").describe("Short name shown as the repo badge on tickets"),
  path: z.string().describe("Absolute path of the local checkout"),
  testUrl: z.url().optional().describe("Staging/test URL for this repo's product, if any"),
  notes: z.string().optional().describe("Free-form notes the agents read about this repo"),
});
export type RepoConfig = z.infer<typeof RepoSchema>;

/**
 * Old shape -> new shape, applied to the raw object before validation:
 * radar.repo.path becomes repos[0] when no repos list exists yet. Idempotent.
 */
export function migrateConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const c = raw as Record<string, any>;
  const legacy = c.radar?.repo?.path;
  if (typeof legacy === "string" && legacy && !(Array.isArray(c.repos) && c.repos.length)) {
    const name = legacy.replace(/\/+$/, "").split("/").pop()?.replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
    const { repo: _drop, ...radar } = c.radar;
    return { ...c, radar, repos: [{ name, path: legacy }] };
  }
  return raw;
}

/** Models the Config page offers. Any other id is accepted from the file (the claude CLI decides). */
export const MODEL_CHOICES = [
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "advised, default" },
  { id: "claude-fable-5-1", label: "Fable 5.1", note: "" },
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", note: "" },
] as const;
export const DEFAULT_MODEL = "claude-opus-5-5";

/** One model per leg type. `used` = a leg this build runs today; the others are reserved for the fix loop. */
export const MODEL_STAGES = [
  { id: "radar", label: "Radar (root cause)", used: true },
  { id: "review", label: "Adversarial review", used: true },
  { id: "retrospective", label: "Retrospective (teach proposals)", used: true },
  { id: "intake", label: "Intake", used: false },
  { id: "bundle", label: "Bundle", used: false },
  { id: "fix", label: "Fix", used: false },
  { id: "exam", label: "Exam (hostile check)", used: false },
  { id: "chat", label: "Setup chat", used: true },
] as const;
export type ModelStage = (typeof MODEL_STAGES)[number]["id"];

const modelId = z.string().regex(/^[A-Za-z0-9._\[\]-]+$/, "a model id like claude-opus-5-5").default(DEFAULT_MODEL);
const ModelsSchema = z
  .object(Object.fromEntries(MODEL_STAGES.map((st) => [st.id, modelId.describe(`Model for the ${st.label} leg${st.used ? "" : " (not run by this build yet)"}`)])) as Record<ModelStage, typeof modelId>)
  .prefault({});

/**
 * Optional behaviour, one flag each (the reference pipeline's contract): every flag
 * defaults OFF, and off means behaviour identical to a build without the feature.
 * Flags marked reserved are parsed and shown in the setup grade but change nothing yet.
 */
const FeaturesSchema = z
  .object({
    validationGate: z.boolean().default(false)
      .describe("On: new findings wait in the cockpit's Awaiting validation stage until you promote them. Off: they go straight to Needs decision."),
    fixLoop: z.boolean().default(false).describe("Reserved: fix legs that open PRs proven in a browser. No effect in this build."),
    ledger: z.boolean().default(false).describe("Reserved: per-leg spend/usage ledger. No effect in this build."),
  })
  .prefault({});
export type Features = z.infer<typeof FeaturesSchema>;

/** v2-ready: test environments the (future) QA executor may enter. Parsed and validated in v1, unused. */
const EnvironmentSchema = z.object({
  name: z.string(),
  url: z.url().describe("Staging/test base URL. Production URLs are refused."),
  deployCheck: z
    .object({
      kind: z.enum(["version_endpoint", "header"]),
      target: z.string().describe("Path like /api/version, or header name like x-commit-sha"),
      expect: z.enum(["matches_pr_head", "any"]).default("matches_pr_head"),
    })
    .optional(),
  accounts: z
    .array(
      z.object({
        role: z.string().describe("e.g. admin, member, end_user"),
        username: z.union([SecretRef, z.string()]).optional(),
        password: SecretRef.optional(),
        signupPlaybook: z.string().optional().describe("Playbook file used to create a fresh account instead"),
      }),
    )
    .default([]),
  boundaries: z
    .object({
      neverHosts: z.array(z.string()).default([]).describe("Hosts the agent must never load (production)"),
      noOutboundEmail: z.boolean().default(true),
      paymentsTestModeOnly: z.boolean().default(true),
      extraRules: z.array(z.string()).default([]),
    })
    .prefault({}),
  playbooksDir: z.string().default("playbooks").describe("Freeform markdown playbooks QA agents read"),
});

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1).default(1),
    server: z
      .object({
        host: z.string().default("127.0.0.1").describe("Bind address. Loopback by default."),
        port: z.number().int().default(4747),
        allowRemote: z.boolean().default(false).describe("Required to bind a non-loopback host"),
      })
      .prefault({}),
    auth: z
      .object({
        sources: z.array(AuthSourceSchema).min(1),
        order: z.array(z.string()).optional().describe("Source ids in preference order; defaults to listed order"),
        switchOnExhaustion: z.boolean().default(true).describe("Fall through to the next source when one is exhausted"),
      }),
    governor: z
      .object({
        humanReservePct: z.number().min(0).max(90).default(30)
          .describe("Never consume the last N% of a shared subscription window"),
        maxConcurrentAgents: z.number().int().min(1).max(4).default(1),
        onLimit: z.enum(["park_until_reset", "fail_run"]).default("park_until_reset"),
        staleAfterMin: z.number().int().min(1).default(15)
          .describe("Re-read the shared window before a large step when the last reading is older than this"),
      })
      .prefault({}),
    radar: z
      .object({
        schedule: z.string().default("0 7 * * *").describe("Cron expression, local time"),
        lookbackHours: z.number().int().min(1).max(24 * 14).default(24),
        firstPassLookbackHours: z.number().int().min(1).max(24 * 14).default(168)
          .describe("The onboarding pass looks further back so a new install has enough data to judge on day one"),
        minUsersAffected: z.number().int().min(1).default(2)
          .describe("Precision floor: a finding must touch at least this many users. Seeds instructions/admission.md on first boot; from then on that brief (editable in the cockpit) is the floor in force"),
        maxFindingsPerRun: z.number().int().min(1).max(20).default(5),
        autoFile: z.boolean().default(false).describe("v1 default: a human clicks File to GitHub"),
        retentionDays: z.number().int().min(1).default(30).describe("Run bundles older than this are pruned"),
        repo: z
          .object({
            path: z.string().optional().describe("Deprecated: use the top-level repos list. Migrated on load."),
          })
          .prefault({}),
      })
      .prefault({}),
    features: FeaturesSchema.describe("Optional behaviour. Every flag defaults off; off = behaviour identical."),
    models: ModelsSchema.describe("Model per leg type. Defaults to claude-opus-5-5 everywhere."),
    repos: z.array(RepoSchema).default([])
      .describe("Local checkouts the agents read (and later fix) code in. Each repo keeps its own git/GitHub auth; nothing here is a credential."),
    plugins: z.record(z.string(), PluginInstanceSchema).default({}),
    notifications: z
      .object({
        telegram: TelegramNotifierSchema.optional().describe("Each new finding as a card photo; one quiet line per pass with findings; empty passes send nothing"),
        dashboardUrl: z.url().optional()
          .describe("Base URL used in notification links (e.g. a tailnet or tunnel address). Defaults to the local dashboard."),
      })
      .prefault({}),
    chat: z
      .object({
        telegram: z
          .object({
            enabled: z.boolean().default(false).describe("Off by default. On: the daemon long-polls this bot; the first chat that writes to it is bound and every other chat is ignored"),
            botToken: SecretRef.optional().describe("From BotFather. A ${ENV_VAR} ref, never the token itself. Use a bot of its own: getUpdates allows one poller per bot"),
            apiBase: z.url().default("https://api.telegram.org").describe("Telegram Bot API base URL (point it at a local stub to test)"),
          })
          .prefault({})
          .describe("Setup chat on Telegram: the same conversation as the dashboard Chat page and `ultimatehuman chat`"),
      })
      .prefault({})
      .describe("The setup chat: one conversation, three doors (dashboard, CLI, Telegram)"),
    environments: z.array(EnvironmentSchema).default([]),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export function configJsonSchema(): unknown {
  return z.toJSONSchema(ConfigSchema, { io: "input" });
}
