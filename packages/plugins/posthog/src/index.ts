import { definePlugin, type PluginContext, type Signal, type TimeWindow } from "@ultimatehuman/sdk";

export default definePlugin({
  manifest: {
    id: "posthog",
    displayName: "PostHog",
    kind: "source",
    newcomerScore: 80,
    requiredScopes: ["query:read", "session_recording:read", "error_tracking:read", "project:read"],
    credentials: [
      {
        key: "apiKey",
        label: "Personal API key",
        secret: true,
        preferredEnv: "POSTHOG_PERSONAL_API_KEY",
        alternateEnv: ["POSTHOG_API_KEY"],
        helpUrl: "https://app.posthog.com/settings/user-api-keys",
        helpText: "Create a personal API key with read-only scopes: Query, Session recording, Error tracking, Project.",
        pattern: "^phx_[A-Za-z0-9]+$",
      },
      {
        key: "host",
        label: "PostHog host",
        secret: false,
        preferredEnv: "POSTHOG_HOST",
        helpUrl: "https://posthog.com/docs/api",
        helpText: "https://us.posthog.com, https://eu.posthog.com, or your self-hosted URL.",
        default: "https://us.posthog.com",
      },
    ],
    options: {
      projectId: { type: "string", label: "Project id", helpText: "Auto-detected by the probe when the key sees one project." },
    },
    docsUrl: "https://posthog.com/docs/api",
  },
  // HogQL query is a POST with read semantics; nothing else non-GET is permitted.
  readOnlyPostAllowlist: [/\/api\/projects\/[^/]+\/query\/?$/],
  async probe(_ctx: PluginContext) {
    return { ok: false, summary: "PostHog probe not implemented yet", fix: "Implemented in the plugins leg." };
  },
  source: {
    async *collect(_ctx: PluginContext, _window: TimeWindow): AsyncIterable<Signal> {
      // plugins leg: error tracking groups, funnel step drops, rage clicks, recordings linked to errors.
    },
  },
});
