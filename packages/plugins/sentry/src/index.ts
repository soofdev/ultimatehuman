import { definePlugin, type PluginContext, type Signal, type TimeWindow } from "@ultimatehuman/sdk";

export default definePlugin({
  manifest: {
    id: "sentry",
    displayName: "Sentry",
    kind: "source",
    newcomerScore: 90,
    requiredScopes: ["org:read", "project:read", "event:read"],
    credentials: [
      {
        key: "authToken",
        label: "Auth token",
        secret: true,
        preferredEnv: "SENTRY_AUTH_TOKEN",
        helpUrl: "https://sentry.io/settings/account/api/auth-tokens/",
        helpText: "Create a token with only org:read, project:read, event:read.",
      },
      {
        key: "org",
        label: "Organization slug",
        secret: false,
        preferredEnv: "SENTRY_ORG",
        helpUrl: "https://docs.sentry.io/api/",
        helpText: "Auto-detected by the probe when the token sees one organization.",
        optional: true,
      },
      {
        key: "baseUrl",
        label: "Sentry URL",
        secret: false,
        preferredEnv: "SENTRY_URL",
        helpUrl: "https://docs.sentry.io/api/",
        helpText: "Leave the default unless you self-host Sentry.",
        default: "https://sentry.io",
      },
    ],
    options: {
      projects: { type: "string[]", label: "Projects", helpText: "Empty means every project the token can read." },
      environment: { type: "string", label: "Environment", default: "production" },
    },
    docsUrl: "https://docs.sentry.io/api/",
  },
  async probe(_ctx: PluginContext) {
    return { ok: false, summary: "Sentry probe not implemented yet", fix: "Implemented in the plugins leg." };
  },
  source: {
    async *collect(_ctx: PluginContext, _window: TimeWindow): AsyncIterable<Signal> {
      // plugins leg: unresolved issues in window, regressions, release health, latest event stack per issue.
    },
  },
});
