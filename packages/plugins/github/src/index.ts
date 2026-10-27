import { definePlugin, type ExistingIssue, type Finding, type PluginContext } from "@ultimatehuman/sdk";

/**
 * Output plugin. The only write the whole product performs in v1: creating an
 * issue (and commenting on one it filed) in ONE configured repository, using a
 * fine-grained token scoped to that repo with Issues: read/write and Contents: read.
 *
 * This slice ships the dry-run path only: `options.dryRun` (default true) renders
 * the exact issue and performs no network call at all.
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
        optional: true,
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
      dryRun: { type: "boolean", label: "Dry run: preview issues, never create them", default: true },
    },
    docsUrl: "https://docs.github.com/en/rest/issues",
  },
  async probe(ctx: PluginContext) {
    const repo = ctx.credentials.repo;
    if (ctx.options.dryRun !== false) {
      return { ok: true, summary: `Dry run: issues for ${repo} are rendered and previewed, never created` };
    }
    return { ok: false, summary: "Live filing is not part of this build", fix: "Keep options.dryRun: true." };
  },
  output: {
    async listCandidates(_ctx: PluginContext, _q: { labels?: readonly string[]; since?: string }): Promise<ExistingIssue[]> {
      return []; // dry run: dedupe uses the local store only
    },
    async file(ctx: PluginContext, _finding: Finding) {
      if (ctx.options.dryRun === false) throw new Error("live filing disabled in this build");
      return { ref: `${ctx.credentials.repo}#dry-run`, url: `https://github.com/${ctx.credentials.repo}/issues` };
    },
  },
});
