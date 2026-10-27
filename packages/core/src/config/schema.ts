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
        minUsersAffected: z.number().int().min(1).default(2)
          .describe("Precision floor: a finding must touch at least this many users"),
        maxFindingsPerRun: z.number().int().min(1).max(20).default(5),
        autoFile: z.boolean().default(false).describe("v1 default: a human clicks File to GitHub"),
        retentionDays: z.number().int().min(1).default(30).describe("Run bundles older than this are pruned"),
        repo: z
          .object({
            path: z.string().optional().describe("Local read-only checkout used for code pointers"),
          })
          .prefault({}),
      })
      .prefault({}),
    plugins: z.record(z.string(), PluginInstanceSchema).default({}),
    environments: z.array(EnvironmentSchema).default([]),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export function configJsonSchema(): unknown {
  return z.toJSONSchema(ConfigSchema, { io: "input" });
}
