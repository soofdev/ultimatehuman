import { definePlugin, type ExistingIssue, type Finding, type PluginContext } from "@ultimatehuman/sdk";

/**
 * Output plugin. The only write the whole product performs in v1: creating an
 * issue (and commenting on one it filed) in ONE configured repository, using a
 * fine-grained token scoped to that repo with Issues: read/write and Contents: read.
 */
export default definePlugin({
  manifest: {
    id: "github",
    displayName: "GitHub",
    kind: "output",
    newcomerScore: 95,
    requiredScopes: ["issues:write (single repo)", "contents:read (single repo)", "metadata:read"],
    credentials: [
      {
        key: "token",
        label: "Fine-grained token",
        secret: true,
        preferredEnv: "GITHUB_TOKEN",
        alternateEnv: ["GH_TOKEN"],
        helpUrl: "https://github.com/settings/personal-access-tokens/new",
        helpText: "Repository access: only the one repo. Permissions: Issues read/write, Contents read-only.",
      },
      {
        key: "repo",
        label: "Repository (owner/name)",
        secret: false,
        preferredEnv: "ULTIMATEHUMAN_GITHUB_REPO",
        helpUrl: "https://docs.github.com/en/rest/issues",
        helpText: "Auto-detected from the git remote of the current directory when possible.",
        pattern: "^[\\w.-]+/[\\w.-]+$",
      },
    ],
    options: {
      labels: { type: "string[]", label: "Labels on filed issues", default: ["ultimatehuman"] },
    },
    docsUrl: "https://docs.github.com/en/rest/issues",
  },
  async probe(_ctx: PluginContext) {
    return { ok: false, summary: "GitHub probe not implemented yet", fix: "Implemented in the plugins leg." };
  },
  output: {
    async listCandidates(_ctx: PluginContext, _q: { labels?: readonly string[]; since?: string }): Promise<ExistingIssue[]> {
      return [];
    },
    async file(_ctx: PluginContext, _finding: Finding) {
      throw new Error("GitHub filing not implemented yet");
    },
  },
});
