import type { Plugin } from "@ultimatehuman/sdk";
import posthog from "@ultimatehuman/plugin-posthog";
import sentry from "@ultimatehuman/plugin-sentry";
import github from "@ultimatehuman/plugin-github";

/** Bundled plugins, ordered by newcomer score so the wizard offers the easiest first. */
export const bundledPlugins: readonly Plugin[] = [github, sentry, posthog].sort(
  (a, b) => b.manifest.newcomerScore - a.manifest.newcomerScore,
);
